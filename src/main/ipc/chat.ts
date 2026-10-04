import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { CH } from '@shared/channels'
import type { ChatRequest, ChatRequestMessage, ChatStreamEvent, LoadOptions, ServerState } from '@shared/types'
import { logger, toError } from '../util/logger'
import { serverManager } from '../llama/server-manager'
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
    activeStreams.set(request.streamId, controller)
    serverManager.touchActivity()

    const emit = (payload: ChatStreamEvent): void => emitChatStream(payload)

    const startedAt = Date.now()
    let firstTokenAt: number | null = null
    let finishReason: string | null = null

    emit({ type: 'start', streamId: request.streamId, model: serverManager.getState().modelName })
    serverManager.updateMetrics({ contextUsedTokens: null })

    try {
      const timings = await client.streamChat(
        { ...request, messages: materializeImages(request.messages) },
        {
          onDelta: (delta) => {
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
          },
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
      activeStreams.delete(request.streamId)
    }
  })

  registerHandler(CH.chat.abort, (_event, streamId: string): void => {
    const controller = activeStreams.get(streamId)
    if (!controller) return
    controller.abort()
    activeStreams.delete(streamId)
  })
}

export function abortAllStreams(): void {
  for (const controller of activeStreams.values()) controller.abort()
  activeStreams.clear()
}
