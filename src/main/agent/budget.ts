import type { MessageRole, ToolCall } from '@shared/types'
import { logger } from '../util/logger'

/**
 * Structural shape shared by `ChatMessage` (renderer/persistence) and
 * `ChatRequestMessage` (what goes on the wire). The budget and pairing rules
 * only care about roles, content and tool linkage.
 */
export interface BudgetMessage {
  role: MessageRole
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
}

/**
 * Rough token estimate matching the renderer's heuristic: CJK glyphs count as
 * one token, latin characters as roughly 1/3.6. Cheap enough to run on every
 * budget check, unlike a round trip to `/tokenize`.
 */
export function estimateTokens(text: string): number {
  let wide = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code !== undefined && code > 0x2e80) wide += 1
  }
  return Math.ceil(wide + (text.length - wide) / 3.6)
}

export function estimateMessages(messages: BudgetMessage[]): number {
  let total = 0
  for (const message of messages) {
    total += estimateTokens(message.content) + 8
    for (const call of message.toolCalls ?? []) {
      total += estimateTokens(JSON.stringify(call.args)) + 12
    }
  }
  return total
}

export interface BudgetResult<T> {
  messages: T[]
  /** tool results replaced by a one line placeholder */
  elided: number
  /** whole tool rounds removed */
  dropped: number
  /** true when even the last round does not fit */
  exhausted: boolean
}

/** The slice of messages belonging to one assistant tool-calling round. */
function roundBounds(
  messages: BudgetMessage[],
  index: number
): { start: number; end: number } | null {
  const message = messages[index]
  if (!message || message.role !== 'assistant' || (message.toolCalls?.length ?? 0) === 0) return null
  let end = index
  while (end + 1 < messages.length && messages[end + 1]?.role === 'tool') end += 1
  return { start: index, end }
}

function toolNameFor(messages: BudgetMessage[], toolCallId: string | undefined): string {
  if (!toolCallId) return 'tool'
  for (const message of messages) {
    const match = message.toolCalls?.find((call) => call.id === toolCallId)
    if (match) return match.toolName
  }
  return 'tool'
}

/**
 * Shrinks a message list until it fits the budget.
 *
 * llama.cpp renders the chat template from these messages, and a `tool`
 * message whose `assistant` counterpart is missing produces a broken prompt.
 * So results are first replaced in place (the pair survives), and only then are
 * whole rounds removed together. The newest round is never removed.
 */
export function enforceBudget<T extends BudgetMessage>(
  messages: T[],
  budget: number,
  keepMin = 2
): BudgetResult<T> {
  let working: T[] = [...messages]
  let elided = 0
  let dropped = 0

  const over = (): boolean => estimateMessages(working) > budget

  // Stage 1: replace the oldest tool results with a short placeholder.
  let cursor = 0
  while (over() && cursor < working.length) {
    const message = working[cursor]
    if (message && message.role === 'tool' && !message.content.startsWith('[earlier result')) {
      const name = toolNameFor(working, message.toolCallId)
      working[cursor] = {
        ...message,
        content: `[earlier result omitted: ${name} → ${message.content.length} chars]`
      } as T
      elided += 1
    }
    cursor += 1
  }

  // Stage 2: drop the oldest complete round, never the most recent one.
  const lastRoundStart = (): number => {
    for (let index = working.length - 1; index >= 0; index -= 1) {
      if (roundBounds(working, index)) return index
    }
    return -1
  }

  while (over()) {
    const keepFrom = lastRoundStart()
    if (keepFrom < 0) break

    let removed = false
    for (let index = 0; index < keepFrom; index += 1) {
      const bounds = roundBounds(working, index)
      if (!bounds) continue
      if (working.length - (bounds.end - bounds.start + 1) < keepMin) break
      working = [...working.slice(0, bounds.start), ...working.slice(bounds.end + 1)]
      dropped += 1
      removed = true
      break
    }
    if (!removed) break
  }

  const exhausted = over()
  if (elided > 0 || dropped > 0) {
    logger.info(
      'agent',
      `context budget: elided ${elided} result(s), dropped ${dropped} round(s)${exhausted ? ', still over budget' : ''}`
    )
  }

  return { messages: working, elided, dropped, exhausted }
}

/**
 * Drops anything that would break the tool-call pairing contract. Used as a
 * final safety net before a request goes out.
 */
export function sanitizeToolPairing<T extends BudgetMessage>(messages: T[]): T[] {
  const declared = new Set<string>()
  const result: T[] = []

  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) declared.add(call.id)
      result.push(message)
      continue
    }
    if (message.role === 'tool') {
      // A tool message with no visible call would break the jinja template.
      if (!message.toolCallId || !declared.has(message.toolCallId)) {
        logger.warn('agent', 'dropping orphan tool message')
        continue
      }
      result.push(message)
      continue
    }
    result.push(message)
  }

  // Conversely, an assistant that declares calls whose results are gone is also
  // invalid, so strip the declarations that have no answer.
  return result.map((message, index) => {
    if (message.role !== 'assistant' || (message.toolCalls?.length ?? 0) === 0) return message
    const answered = new Set<string>()
    for (let next = index + 1; next < result.length && result[next]?.role === 'tool'; next += 1) {
      const id = result[next]?.toolCallId
      if (id) answered.add(id)
    }
    const remaining = message.toolCalls?.filter((call) => answered.has(call.id)) ?? []
    if (remaining.length === message.toolCalls?.length) return message
    return { ...message, toolCalls: remaining.length > 0 ? remaining : undefined } as T
  })
}
