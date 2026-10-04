import type { ChatRequest, ChatRequestMessage, SamplingParams } from '@shared/types'
import { logger, toError } from '../util/logger'

export interface ChatDelta {
  content?: string
  reasoning?: string
}

export interface ChatTimings {
  promptTokens?: number
  completionTokens?: number
  promptPerSecond?: number
  tokensPerSecond?: number
  durationMs?: number
}

export interface StreamCallbacks {
  onDelta: (delta: ChatDelta) => void
  onFinishReason: (reason: string | null) => void
}

interface ServerTimings {
  prompt_n?: number
  prompt_ms?: number
  prompt_per_second?: number
  predicted_n?: number
  predicted_ms?: number
  predicted_per_second?: number
}

interface StreamChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  timings?: ServerTimings
  error?: { message?: string } | string
}

export function buildSamplingPayload(sampling: SamplingParams): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    temperature: sampling.temperature,
    top_p: sampling.topP,
    top_k: sampling.topK,
    min_p: sampling.minP,
    repeat_penalty: sampling.repeatPenalty,
    repeat_last_n: sampling.repeatLastN,
    presence_penalty: sampling.presencePenalty,
    frequency_penalty: sampling.frequencyPenalty,
    seed: sampling.seed < 0 ? null : sampling.seed
  }
  if (sampling.maxTokens > 0) payload.max_tokens = sampling.maxTokens
  if (sampling.stop.length > 0) payload.stop = sampling.stop
  return payload
}

export function toApiMessages(
  systemPrompt: string,
  messages: ChatRequestMessage[]
): Array<Record<string, unknown>> {
  const apiMessages: Array<Record<string, unknown>> = []

  if (systemPrompt.trim().length > 0) {
    apiMessages.push({ role: 'system', content: systemPrompt })
  }

  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.images && message.images.length > 0) {
      const parts: Array<Record<string, unknown>> = []
      if (message.content.length > 0) parts.push({ type: 'text', text: message.content })
      for (const image of message.images) {
        parts.push({ type: 'image_url', image_url: { url: image } })
      }
      apiMessages.push({ role: message.role, content: parts })
    } else {
      apiMessages.push({ role: message.role, content: message.content })
    }
  }

  return apiMessages
}

export class LlamaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
    return headers
  }

  async health(timeoutMs = 3000): Promise<{ status: string } | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: controller.signal })
      if (!response.ok) return null
      return (await response.json()) as { status: string }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async props(timeoutMs = 5000): Promise<Record<string, unknown> | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${this.baseUrl}/props`, {
        headers: this.headers(),
        signal: controller.signal
      })
      if (!response.ok) return null
      return (await response.json()) as Record<string, unknown>
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async tokenize(text: string): Promise<number> {
    try {
      const response = await fetch(`${this.baseUrl}/tokenize`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ content: text })
      })
      if (!response.ok) return 0
      const data = (await response.json()) as { tokens?: unknown[] }
      return Array.isArray(data.tokens) ? data.tokens.length : 0
    } catch {
      return 0
    }
  }

  /**
   * Streams a chat completion. Resolves once the server is done or the
   * provided signal aborts the request.
   */
  async streamChat(
    request: ChatRequest,
    callbacks: StreamCallbacks,
    signal: AbortSignal
  ): Promise<ChatTimings> {
    const body = {
      model: 'lumilm',
      messages: toApiMessages(request.systemPrompt, request.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...buildSamplingPayload(request.sampling)
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal
    })

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '')
      throw new Error(`llama-server returned ${response.status}: ${detail.slice(0, 500)}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const timings: ChatTimings = {}

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let separator = buffer.indexOf('\n\n')
      while (separator >= 0) {
        const rawEvent = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        this.handleEvent(rawEvent, callbacks, timings)
        separator = buffer.indexOf('\n\n')
      }
    }

    if (buffer.trim().length > 0) this.handleEvent(buffer, callbacks, timings)
    return timings
  }

  private handleEvent(rawEvent: string, callbacks: StreamCallbacks, timings: ChatTimings): void {
    for (const line of rawEvent.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload.length === 0 || payload === '[DONE]') continue

      let chunk: StreamChunk
      try {
        chunk = JSON.parse(payload) as StreamChunk
      } catch {
        logger.debug('client', 'skipping malformed SSE payload')
        continue
      }

      if (chunk.error) {
        const message = typeof chunk.error === 'string' ? chunk.error : chunk.error.message
        throw new Error(message ?? 'unknown llama-server error')
      }

      const choice = chunk.choices?.[0]
      if (choice?.delta) {
        const reasoning = choice.delta.reasoning_content ?? choice.delta.reasoning ?? undefined
        const content = choice.delta.content ?? undefined
        if (content || reasoning) callbacks.onDelta({ content, reasoning: reasoning ?? undefined })
      }
      if (choice?.finish_reason) callbacks.onFinishReason(choice.finish_reason)

      if (chunk.usage) {
        if (typeof chunk.usage.prompt_tokens === 'number') timings.promptTokens = chunk.usage.prompt_tokens
        if (typeof chunk.usage.completion_tokens === 'number') {
          timings.completionTokens = chunk.usage.completion_tokens
        }
      }
      if (chunk.timings) {
        const server = chunk.timings
        if (typeof server.prompt_n === 'number') timings.promptTokens = server.prompt_n
        if (typeof server.predicted_n === 'number') timings.completionTokens = server.predicted_n
        if (typeof server.prompt_per_second === 'number') {
          timings.promptPerSecond = server.prompt_per_second
        }
        if (typeof server.predicted_per_second === 'number') {
          timings.tokensPerSecond = server.predicted_per_second
        }
        if (typeof server.prompt_ms === 'number' && typeof server.predicted_ms === 'number') {
          timings.durationMs = server.prompt_ms + server.predicted_ms
        }
      }
    }
  }
}

export function describeError(error: unknown): string {
  return toError(error).message
}
