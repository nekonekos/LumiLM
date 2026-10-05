import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { tmpdir } = await import('node:os')
  return {
    app: { getPath: () => tmpdir(), getAppPath: () => process.cwd(), isPackaged: false },
    powerMonitor: { getSystemIdleTime: () => 0, on: () => undefined },
    Notification: class {
      static isSupported(): boolean {
        return true
      }
      on(): void {}
      show(): void {}
    }
  }
})

const { withoutTrailingPlaceholder } = await import('../src/main/companion/service')

import type { ChatRequestMessage } from '@shared/types'

const user: ChatRequestMessage = { role: 'user', content: '你好呀' }
const reply: ChatRequestMessage = { role: 'assistant', content: '嗯，我在呢。' }
const placeholder: ChatRequestMessage = { role: 'assistant', content: '' }

describe('withoutTrailingPlaceholder', () => {
  it('drops the empty assistant bubble the renderer leaves as a streaming target', () => {
    expect(withoutTrailingPlaceholder([user, placeholder])).toEqual([user])
  })

  it('drops every trailing empty assistant message', () => {
    expect(withoutTrailingPlaceholder([user, placeholder, { role: 'assistant', content: '  ' }])).toEqual([
      user
    ])
  })

  it('leaves a real trailing reply alone', () => {
    expect(withoutTrailingPlaceholder([user, reply])).toEqual([user, reply])
  })

  it('stops at the newest user turn, so earlier empty replies survive', () => {
    // Only the tail is a placeholder; an empty reply from earlier in the
    // conversation is history the model should still see.
    const earlier: ChatRequestMessage = { role: 'assistant', content: '' }
    expect(withoutTrailingPlaceholder([user, earlier, user, placeholder])).toEqual([user, earlier, user])
  })

  it('keeps a trailing assistant message that carries tool calls', () => {
    const withTools: ChatRequestMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'c1',
          name: 'read_file',
          serverId: null,
          toolName: 'read_file',
          args: {},
          source: 'native'
        }
      ]
    }
    expect(withoutTrailingPlaceholder([user, withTools])).toEqual([user, withTools])
  })

  it('returns the same array when there is nothing to strip', () => {
    const messages: ChatRequestMessage[] = [user]
    expect(withoutTrailingPlaceholder(messages)).toBe(messages)
  })

  it('handles an empty list', () => {
    expect(withoutTrailingPlaceholder([])).toEqual([])
  })
})
