import { CH } from '@shared/channels'
import type {
  AgentNoticeCode,
  ApprovalDecision,
  ChatRequest,
  ChatRequestMessage,
  ChatStreamEvent,
  PromptPreview,
  PromptPreviewInput
} from '@shared/types'
import { logger, toError } from '../util/logger'
import { serverManager } from '../llama/server-manager'
import type { ChatTimings } from '../llama/client'
import { settingsStore } from '../store/settings'
import { runAgentTurn } from '../agent/loop'
import { approvalBroker } from '../agent/permission'
import { buildPromptPreview, composePrompt } from '../agent/prompt'
import { buildToolCatalogue } from '../agent/tools'
import { materializeImages } from './images'
import { emitAgentStream } from './events'
import { registerHandler } from './register'
import { abortStream, registerStream, releaseStream } from './streams'

const MIN_ITERATIONS = 1
const MAX_ITERATIONS = 20

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

interface TurnRecorder {
  emit: (event: ChatStreamEvent) => void
  emitNotice: (code: AgentNoticeCode) => void
  finishReason(): string | null
  setFinishReason(reason: string | null): void
}

/**
 * Runs the agent loop for one turn and returns the timings of the final
 * streaming pass, which is what the UI reports as the message statistics.
 *
 * This lives on the agent channel rather than the chat channel because an agent
 * turn is not a chat completion: it plans, calls tools, feeds the results back
 * and repeats, and only the caller that owns the loop can honour approvals.
 */
async function runAgentTurnOnce(
  request: ChatRequest,
  messages: ChatRequestMessage[],
  recorder: TurnRecorder,
  signal: AbortSignal
): Promise<ChatTimings> {
  const settings = settingsStore.get()
  const overrides = request.agent
  const client = serverManager.getClient()
  if (!client) throw new Error('SERVER_NOT_READY')

  const catalogue = buildToolCatalogue(overrides)
  const composed = composePrompt(
    { systemPrompt: request.systemPrompt, mode: 'agent', agent: overrides },
    catalogue,
    settings.agent
  )

  const state = serverManager.getState()
  if (catalogue.openAiTools.length > 0 && state.supportsTools === false) {
    recorder.emitNotice('TOOLS_UNSUPPORTED')
  }

  // The prompt and the tool schemas both consume context, so the loop only gets
  // whatever is left over.
  const systemTokens = composed.text.length > 0 ? await serverManager.tokenize(composed.text) : 0
  const toolTokens =
    catalogue.openAiTools.length > 0
      ? await serverManager.tokenize(JSON.stringify(catalogue.openAiTools))
      : 0
  const contextSize = state.contextSize ?? 4096
  const budget = Math.max(256, Math.floor(contextSize * 0.82) - systemTokens - toolTokens - 256)

  let timings: ChatTimings = {}

  const result = await runAgentTurn(
    {
      streamId: request.streamId,
      messages,
      catalogue,
      policy: overrides?.permission ?? settings.agent.permission,
      maxIterations: clamp(
        overrides?.maxIterations ?? settings.agent.maxIterations,
        MIN_ITERATIONS,
        MAX_ITERATIONS
      ),
      parseTextToolCalls: settings.agent.parseTextToolCalls,
      toolPermissions: settings.mcp.toolPermissions
    },
    {
      emit: recorder.emit,
      budget,
      streamOnce: async (history, tools, onDelta, streamSignal) => {
        let content = ''
        let reasoning = ''
        const streamed = await client.streamChat(
          { ...request, systemPrompt: composed.text, messages: history },
          {
            onDelta: (delta) => {
              content += delta.content ?? ''
              reasoning += delta.reasoning ?? ''
              onDelta(delta)
            },
            onFinishReason: (reason) => recorder.setFinishReason(reason)
          },
          streamSignal,
          tools.length > 0 ? { tools } : undefined
        )
        const { toolCalls, ...rest } = streamed
        timings = rest
        return { content, reasoning, toolCalls, finishReason: recorder.finishReason() }
      }
    },
    signal
  )

  logger.info(
    'agent',
    `turn finished with ${result.toolCallCount} tool call(s)${result.notices.length > 0 ? `, notices: ${result.notices.join(',')}` : ''}`
  )

  return timings
}

export function registerAgentHandlers(): void {
  registerHandler(CH.agent.previewPrompt, (_event, input: PromptPreviewInput): Promise<PromptPreview> => {
    const safe = input ?? { systemPrompt: '', mode: 'chat' as const }
    return buildPromptPreview(
      {
        systemPrompt: typeof safe.systemPrompt === 'string' ? safe.systemPrompt : '',
        mode: safe.mode === 'agent' ? 'agent' : 'chat',
        agent: safe.agent
      },
      (text) => serverManager.tokenize(text),
      settingsStore.get().agent
    )
  })

  registerHandler(CH.agent.send, async (_event, request: ChatRequest): Promise<void> => {
    if (!request || typeof request.streamId !== 'string') throw new Error('INVALID_REQUEST')

    const controller = new AbortController()
    registerStream(request.streamId, controller)
    serverManager.touchActivity()

    const emit = (payload: ChatStreamEvent): void => emitAgentStream(payload)

    const startedAt = Date.now()
    let firstTokenAt: number | null = null
    let finishReason: string | null = null

    const recorder: TurnRecorder = {
      emit: (event) => {
        if (event.type === 'delta' && firstTokenAt === null && (event.content || event.reasoning)) {
          firstTokenAt = Date.now()
          const ttftMs = firstTokenAt - startedAt
          serverManager.updateMetrics({ ttftMs })
          emit({ type: 'metrics', streamId: request.streamId, metrics: { ttftMs } })
        }
        emit(event)
      },
      emitNotice: (code) => emit({ type: 'notice', streamId: request.streamId, code }),
      finishReason: () => finishReason,
      setFinishReason: (reason) => {
        finishReason = reason
      }
    }

    emit({ type: 'start', streamId: request.streamId, model: serverManager.getState().modelName })
    serverManager.updateMetrics({ contextUsedTokens: null })

    try {
      const messages = materializeImages(request.messages)
      const timings = await runAgentTurnOnce(request, messages, recorder, controller.signal)

      const durationMs = Date.now() - startedAt
      const stats = {
        ttftMs: firstTokenAt !== null ? firstTokenAt - startedAt : undefined,
        tokensPerSecond: timings.tokensPerSecond,
        promptTokens: timings.promptTokens,
        completionTokens: timings.completionTokens,
        durationMs
      }

      serverManager.updateMetrics({
        tokensPerSecond: timings.tokensPerSecond ?? null,
        promptTokens: timings.promptTokens ?? null,
        completionTokens: timings.completionTokens ?? null,
        promptPerSecond: timings.promptPerSecond ?? null,
        contextUsedTokens:
          timings.promptTokens !== undefined && timings.completionTokens !== undefined
            ? timings.promptTokens + timings.completionTokens
            : null
      })

      emit({ type: 'done', streamId: request.streamId, stats, finishReason })
      serverManager.touchActivity()
    } catch (error) {
      if (controller.signal.aborted) {
        emit({ type: 'aborted', streamId: request.streamId })
      } else {
        const message = toError(error).message
        logger.error('agent', `turn failed: ${message}`)
        emit({ type: 'error', streamId: request.streamId, message })
      }
    } finally {
      // Never leave the renderer blocked on an approval that can no longer be answered.
      approvalBroker.denyPending(request.streamId)
      releaseStream(request.streamId)
    }
  })

  registerHandler(CH.agent.abort, (_event, streamId: string): void => {
    if (typeof streamId !== 'string') return
    approvalBroker.denyPending(streamId)
    abortStream(streamId)
  })

  registerHandler(
    CH.agent.approveTool,
    (_event, streamId: string, callId: string, decision: ApprovalDecision): void => {
      if (typeof streamId !== 'string' || typeof callId !== 'string') return
      approvalBroker.resolve(streamId, callId, decision)
    }
  )
}
