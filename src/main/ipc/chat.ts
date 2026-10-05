import { CH } from '@shared/channels'
import type {
  ApprovalDecision,
  ChatRequest,
  ChatStreamEvent,
  LoadOptions,
  ServerState
} from '@shared/types'
import { logger, toError } from '../util/logger'
import { serverManager } from '../llama/server-manager'
import { approvalBroker } from '../agent/permission'
import { materializeImages } from './images'
import { emitChatStream } from './events'
import { registerHandler } from './register'
import { abortStream, registerStream, releaseStream } from './streams'

/**
 * The plain chat channel: one request, one streamed answer, no tools and no
 * prompt injection. Agent turns run on their own channel (see `agent.ts`) so
 * neither path has to branch on the other's state.
 */
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

  registerHandler(CH.chat.send, async (_event, request: ChatRequest): Promise<void> => {
    if (!request || typeof request.streamId !== 'string') throw new Error('INVALID_REQUEST')

    const client = serverManager.getClient()
    if (!client) throw new Error('SERVER_NOT_READY')

    const controller = new AbortController()
    registerStream(request.streamId, controller)
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

    emit({ type: 'start', streamId: request.streamId, model: serverManager.getState().modelName })
    serverManager.updateMetrics({ contextUsedTokens: null })

    try {
      const messages = materializeImages(request.messages)

      const timings = await client.streamChat(
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
      releaseStream(request.streamId)
    }
  })

  registerHandler(CH.chat.abort, (_event, streamId: string): void => {
    if (typeof streamId !== 'string') return
    approvalBroker.denyPending(streamId)
    abortStream(streamId)
  })

  registerHandler(
    CH.chat.approveTool,
    (_event, streamId: string, callId: string, decision: ApprovalDecision): void => {
      if (typeof streamId !== 'string' || typeof callId !== 'string') return
      approvalBroker.resolve(streamId, callId, decision)
    }
  )
}
