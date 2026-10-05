import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/types'
import { THINKING_BUDGET_MESSAGE } from '@shared/types'
import { applyLiveBlock, groupAgentTurns, stripBudgetMessage } from '../src/renderer/src/lib/agent-blocks'

let seq = 0
function message(partial: Partial<ChatMessage> & Pick<ChatMessage, 'role'>): ChatMessage {
  seq += 1
  return {
    id: `m${seq}`,
    content: '',
    createdAt: seq,
    ...partial
  } as ChatMessage
}

describe('stripBudgetMessage', () => {
  it('removes the harness nudge appended to the reasoning', () => {
    const reasoning = '\nOkay, they want a listing, which means I should useStop thinking and give your final answer now.'
    expect(stripBudgetMessage(reasoning)).toBe(
      '\nOkay, they want a listing, which means I should use'
    )
  })

  it('removes it wherever it appears, not just at the end', () => {
    const text = `a${THINKING_BUDGET_MESSAGE}b${THINKING_BUDGET_MESSAGE}c`
    expect(stripBudgetMessage(text)).toBe('abc')
  })

  it('leaves ordinary reasoning untouched', () => {
    expect(stripBudgetMessage('I should list the files.')).toBe('I should list the files.')
  })

  it('trims the trailing whitespace left behind', () => {
    expect(stripBudgetMessage(`thought ${THINKING_BUDGET_MESSAGE}\n  `)).toBe('thought')
  })
})

describe('groupAgentTurns', () => {
  it('puts a prompt and the answer in the same turn', () => {
    const messages = [
      message({ role: 'user', content: 'list my files' }),
      message({ role: 'assistant', content: 'Done.' })
    ]
    const turns = groupAgentTurns(messages)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.prompt?.content).toBe('list my files')
    expect(turns[0]?.blocks).toHaveLength(1)
    expect(turns[0]?.blocks[0]?.content).toBe('Done.')
  })

  it('keeps every step of one turn together', () => {
    const messages = [
      message({ role: 'user', content: 'go' }),
      message({ role: 'assistant', content: 'thinking', toolCalls: [] }),
      message({ role: 'tool', content: 'a.txt', toolCallId: 'call_1' }),
      message({ role: 'assistant', content: 'There is one file.' })
    ]
    const turns = groupAgentTurns(messages)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.blocks).toHaveLength(2)
  })

  it('attaches a tool result to the call that produced it', () => {
    const messages = [
      message({ role: 'user', content: 'go' }),
      message({
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'read_file',
            serverId: null,
            toolName: 'read_file',
            args: {},
            source: 'native'
          }
        ]
      }),
      message({
        role: 'tool',
        content: 'hello',
        toolCallId: 'call_1',
        toolResult: { ok: true, durationMs: 5, truncated: false, content: 'hello' }
      })
    ]
    const turns = groupAgentTurns(messages)
    expect(turns[0]?.blocks[0]?.results.call_1?.content).toBe('hello')
  })

  it('starts a new turn for each prompt', () => {
    const messages = [
      message({ role: 'user', content: 'one' }),
      message({ role: 'assistant', content: 'first' }),
      message({ role: 'user', content: 'two' }),
      message({ role: 'assistant', content: 'second' })
    ]
    const turns = groupAgentTurns(messages)
    expect(turns.map((turn) => turn.prompt?.content)).toEqual(['one', 'two'])
  })

  it('skips system messages', () => {
    const messages = [
      message({ role: 'system', content: 'no prompt was injected' }),
      message({ role: 'user', content: 'hi' })
    ]
    expect(groupAgentTurns(messages)).toHaveLength(1)
  })

  it('does not lose a transcript that starts with an assistant message', () => {
    const turns = groupAgentTurns([message({ role: 'assistant', content: 'orphan' })])
    expect(turns).toHaveLength(1)
    expect(turns[0]?.blocks[0]?.content).toBe('orphan')
  })
})

describe('applyLiveBlock', () => {
  const messages = [
    message({ role: 'user', content: 'go' }),
    message({ role: 'assistant', content: '' })
  ]

  it('replaces the placeholder the send already appended', () => {
    const turns = groupAgentTurns(messages)
    const placeholderId = turns[0]?.blocks[0]?.id ?? ''
    const next = applyLiveBlock(turns, {
      id: placeholderId,
      content: 'partial',
      reasoning: '',
      toolCalls: [],
      results: {},
      streaming: true
    })
    expect(next).toHaveLength(1)
    expect(next[0]?.blocks).toHaveLength(1)
    expect(next[0]?.blocks[0]?.content).toBe('partial')
    expect(next[0]?.blocks[0]?.streaming).toBe(true)
  })

  it('appends a block that is not in the transcript yet', () => {
    const turns = groupAgentTurns(messages)
    const next = applyLiveBlock(turns, {
      id: 'brand-new',
      content: 'step 2',
      reasoning: '',
      toolCalls: [],
      results: {}
    })
    expect(next[0]?.blocks).toHaveLength(2)
    expect(next[0]?.blocks[1]?.content).toBe('step 2')
  })

  it('is a no-op without a live block', () => {
    const turns = groupAgentTurns(messages)
    expect(applyLiveBlock(turns, null)).toBe(turns)
  })
})
