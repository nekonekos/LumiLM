/**
 * Local models often emit a tool call as a fenced JSON block instead of using
 * the native `tool_calls` channel, especially at Q4 quantisation. This parser
 * recovers those calls, but only when the JSON names a tool that actually
 * exists — a code snippet in an answer must never be mistaken for a call.
 *
 * The JSON those models produce is rarely strict: `//` comments after a value
 * and a trailing comma are both common, and `JSON.parse` rejects either one
 * outright. Such a block used to be dropped silently, which looked like the
 * model refusing to use tools at all.
 */

export interface TextToolCall {
  name: string
  args: Record<string, unknown>
}

export interface TextToolParseResult {
  calls: TextToolCall[]
  /** the content the caller should record, with the call blocks and everything after them removed */
  cleaned: string
  /** names from call-shaped blocks that match no loaded tool, in order */
  unknown: string[]
}

const FENCE = /```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)```/g

/**
 * Keys that only ever appear in a tool call. A block using one of these is
 * unambiguously a call, so its parameters may also be flattened next to the name.
 */
const CALL_NAME_KEYS = ['action', 'tool', 'tool_name', 'function']
/** `name` alone is too generic: ordinary data uses it too. */
const GENERIC_NAME_KEYS = ['name']
/** Where the parameters live when they are nested. */
const ARG_KEYS = ['arguments', 'parameters', 'args', 'input']
/** Bookkeeping keys that are never tool parameters. */
const META_KEYS = new Set(['type', 'id', 'tool_call_id', 'reasoning', 'thought', 'tool_calls'])

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

/** Resolves the tool name, and whether the block is unambiguously a call. */
function readName(source: Record<string, unknown>): { name: string; key: string } | null {
  for (const key of [...CALL_NAME_KEYS, ...GENERIC_NAME_KEYS]) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return { name: value, key }
    // `{"function": {"name": ..., "arguments": ...}}` as some templates emit it.
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const nested = (value as Record<string, unknown>).name
      if (typeof nested === 'string' && nested.length > 0) return { name: nested, key }
    }
  }
  return null
}

function readArgs(
  source: Record<string, unknown>,
  nameKey: string
): Record<string, unknown> | null {
  if (typeof source.function === 'object' && source.function !== null) {
    const nested = coerceArgs((source.function as Record<string, unknown>).arguments)
    if (nested) return nested
  }
  for (const key of ARG_KEYS) {
    const args = coerceArgs(source[key])
    if (args) return args
  }

  // Flattened parameters are only accepted when the name came from a key that
  // can only mean "this is a tool": `{"name":"my-app","version":"1.0.0"}` is
  // ordinary data, not a call, and must not be executed.
  if (!CALL_NAME_KEYS.includes(nameKey)) return null

  const flat: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (key === nameKey || ARG_KEYS.includes(key) || META_KEYS.has(key)) continue
    flat[key] = value
  }
  return Object.keys(flat).length > 0 ? flat : null
}

/**
 * A block only looks like a call when it names something *and* carries
 * arguments; anything else is an ordinary JSON snippet in prose.
 */
function parseCandidate(candidate: unknown): TextToolCall | null {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return null
  const source = candidate as Record<string, unknown>

  const resolved = readName(source)
  if (!resolved) return null
  const args = readArgs(source, resolved.key)
  if (!args) return null

  return { name: resolved.name, args }
}

export function extractTextToolCalls(
  content: string,
  isKnown: (name: string) => boolean
): TextToolParseResult {
  const calls: TextToolCall[] = []
  const unknown: string[] = []
  /** index where the first accepted call block starts */
  let callStart = -1

  const consider = (raw: string, start: number): void => {
    const candidate = parseCandidate(tryParse(raw.trim()))
    if (!candidate) return
    if (!isKnown(candidate.name)) {
      if (!unknown.includes(candidate.name)) unknown.push(candidate.name)
      return
    }
    calls.push(candidate)
    if (callStart === -1) callStart = start
  }

  FENCE.lastIndex = 0
  let match = FENCE.exec(content)
  while (match) {
    consider(match[1] ?? '', match.index)
    match = FENCE.exec(content)
  }

  // Some models emit the object with no fence at all when it is the whole reply.
  if (calls.length === 0 && unknown.length === 0) {
    consider(content, 0)
    return { calls, cleaned: calls.length > 0 ? '' : content, unknown }
  }

  // Everything from the first call onwards is dropped, not just the block: a
  // model that keeps writing after a call is describing a run that has not
  // happened, and that invented text must never reach the transcript.
  const cleaned = callStart === -1 ? content : content.slice(0, callStart)
  return { calls, cleaned: cleaned.trim(), unknown }
}

/**
 * Rewrites the two things local models get wrong into something `JSON.parse`
 * accepts: `//` and block comments, and a comma before a closing brace or
 * bracket. String contents are copied verbatim, so a `//` inside a value (a URL,
 * say) survives untouched.
 *
 * Comments are removed first: the comma rule has to look at what follows the
 * comma *after* comments are gone, otherwise `".", // note` still looks like a
 * comma followed by a comment rather than a trailing comma.
 */
export function normalizeJsonish(text: string): string {
  return dropTrailingCommas(stripComments(text))
}

function stripComments(text: string): string {
  let out = ''
  let index = 0
  let inString = false
  let escaped = false

  while (index < text.length) {
    const char = text[index]!

    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      index += 1
      continue
    }

    if (char === '"') {
      inString = true
      out += char
      index += 1
      continue
    }

    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }

    if (char === '/' && text[index + 1] === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index += 2
      continue
    }

    out += char
    index += 1
  }

  return out
}

function dropTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!

    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') {
      inString = true
      out += char
      continue
    }

    if (char === ',') {
      let lookahead = index + 1
      while (lookahead < text.length && /\s/.test(text[lookahead]!)) lookahead += 1
      const following = text[lookahead]
      if (following === '}' || following === ']') continue
    }

    out += char
  }

  return out
}

function tryParse(text: string): unknown {
  if (text.length === 0) return null
  try {
    return JSON.parse(text)
  } catch {
    /* fall through to the lenient pass */
  }
  try {
    return JSON.parse(normalizeJsonish(text))
  } catch {
    return null
  }
}
