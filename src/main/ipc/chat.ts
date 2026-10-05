import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { CH } from '@shared/channels'
import type {
  AgentNoticeCode,
  ApprovalDecision,
  ChatRequest,
  ChatRequestMessage,
  ChatStreamEvent,
  LoadOptions,
  PromptPreview,
  PromptPreviewInput,
  ServerState
} from '@shared/types'
import { logger, toError } from '../util/logger'
import { serverManager } from '../llama/server-manager'
import type { ChatTimings } from '../llama/client'
import { settingsStore } from '../store/settings'
import { runAgentTurn } from '../agent/loop'
import { approvalBroker } from '../agent/permission'
import { buildPromptPreview, composePrompt } from '../agent/prompt'
import { buildToolCatalogue } from '../agent/tools'
import { emitChatStream } from './events'
import { registerHandler } from './register'

const activeStreams = new Map<string, AbortController>()

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MIN_ITERATIONS = 1
const MAX_ITERATIONS = 20

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * llama-server expects inline image payloads, so local file paths coming from
 * the renderer are converted into base64 data URLs here (the renderer never has
 * to shuttle megabytes of base64 across the IPC boundary).
 */
function materializeImages(messages: ChatRequestMessage[]): ChatRequestMessage[] {
  if (!messages.some((message) => message.images && message.images.length > 0)) return messages

  return messages.map((message) => {
    if (!message.images || message.images.length === 0) return message

    const dataUrls: string[] = []
    for (const imagePath of message.images) {
      try {
        const stats = statSync(imagePath)
        if (!stats.isFile() || stats.size > MAX_IMAGE_BYTES) {
          logger.warn('chat', `skipping image (too large or not a file): ${imagePath}`)
          continue
        }
        const mime = MIME_BY_EXTENSION[extname(imagePath).toLowerCase()] ?? 'image/png'
        dataUrls.push(`data:${mime};base64,${readFileSync(imagePath).toString('base64')}`)
      } catch (error) {
        logger.warn('chat', `failed to read image ${imagePath}: ${toError(error).message}`)
      }
    }

    return { ...message, images: dataUrls }
  })
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
 */
async function runAgentChat(
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

export function registerChatHandlers(): void {
  registerHandler(CH.server.state, (): ServerState => serverManager.getState())

  registerHandler(CH.server.load, (_event, options: LoadOptions): Promise<ServerState> =>
    serverManager.load(options ?? {})
  )

  registerHandler(CH.server.stop, (): Promise<ServerState> => serverManager.stop())

  registerHandler(CH.server.logs, (): string[] => serverManager.getLogs())

  registerHandler(CH.server.clearLogs, (): void => serverManager.clearLogs())

  registerHandler(CH.server.tokenize, (_event, text: string): Promise<number> => {
    if (typeof text !== 'string') return Promise.resolve(0)
    return serverManager.tokenize(text)
  })

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

  registerHandler(CH.chat.send, async (_event, request: ChatRequest): Promise<void> => {
    if (!request || typeof request.streamId !== 'string') throw new Error('INVALID_REQUEST')

    const client = serverManager.getClient()
    if (!client) throw new Error('SERVER_NOT_READY')

    const controller = new AbortController()
    activeStreams.set(request.streamId, controller)
    serverManager.touchActivity()

    const emit = (payload: ChatStreamEvent): void => emitChatStream(payload)

    const startedAt = Date.now()
    let firstTokenAt: number | null = null
    let finishReason: string | null = null

    const onDelta = (delta: { content?: string; reasoning?: string }): void => {
      if (firstTokenAt === null && (delta.content || delta.reasoning)) {
        firstTokenAt = Date.now()
        const ttftMs = firstTokenAt - startedAt
        serverManager.updateMetrics({ ttftMs })
        emit({ type: 'metrics', streamId: request.streamId, metrics: { ttftMs } })
      }
      emit({
        type: 'delta',
        streamId: request.streamId,
        content: delta.content,
        reasoning: delta.reasoning
      })
    }

    const recorder: TurnRecorder = {
      emit,
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

      const timings =
        request.mode === 'agent'
          ? await runAgentChat(request, messages, recorder, controller.signal)
          : await client.streamChat(
              { ...request, messages },
              {
                onDelta,
                onFinishReason: (reason) => {
                  finishReason = reason
                }
              },
              controller.signal
            )

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
        logger.error('chat', `stream failed: ${message}`)
        emit({ type: 'error', streamId: request.streamId, message })
      }
    } finally {
      // Never leave the renderer blocked on an approval that can no longer be answered.
      approvalBroker.denyPending(request.streamId)
      activeStreams.delete(request.streamId)
    }
  })

  registerHandler(CH.chat.abort, (_event, streamId: string): void => {
    if (typeof streamId !== 'string') return
    approvalBroker.denyPending(streamId)
    const controller = activeStreams.get(streamId)
    if (!controller) return
    controller.abort()
    activeStreams.delete(streamId)
  })

  registerHandler(
    CH.chat.approveTool,
    (_event, streamId: string, callId: string, decision: ApprovalDecision): void => {
      if (typeof streamId !== 'string' || typeof callId !== 'string') {
        throw new Error('INVALID_REQUEST')
      }
      if (decision !== 'allow' && decision !== 'allow-session' && decision !== 'deny') {
        throw new Error('INVALID_DECISION')
      }
      approvalBroker.resolve(streamId, callId, decision)
    }
  )
}

export function abortAllStreams(): void {
  for (const controller of activeStreams.values()) controller.abort()
  activeStreams.clear()
}
