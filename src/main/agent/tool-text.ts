/**
 * Local models often emit a tool call as a fenced JSON block instead of using
 * the native `tool_calls` channel, especially at Q4 quantisation. This parser
 * recovers those calls, but only when the JSON names a tool that actually
 * exists — a code snippet in an answer must never be mistaken for a call.
 */

export interface TextToolCall {
  name: string
  args: Record<string, unknown>
}

export interface TextToolParseResult {
  calls: TextToolCall[]
  /** the content with the recognised blocks removed */
  cleaned: string
}

const FENCE = /```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)```/g

function coerceArgs(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function asCall(candidate: unknown, isKnown: (name: string) => boolean): TextToolCall | null {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return null
  const source = candidate as Record<string, unknown>

  const name = typeof source.name === 'string' ? source.name : null
  if (!name || !isKnown(name)) return null

  const args = coerceArgs(source.arguments ?? source.parameters ?? source.args ?? {})
  if (!args) return null

  return { name, args }
}

export function extractTextToolCalls(
  content: string,
  isKnown: (name: string) => boolean
): TextToolParseResult {
  const calls: TextToolCall[] = []
  const accepted: string[] = []

  FENCE.lastIndex = 0
  let match = FENCE.exec(content)
  while (match) {
    const body = (match[1] ?? '').trim()
    const parsed = tryParse(body)
    const call = asCall(parsed, isKnown)
    if (call) {
      calls.push(call)
      accepted.push(match[0])
    }
    match = FENCE.exec(content)
  }

  // Some models emit the object with no fence at all when it is the whole reply.
  if (calls.length === 0) {
    const bare = asCall(tryParse(content.trim()), isKnown)
    if (bare) return { calls: [bare], cleaned: '' }
    return { calls: [], cleaned: content }
  }

  let cleaned = content
  for (const block of accepted) cleaned = cleaned.replace(block, '')
  return { calls, cleaned: cleaned.trim() }
}

function tryParse(text: string): unknown {
  if (text.length === 0) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
