import { CH } from '@shared/channels'
import type {
  ChatRequest,
  ChatRequestMessage,
  ChatStreamEvent,
  CompanionOverview,
  PromptPreview,
  PromptPreviewInput,
  RelationshipState
} from '@shared/types'
import { logger, toError } from '../util/logger'
import { serverManager } from '../llama/server-manager'
import { settingsStore } from '../store/settings'
import { conversationStore } from '../store/conversations'
import { companionService } from '../companion/service'
import { heartbeatService } from '../companion/heartbeat'
import { emitCompanionStream, emitMemoryChanged } from './events'
import { registerHandler } from './register'
import { abortStream, registerStream, releaseStream } from './streams'

/**
 * The companion channel.
 *
 * It is a separate channel from `chat` for the same reason the agent got one:
 * a companion turn injects a persona and a memory block, and only the code that
 * composed those can undo them. It has no tools and no loop, so it is much
 * simpler than the agent channel — one request, one streamed answer, then a
 * background extraction pass.
 */
export function registerCompanionHandlers(): void {
  const announce = (): void => {
    try {
      emitMemoryChanged(companionService.overview())
    } catch (error) {
      logger.warn('companion', `failed to broadcast memory change: ${toError(error).message}`)
    }
  }

  registerHandler(CH.companion.overview, (): CompanionOverview => companionService.overview())

  registerHandler(
    CH.companion.updateRelationship,
    (_event, patch: Partial<RelationshipState>): CompanionOverview => {
      if (patch && typeof patch === 'object') companionService.updateRelationship(patch)
      return companionService.overview()
    }
  )

  registerHandler(
    CH.companion.setHeartbeat,
    (_event, patch: { enabled?: boolean; snoozeMinutes?: number }): CompanionOverview => {
      if (typeof patch?.enabled === 'boolean') {
        settingsStore.update({ companion: { heartbeatEnabled: patch.enabled } })
      }
      if (typeof patch?.snoozeMinutes === 'number') {
        heartbeatService.snooze(patch.snoozeMinutes)
      }
      return companionService.overview()
    }
  )

  registerHandler(CH.companion.heartbeatTest, async (): Promise<boolean> => {
    const spoke = await heartbeatService.speakUp(true)
    announce()
    return spoke
  })

  registerHandler(CH.companion.dreamNow, async (): Promise<CompanionOverview> => {
    await companionService.dream()
    announce()
    return companionService.overview()
  })

  registerHandler(
    CH.companion.previewPrompt,
    async (_event, input: PromptPreviewInput): Promise<PromptPreview> => {
      const safe = input ?? { systemPrompt: '', mode: 'companion' as const }
      const preview = companionService.preview({
        conversationId: safe.conversationId,
        systemPrompt: typeof safe.systemPrompt === 'string' ? safe.systemPrompt : '',
        mode: 'companion',
        companion: safe.companion
      })
      const blocks = await Promise.all(
        preview.blocks.map(async (block) => ({
          ...block,
          tokens: block.enabled ? await serverManager.tokenize(block.content) : 0
        }))
      )
      return {
        text: preview.system,
        blocks,
        toolsCount: 0,
        toolsTokens: 0,
        totalTokens: blocks
          .filter((block) => block.enabled)
          .reduce((sum, block) => sum + block.tokens, 0),
        injectionDisabled:
          preview.system.trim().length === 0 && preview.injection.trim().length === 0,
        injection: preview.injection,
        injectionTokens:
          preview.injection.length > 0 ? await serverManager.tokenize(preview.injection) : 0
      }
    }
  )

  registerHandler(CH.companion.send, async (_event, request: ChatRequest): Promise<void> => {
    if (!request || typeof request.streamId !== 'string') throw new Error('INVALID_REQUEST')

    const client = serverManager.getClient()
    if (!client) throw new Error('SERVER_NOT_READY')

    const conversation = request.conversationId
      ? conversationStore.get(request.conversationId)
      : null
    if (!conversation) throw new Error('CONVERSATION_NOT_FOUND')

    // A background extraction must never sit in front of a real reply.
    companionService.yieldToUser()

    const plan = companionService.plan(conversation, request)
    const settings = settingsStore.get().companion

    // Continuing from a one-space assistant turn skips the model's thinking
    // block: measured 13.2 s with it, 1.7 s without, and the answer stays in
    // character because the reasoning never leaks into the visible reply.
    const outbound: ChatRequest = settings.skipThinking
      ? {
          ...plan.request,
          messages: [...plan.request.messages, { role: 'assistant', content: ' ' }]
        }
      : plan.request

    const controller = new AbortController()
    registerStream(request.streamId, controller)
    serverManager.touchActivity()

    const emit = (payload: ChatStreamEvent): void => emitCompanionStream(payload)

    const startedAt = Date.now()
    let firstTokenAt: number | null = null
    let firstContentSeen = false
    let finishReason: string | null = null
    let content = ''

    const onDelta = (delta: { content?: string; reasoning?: string }): void => {
      // Some builds echo the prefill back as the first content chunk.
      let chunk = delta.content
      if (chunk !== undefined && !firstContentSeen) {
        firstContentSeen = true
        if (chunk.trim().length === 0) chunk = undefined
      }
      if (chunk === undefined && !delta.reasoning) return

      if (firstTokenAt === null) {
        firstTokenAt = Date.now()
        const ttftMs = firstTokenAt - startedAt
        serverManager.updateMetrics({ ttftMs })
        emit({ type: 'metrics', streamId: request.streamId, metrics: { ttftMs } })
      }
      if (chunk) content += chunk
      emit({ type: 'delta', streamId: request.streamId, content: chunk, reasoning: delta.reasoning })
    }

    emit({ type: 'start', streamId: request.streamId, model: serverManager.getState().modelName })

    const sampling = companionService.applySampling(outbound.sampling)

    try {
      let timings = await client.streamChat(
        { ...outbound, sampling },
        {
          onDelta,
          onFinishReason: (reason) => {
            finishReason = reason
          }
        },
        controller.signal,
        { extraBody: { cache_prompt: true, n_keep: plan.composed.personaTokens } }
      )

      // One regeneration attempt when the model stepped out of character.
      if (settings.antiOocRetry && companionService.brokeCharacter(content)) {
        logger.info('companion', 'reply broke character, regenerating once')
        const firstReply = content
        content = ''
        firstContentSeen = false
        finishReason = null
        emit({ type: 'content-reset', streamId: request.streamId, content: '' })

        const retryMessages: ChatRequestMessage[] = [
          ...outbound.messages,
          { role: 'assistant', content: firstReply },
          { role: 'user', content: companionService.retryInjection() }
        ]
        if (settings.skipThinking) retryMessages.push({ role: 'assistant', content: ' ' })

        timings = await client.streamChat(
          {
            ...outbound,
            sampling: { ...sampling, temperature: Math.min(1, sampling.temperature + 0.1) },
            messages: retryMessages
          },
          {
            onDelta,
            onFinishReason: (reason) => {
              finishReason = reason
            }
          },
          controller.signal,
          { extraBody: { cache_prompt: true } }
        )
      }

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

      // Only now, with the KV cache still holding this prefix, is the
      // extraction pass nearly free.
      companionService.scheduleExtraction(conversation.id, plan, content)
    } catch (error) {
      if (controller.signal.aborted) {
        emit({ type: 'aborted', streamId: request.streamId })
      } else {
        const message = toError(error).message
        logger.error('companion', `stream failed: ${message}`)
        emit({ type: 'error', streamId: request.streamId, message })
      }
    } finally {
      releaseStream(request.streamId)
    }
  })

  registerHandler(CH.companion.abort, (_event, streamId: string): void => {
    if (typeof streamId !== 'string') return
    abortStream(streamId)
  })
}
