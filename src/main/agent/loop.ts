import type {
  AgentNoticeCode,
  AgentPermission,
  ChatRequestMessage,
  ChatStreamEvent,
  ToolCall,
  ToolCallResult,
  ToolPermission,
  ToolRisk
} from '@shared/types'
import type { RawToolCall } from '../llama/client'
import { logger, toError } from '../util/logger'
import { enforceBudget, sanitizeToolPairing } from './budget'
import { approvalBroker, configPermissionFor, decidePermission } from './permission'
import { extractTextToolCalls } from './tool-text'
import type { ResolvedTool, ToolCatalogue } from './tools'
import type { OpenAiTool } from '../mcp/registry'

export interface StreamOnceResult {
  /** accumulated assistant text, identical to what the renderer received */
  content: string
  reasoning: string
  toolCalls: RawToolCall[]
  finishReason: string | null
}

export type StreamOnce = (
  messages: ChatRequestMessage[],
  tools: OpenAiTool[],
  onDelta: (delta: { content?: string; reasoning?: string }) => void,
  signal: AbortSignal
) => Promise<StreamOnceResult>

export interface AgentTurnInput {
  streamId: string
  /** the conversation history as it stood before this turn */
  messages: ChatRequestMessage[]
  catalogue: ToolCatalogue
  policy: AgentPermission
  maxIterations: number
  parseTextToolCalls: boolean
  toolPermissions: Record<string, ToolPermission>
}

export interface AgentLoopDeps {
  streamOnce: StreamOnce
  emit: (event: ChatStreamEvent) => void
  /** token budget available to the message list alone */
  budget: number
}

export interface AgentTurnResult {
  /** every message the turn produced, in order */
  appended: ChatRequestMessage[]
  toolCallCount: number
  notices: AgentNoticeCode[]
}

interface PlannedCall {
  call: ToolCall
  tool: ResolvedTool | null
  /** llama-server produced arguments that were not valid JSON */
  malformed: boolean
}

function resolveTool(catalogue: ToolCatalogue, name: string): ResolvedTool | null {
  return catalogue.tools.find((tool) => tool.name === name) ?? null
}

function planNative(raw: RawToolCall, catalogue: ToolCatalogue): PlannedCall {
  const tool = resolveTool(catalogue, raw.name)
  return {
    malformed: raw.invalid,
    tool,
    call: {
      id: raw.id,
      name: raw.name,
      serverId: tool?.serverId ?? null,
      toolName: tool?.toolName ?? raw.name,
      args: raw.args,
      source: 'native'
    }
  }
}

function planText(
  name: string,
  args: Record<string, unknown>,
  index: number,
  iteration: number,
  catalogue: ToolCatalogue
): PlannedCall {
  const tool = resolveTool(catalogue, name)
  return {
    malformed: false,
    tool,
    call: {
      id: `text_${iteration}_${index}`,
      name,
      serverId: tool?.serverId ?? null,
      toolName: tool?.toolName ?? name,
      args,
      source: 'text'
    }
  }
}

/**
 * Runs one agent turn: stream, execute whatever tools the model asked for, feed
 * the results back and repeat until it answers without asking for more.
 *
 * The caller owns the stream lifecycle (start/done/error/aborted); this
 * function only emits the agent-specific events plus the deltas it forwards.
 */
export async function runAgentTurn(
  input: AgentTurnInput,
  deps: AgentLoopDeps,
  signal: AbortSignal
): Promise<AgentTurnResult> {
  const { streamId, catalogue } = input
  const emit = deps.emit
  const appended: ChatRequestMessage[] = []
  const notices: AgentNoticeCode[] = []
  let toolCallCount = 0

  let history = [...input.messages]

  for (let iteration = 0; iteration < input.maxIterations; iteration += 1) {
    if (signal.aborted) break

    const budgeted = enforceBudget(history, deps.budget)
    if (budgeted.elided > 0 || budgeted.dropped > 0) {
      history = budgeted.messages
      if (!notices.includes('CONTEXT_TRIMMED')) {
        notices.push('CONTEXT_TRIMMED')
        emit({ type: 'notice', streamId, code: 'CONTEXT_TRIMMED' })
      }
    }
    if (budgeted.exhausted) {
      notices.push('CONTEXT_EXHAUSTED')
      emit({ type: 'notice', streamId, code: 'CONTEXT_EXHAUSTED' })
      break
    }

    emit({ type: 'iteration', streamId, index: iteration })

    const result = await deps.streamOnce(
      sanitizeToolPairing(history),
      catalogue.openAiTools,
      (delta) =>
        emit({ type: 'delta', streamId, content: delta.content, reasoning: delta.reasoning }),
      signal
    )

    if (signal.aborted) break

    const assistant: ChatRequestMessage = {
      role: 'assistant',
      content: result.content
    }

    let planned: PlannedCall[] = result.toolCalls.map((raw) => planNative(raw, catalogue))
    let assistantContent = result.content

    if (planned.length === 0 && input.parseTextToolCalls && result.content.trim().length > 0) {
      const parsed = extractTextToolCalls(result.content, catalogue.isKnownName)
      planned = parsed.calls.map((call, index) =>
        planText(call.name, call.args, index, iteration, catalogue)
      )
      if (planned.length > 0) {
        logger.info('agent', `recovered ${planned.length} tool call(s) from text output`)
        // Keep only the prose the model wrote before the call. The call itself
        // travels as `tool_calls`, and leaving the raw json in the content made
        // the template render it twice, which the model then echoed back.
        assistantContent = parsed.cleaned
      }
      if (parsed.unknown.length > 0) {
        // The model asked for something that is not loaded — the user needs to
        // see that, otherwise it looks like tool calling is simply broken.
        logger.warn('agent', `model asked for unloaded tool(s): ${parsed.unknown.join(', ')}`)
        if (!notices.includes('TOOL_NOT_FOUND')) {
          notices.push('TOOL_NOT_FOUND')
          emit({ type: 'notice', streamId, code: 'TOOL_NOT_FOUND' })
        }
      }
    }

    if (planned.length === 0) {
      appended.push(assistant)
      return { appended, toolCallCount, notices }
    }

    assistant.toolCalls = planned.map((entry) => entry.call)
    assistant.content = assistantContent
    if (assistantContent !== result.content) {
      // The deltas already streamed the invented tail to the renderer, so send
      // the authoritative text for the block the model actually gets to keep.
      emit({ type: 'content-reset', streamId, content: assistantContent })
    }
    appended.push(assistant)
    history.push(assistant)

    for (const entry of planned) {
      if (signal.aborted) break
      const { call } = entry
      const risk: ToolRisk = entry.tool?.risk ?? 'destructive'
      const reason = entry.malformed
        ? 'the model produced invalid JSON arguments'
        : (entry.tool?.riskReason ?? 'the tool name is not registered')
      call.risk = risk

      emit({ type: 'tool-call', streamId, call, risk })

      const startedAt = Date.now()
      const outcome = await executeCall(entry, risk, reason, input, emit, signal)
      if (outcome.executed) toolCallCount += 1

      const toolResult: ToolCallResult = {
        ok: outcome.ok,
        durationMs: Date.now() - startedAt,
        truncated: outcome.truncated,
        content: outcome.content
      }

      emit({ type: 'tool-result', streamId, callId: call.id, result: toolResult })

      const toolMessage: ChatRequestMessage = {
        role: 'tool',
        content: toolResult.content,
        toolCallId: call.id
      }
      appended.push(toolMessage)
      history.push(toolMessage)
    }

    if (iteration === input.maxIterations - 1) {
      notices.push('MAX_ITERATIONS')
      emit({ type: 'notice', streamId, code: 'MAX_ITERATIONS' })
    }
  }

  return { appended, toolCallCount, notices }
}

interface CallOutcome {
  content: string
  ok: boolean
  truncated: boolean
  /** true only when the tool actually ran */
  executed: boolean
}

/**
 * Applies the permission policy and, when allowed, runs the tool.
 */
async function executeCall(
  entry: PlannedCall,
  risk: ToolRisk,
  riskReason: string,
  input: AgentTurnInput,
  emit: (event: ChatStreamEvent) => void,
  signal: AbortSignal
): Promise<CallOutcome> {
  const { call } = entry
  const { streamId } = input

  if (entry.malformed) {
    return {
      executed: false,
      ok: false,
      truncated: false,
      content: `[tool error]\nThe arguments for ${call.name} were not valid JSON. Reply with a single well-formed tool call.`
    }
  }

  const override = configPermissionFor(input.toolPermissions, call)
  const policyDecision = decidePermission(input.policy, risk, override)

  if (policyDecision === 'deny') {
    return {
      executed: false,
      ok: false,
      truncated: false,
      content: `The user's configuration denies ${call.name}. Do not retry it.`
    }
  }

  if (policyDecision === 'ask' && !approvalBroker.isSessionAllowed(call)) {
    emit({
      type: 'approval-request',
      streamId,
      call,
      risk,
      reason: override === 'ask' ? 'this tool is always confirmed in Settings → MCP' : riskReason
    })
    const decision = await approvalBroker.await(streamId, call.id)
    emit({ type: 'approval-resolved', streamId, callId: call.id, decision })
    if (decision === 'deny') {
      return {
        executed: false,
        ok: false,
        truncated: false,
        content: `The user denied this ${call.name} call. Do not retry it; explain what you wanted to do or try another approach.`
      }
    }
    if (decision === 'allow-session') approvalBroker.rememberForSession(call)
  }

  if (!entry.tool) {
    return {
      executed: false,
      ok: false,
      truncated: false,
      content: `[tool error]\nNo tool named "${call.name}" exists. Available tools are listed in your instructions.`
    }
  }

  try {
    const result = await entry.tool.execute(call.args, signal)
    return { executed: true, content: result.content, ok: result.ok, truncated: result.truncated }
  } catch (error) {
    const message = toError(error).message
    logger.warn('agent', `${call.name} failed: ${message}`)
    return { executed: true, content: `[tool error]\n${message}`, ok: false, truncated: false }
  }
}
