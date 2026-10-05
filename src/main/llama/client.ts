import type { ChatRequest, ChatRequestMessage, SamplingParams } from '@shared/types'
import type { OpenAiTool } from '../mcp/registry'
import { logger, toError } from '../util/logger'

export interface ChatDelta {
  content?: string
  reasoning?: string
}

/** A tool call as reported by llama-server, before namespacing. */
export interface RawToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  /** raw JSON string, kept so a parse failure can be explained to the model */
  argsRaw: string
  /** true when `argsRaw` was not valid JSON */
  invalid: boolean
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
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: ToolCallDelta[]
    }
    message?: { tool_calls?: ToolCallDelta[] }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  timings?: ServerTimings
  error?: { message?: string } | string
}

interface ToolCallDelta {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface CompletionChunk {
  choices?: Array<{
    message?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  timings?: ServerTimings
  error?: { message?: string } | string
}

function applyUsage(timings: ChatTimings, usage: StreamChunk['usage']): void {
  if (!usage) return
  if (typeof usage.prompt_tokens === 'number') timings.promptTokens = usage.prompt_tokens
  if (typeof usage.completion_tokens === 'number') {
    timings.completionTokens = usage.completion_tokens
  }
}

function applyTimings(timings: ChatTimings, server: ServerTimings | undefined): void {
  if (!server) return
  if (typeof server.prompt_n === 'number') timings.promptTokens = server.prompt_n
  if (typeof server.predicted_n === 'number') timings.completionTokens = server.predicted_n
  if (typeof server.prompt_per_second === 'number') timings.promptPerSecond = server.prompt_per_second
  if (typeof server.predicted_per_second === 'number') {
    timings.tokensPerSecond = server.predicted_per_second
  }
  if (typeof server.prompt_ms === 'number' && typeof server.predicted_ms === 'number') {
    timings.durationMs = server.prompt_ms + server.predicted_ms
  }
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

    if (message.role === 'tool') {
      apiMessages.push({
        role: 'tool',
        tool_call_id: message.toolCallId ?? 'unknown',
        content: message.content
      })
      continue
    }

    const entry: Record<string, unknown> = { role: message.role }

    if (message.images && message.images.length > 0) {
      const parts: Array<Record<string, unknown>> = []
      if (message.content.length > 0) parts.push({ type: 'text', text: message.content })
      for (const image of message.images) {
        parts.push({ type: 'image_url', image_url: { url: image } })
      }
      entry.content = parts
    } else {
      entry.content = message.content
    }

    // llama.cpp renders the tool results from this declaration, so it has to
    // travel with the assistant message that requested them.
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      entry.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) }
      }))
    }

    apiMessages.push(entry)
  }

  return apiMessages
}

/**
 * Turns llama-server's error body into a sentence worth showing to a user.
 *
 * The body is JSON (`{"error":{"message":"…"}}`), so surfacing it raw left the
 * UI showing a wall of escaped JSON that explained nothing.
 */
function describeHttpError(status: number, detail: string): string {
  const trimmed = detail.trim()
  let message = ''

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: string | { message?: string } }
      message =
        typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? '')
    } catch {
      message = ''
    }
  }
  if (message.length === 0) message = trimmed.slice(0, 300)

  const lines = [`llama-server 返回 HTTP ${status}`]
  if (message.length > 0) lines.push(message)
  if (status === 400) lines.push('请求被拒绝：通常是上下文长度或消息顺序的问题，可尝试缩短对话。')
  else if (status === 404) lines.push('接口不存在：llama.cpp 后端版本可能不匹配。')
  else if (status >= 500) lines.push('llama-server 内部错误，可查看运行日志。')
  return lines.join('\n')
}

export interface StreamOptions {
  /** OpenAI-style function definitions; omitted entirely in plain chat mode. */
  tools?: OpenAiTool[]
  toolChoice?: string
  /**
   * Extra fields merged into the request body verbatim. Used for llama.cpp
   * knobs the app deliberately does not model, such as `cache_prompt` and
   * `n_keep`.
   */
  extraBody?: Record<string, unknown>
}

export interface CompleteOptions {
  /** Extra fields merged into the request body after everything else. */
  extraBody?: Record<string, unknown>
  /** Overrides the sampling max_tokens for this single call. */
  maxTokens?: number
}

export interface CompletionResult {
  content: string
  reasoning: string
  finishReason: string | null
  timings: ChatTimings
}

interface ToolCallAccumulator {
  id: string
  name: string
  args: string
}

/**
 * OpenAI streams a tool call across many chunks: the first carries `id` and the
 * function name, the rest append fragments of the `arguments` JSON string.
 * Everything is keyed by `index` and joined at the end.
 */
export class ToolCallCollector {
  private entries = new Map<number, ToolCallAccumulator>()

  push(deltas: ToolCallDelta[] | undefined): void {
    if (!deltas) return
    for (const delta of deltas) {
      const index = delta.index ?? 0
      const entry = this.entries.get(index) ?? { id: '', name: '', args: '' }
      if (typeof delta.id === 'string' && delta.id.length > 0) entry.id = delta.id
      if (typeof delta.function?.name === 'string' && delta.function.name.length > 0) {
        // Some builds resend the full name instead of an empty fragment.
        entry.name = entry.name.length === 0 ? delta.function.name : entry.name + delta.function.name
      }
      if (typeof delta.function?.arguments === 'string') entry.args += delta.function.arguments
      this.entries.set(index, entry)
    }
  }

  isEmpty(): boolean {
    return this.entries.size === 0
  }

  finish(): RawToolCall[] {
    return [...this.entries.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, entry]) => {
        if (entry.name.length === 0) return null
        let args: Record<string, unknown> = {}
        let invalid = false
        const raw = entry.args.trim()
        if (raw.length > 0) {
          try {
            const parsed = JSON.parse(raw) as unknown
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
              args = parsed as Record<string, unknown>
            } else {
              invalid = true
            }
          } catch {
            invalid = true
          }
        }
        return {
          id: entry.id.length > 0 ? entry.id : `call_${index}`,
          name: entry.name,
          args,
          argsRaw: raw,
          invalid
        } satisfies RawToolCall
      })
      .filter((call): call is RawToolCall => call !== null)
  }
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
    signal: AbortSignal,
    options?: StreamOptions
  ): Promise<ChatTimings & { toolCalls: RawToolCall[] }> {
    const body: Record<string, unknown> = {
      model: 'lumilm',
      messages: toApiMessages(request.systemPrompt, request.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...buildSamplingPayload(request.sampling)
    }

    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools
      body.tool_choice = options.toolChoice ?? 'auto'
    }
    Object.assign(body, options?.extraBody ?? {})

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal
    })

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '')
      throw new Error(describeHttpError(response.status, detail))
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const timings: ChatTimings = {}
    const collector = new ToolCallCollector()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let separator = buffer.indexOf('\n\n')
      while (separator >= 0) {
        const rawEvent = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        this.handleEvent(rawEvent, callbacks, timings, collector)
        separator = buffer.indexOf('\n\n')
      }
    }

    if (buffer.trim().length > 0) this.handleEvent(buffer, callbacks, timings, collector)
    return { ...timings, toolCalls: collector.finish() }
  }

  private handleEvent(
    rawEvent: string,
    callbacks: StreamCallbacks,
    timings: ChatTimings,
    collector: ToolCallCollector
  ): void {
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
        collector.push(choice.delta.tool_calls)
      }
      // A non-streaming build may deliver the whole call on the message instead.
      if (choice?.message?.tool_calls) collector.push(choice.message.tool_calls)
      if (choice?.finish_reason) callbacks.onFinishReason(choice.finish_reason)

      if (chunk.usage) {
        applyUsage(timings, chunk.usage)
      }
      applyTimings(timings, chunk.timings)
    }
  }

  /**
   * One non-streaming completion. Background jobs (memory extraction, dream
   * consolidation) use this so they can never paint anything into the UI.
   *
   * `extraBody` carries the llama.cpp specific knobs. The extractor depends on
   * two of them: an assistant-message prefill, which skips the model's thinking
   * block entirely, and `cache_prompt`, which reuses the KV cache of the turn
   * that just finished.
   */
  async complete(
    request: ChatRequest,
    options: CompleteOptions = {},
    signal?: AbortSignal
  ): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: 'lumilm',
      messages: toApiMessages(request.systemPrompt, request.messages),
      stream: false,
      ...buildSamplingPayload(request.sampling)
    }
    if (options.maxTokens !== undefined && options.maxTokens > 0) {
      body.max_tokens = options.maxTokens
    }
    Object.assign(body, options.extraBody ?? {})

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(describeHttpError(response.status, detail))
    }

    const json = (await response.json()) as CompletionChunk
    if (json.error) {
      const message = typeof json.error === 'string' ? json.error : json.error.message
      throw new Error(message ?? 'unknown llama-server error')
    }

    const choice = json.choices?.[0]
    const message = choice?.message ?? {}
    const timings: ChatTimings = {}
    applyUsage(timings, json.usage)
    applyTimings(timings, json.timings)

    return {
      content: message.content ?? '',
      reasoning: message.reasoning_content ?? message.reasoning ?? '',
      finishReason: choice?.finish_reason ?? null,
      timings
    }
  }
}

export function describeError(error: unknown): string {
  return toError(error).message
}
