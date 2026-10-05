import { describe, expect, it } from 'vitest'
import type { ChatMessage, ToolCall } from '@shared/types'
import {
  enforceBudget,
  estimateMessages,
  estimateTokens,
  sanitizeToolPairing
} from '../src/main/agent/budget'

let counter = 0
function call(id: string, name = 'mcp__fs__read_file'): ToolCall {
  return { id, name, serverId: 'fs', toolName: name, args: { path: 'a' }, source: 'native' }
}

function user(content: string): ChatMessage {
  counter += 1
  return { id: `u${counter}`, role: 'user', content, createdAt: 0 }
}

function assistant(content: string, toolCalls?: ToolCall[]): ChatMessage {
  counter += 1
  return { id: `a${counter}`, role: 'assistant', content, createdAt: 0, toolCalls }
}

function toolResult(callId: string, content: string): ChatMessage {
  counter += 1
  return { id: `t${counter}`, role: 'tool', content, toolCallId: callId, createdAt: 0 }
}

describe('estimateTokens', () => {
  it('counts CJK glyphs as one token each', () => {
    expect(estimateTokens('你好世界')).toBe(4)
  })

  it('counts latin text at roughly a third of a token per character', () => {
    expect(estimateTokens('abcdefghijklmnopqrstuvwxyz')).toBeLessThanOrEqual(10)
  })

  it('grows with tool arguments', () => {
    const plain = estimateMessages([assistant('hi')])
    const withCall = estimateMessages([assistant('hi', [call('c1')])])
    expect(withCall).toBeGreaterThan(plain)
  })
})

describe('enforceBudget', () => {
  const bigResult = 'x'.repeat(4000)

  function conversation(): ChatMessage[] {
    return [
      user('first question'),
      assistant('', [call('c1', 'read_file')]),
      toolResult('c1', bigResult),
      assistant('first answer'),
      user('second question'),
      assistant('', [call('c2', 'read_file')]),
      toolResult('c2', bigResult)
    ]
  }

  it('does nothing while everything fits', () => {
    const result = enforceBudget(conversation(), 100000)
    expect(result.elided).toBe(0)
    expect(result.dropped).toBe(0)
    expect(result.exhausted).toBe(false)
  })

  it('replaces the oldest tool result before dropping anything', () => {
    const result = enforceBudget(conversation(), 1500)
    expect(result.elided).toBeGreaterThan(0)
    expect(result.messages.some((m) => m.content.startsWith('[earlier result omitted'))).toBe(true)
  })

  it('keeps every tool message paired with the call it answers', () => {
    const result = enforceBudget(conversation(), 900)
    const declared = new Set(result.messages.flatMap((m) => m.toolCalls ?? []).map((c) => c.id))
    for (const message of result.messages) {
      if (message.role !== 'tool') continue
      expect(declared.has(message.toolCallId ?? '')).toBe(true)
    }
  })

  it('never removes the most recent round', () => {
    const result = enforceBudget(conversation(), 400)
    const last = result.messages[result.messages.length - 1]
    expect(last?.role).toBe('tool')
    expect(last?.toolCallId).toBe('c2')
  })

  it('only starts dropping rounds once elision is not enough', () => {
    // Elision alone brings the conversation down to roughly 120 tokens, so a
    // budget above that must not drop anything.
    expect(enforceBudget(conversation(), 200).dropped).toBe(0)
    // Below it, the oldest complete round goes.
    const tight = enforceBudget(conversation(), 60)
    expect(tight.dropped).toBeGreaterThanOrEqual(1)
  })

  it('drops the oldest round together with its assistant declaration', () => {
    const result = enforceBudget(conversation(), 60)
    expect(result.messages.some((m) => m.toolCallId === 'c1')).toBe(false)
    expect(result.messages.some((m) => (m.toolCalls ?? []).some((c) => c.id === 'c1'))).toBe(false)
  })

  it('reports exhaustion when elision and dropping both fall short', () => {
    const huge = [user('z'.repeat(20000)), assistant('', [call('c1')]), toolResult('c1', 'y')]
    const result = enforceBudget(huge, 100)
    expect(result.exhausted).toBe(true)
    expect(result.dropped).toBe(0)
  })

  it('handles a conversation with no tool calls', () => {
    const result = enforceBudget([user('a'), assistant('b')], 100000)
    expect(result.dropped).toBe(0)
    expect(result.messages).toHaveLength(2)
  })
})

describe('sanitizeToolPairing', () => {
  it('drops a tool message whose call was never declared', () => {
    const messages = [user('hi'), toolResult('missing', 'orphan')]
    const result = sanitizeToolPairing(messages)
    expect(result.some((m) => m.role === 'tool')).toBe(false)
  })

  it('keeps a properly paired exchange untouched', () => {
    const messages = [user('hi'), assistant('', [call('c1')]), toolResult('c1', 'ok')]
    expect(sanitizeToolPairing(messages)).toHaveLength(3)
  })

  it('strips a declaration whose result never arrived', () => {
    const messages = [user('hi'), assistant('thinking', [call('c1')])]
    const result = sanitizeToolPairing(messages)
    expect(result[1]?.toolCalls).toBeUndefined()
  })

  it('keeps only the answered calls when a batch is partially resolved', () => {
    const messages = [user('hi'), assistant('', [call('c1'), call('c2')]), toolResult('c1', 'ok')]
    const result = sanitizeToolPairing(messages)
    expect(result[1]?.toolCalls?.map((c) => c.id)).toEqual(['c1'])
  })
})
