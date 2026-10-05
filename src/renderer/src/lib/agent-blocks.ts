import type { ChatMessage, MessageStats, ToolCall, ToolCallResult } from '@shared/types'
import { THINKING_BUDGET_MESSAGE } from '@shared/types'

/** One assistant step inside a turn: what it thought, said and asked for. */
export interface AgentBlock {
  id: string
  content: string
  reasoning: string
  toolCalls: ToolCall[]
  /** tool results keyed by call id */
  results: Record<string, ToolCallResult>
  stats?: MessageStats
  stopped?: boolean
  error?: string | null
  streaming?: boolean
}

/** A user request plus every step the agent took to answer it. */
export interface AgentTurn {
  id: string
  prompt: ChatMessage | null
  attachments: ChatMessage['attachments']
  blocks: AgentBlock[]
}

function emptyResult(message: ChatMessage): ToolCallResult {
  return message.toolResult ?? { ok: true, durationMs: 0, truncated: false, content: message.content }
}

/**
 * llama.cpp injects the budget nudge inside the thinking block to force the
 * model to stop, so the sentence shows up at the end of the reasoning trace.
 * It is an artefact of the harness, not something the model thought.
 */
export function stripBudgetMessage(reasoning: string): string {
  let text = reasoning
  while (text.includes(THINKING_BUDGET_MESSAGE)) {
    text = text.replace(THINKING_BUDGET_MESSAGE, '')
  }
  return text.replace(/\s+$/, '')
}

/**
 * Groups the stored transcript into agent turns.
 *
 * The transcript is still the single persisted record — this only reshapes it
 * for display, so a reload mid-turn still shows the same blocks.
 */
export function groupAgentTurns(messages: ChatMessage[]): AgentTurn[] {
  const turns: AgentTurn[] = []
  let current: AgentTurn | null = null

  for (const message of messages) {
    if (message.role === 'user') {
      current = {
        id: message.id,
        prompt: message,
        attachments: message.attachments,
        blocks: []
      }
      turns.push(current)
      continue
    }

    if (message.role === 'system') continue

    if (!current) {
      // An agent conversation always starts with a user message, but a
      // half-written file should not lose its history.
      current = { id: `orphan-${message.id}`, prompt: null, attachments: undefined, blocks: [] }
      turns.push(current)
    }

    if (message.role === 'assistant') {
      current.blocks.push({
        id: message.id,
        content: message.content,
        reasoning: stripBudgetMessage(message.reasoning ?? ''),
        toolCalls: message.toolCalls ?? [],
        results: {},
        stats: message.stats,
        stopped: message.stopped,
        error: message.error
      })
      continue
    }

    if (message.role === 'tool') {
      const block = current.blocks[current.blocks.length - 1]
      if (block && message.toolCallId) block.results[message.toolCallId] = emptyResult(message)
    }
  }

  return turns
}

/**
 * Replaces the placeholder block with the in-flight one.
 *
 * `send` already appended an empty assistant message, so the live data belongs
 * to that block rather than a new one; appending again would render the same
 * turn twice.
 */
export function applyLiveBlock(turns: AgentTurn[], live: AgentBlock | null): AgentTurn[] {
  if (!live) return turns

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex]!
    const blockIndex = turn.blocks.findIndex((block) => block.id === live.id)
    if (blockIndex === -1) continue
    const blocks = [...turn.blocks]
    blocks[blockIndex] = live
    const next = [...turns]
    next[turnIndex] = { ...turn, blocks }
    return next
  }

  const last = turns[turns.length - 1]
  if (!last) return [{ id: live.id, prompt: null, attachments: undefined, blocks: [live] }]
  return [...turns.slice(0, -1), { ...last, blocks: [...last.blocks, live] }]
}
