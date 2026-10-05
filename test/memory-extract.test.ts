import { describe, expect, it, vi } from 'vitest'

const {
  FACTS_PREFILL,
  buildExtractionRequest,
  dominantScript,
  extractFacts,
  extractRelationship,
  buildRollingSummary,
  parseExtraction,
  readFacts,
  readRelationship,
  readSummary,
  withPrefill,
  ExtractionQueue
} = await import('../src/main/memory/extract')

import type { CompletionClient } from '../src/main/memory/extract'
import type { CompletionResult } from '../src/main/llama/client'
import type { ChatRequestMessage } from '@shared/types'

const history: ChatRequestMessage[] = [
  { role: 'system', content: '你是 Lumi。' },
  { role: 'user', content: '我养了一只叫小黑的猫，而且我讨厌香菜。' },
  { role: 'assistant', content: '小黑这名字真好听。' }
]

type FakeClient = CompletionClient & { complete: ReturnType<typeof vi.fn> }

function fakeClient(content: string): FakeClient {
  const result: CompletionResult = {
    content,
    reasoning: '',
    finishReason: 'stop',
    timings: { promptTokens: 180, completionTokens: 24 }
  }
  return { complete: vi.fn().mockResolvedValue(result) } as unknown as FakeClient
}

const options = { history, systemPrompt: '你是 Lumi。' }

describe('buildExtractionRequest', () => {
  it('replays the finished turn verbatim and appends the instruction plus prefill', () => {
    const request = buildExtractionRequest(options, 'do the thing', FACTS_PREFILL)
    expect(request.messages.slice(0, history.length)).toEqual(history)
    expect(request.messages[history.length].role).toBe('user')
    expect(request.messages[history.length].content).toContain('do the thing')
    expect(request.messages[history.length + 1]).toEqual({
      role: 'assistant',
      content: FACTS_PREFILL
    })
  })

  it('builds the instruction in the conversation language', () => {
    const zh = buildExtractionRequest(
      { history: [{ role: 'user', content: '我住在杭州，养了一只叫小黑的猫。' }], systemPrompt: '' },
      'index the facts',
      FACTS_PREFILL
    )
    expect(zh.messages.at(-1)?.content).toBe(FACTS_PREFILL)
    expect(zh.messages.at(-2)?.content).toContain('必须用中文书写')

    const en = buildExtractionRequest(
      { history: [{ role: 'user', content: 'I live in Hangzhou.' }], systemPrompt: '' },
      'index the facts',
      FACTS_PREFILL
    )
    expect(en.messages.at(-2)?.content).toContain('Write every "text" value in English')

    const ja = buildExtractionRequest(
      { history: [{ role: 'user', content: '私は杭州に住んでいます。' }], systemPrompt: '' },
      'index the facts',
      FACTS_PREFILL
    )
    expect(ja.messages.at(-2)?.content).toContain('日本語で書いてください')
  })

  it('ignores the assistant turns when picking the language', () => {
    expect(
      dominantScript([
        { role: 'user', content: '你好' },
        { role: 'assistant', content: 'Hello there, nice to meet you today.' }
      ])
    ).toBe('zh')
  })

  it('samples cold so the extractor never gets creative', () => {
    const request = buildExtractionRequest(options, 'x', FACTS_PREFILL)
    expect(request.sampling.temperature).toBeLessThan(0.3)
    expect(request.sampling.maxTokens).toBe(400)
  })
})

describe('parseExtraction', () => {
  it('reads plain json', () => {
    expect(parseExtraction('{"facts": []}')).toEqual({ facts: [] })
  })

  it('repairs a trailing comma', () => {
    expect(parseExtraction('{"facts": [{"text": "a"},]}')).toEqual({ facts: [{ text: 'a' }] })
  })

  it('repairs a raw newline the model left inside a string', () => {
    const raw = '{"facts": [{"text": "用户住在杭州",\n"kind": "identity"}]}'
    expect(parseExtraction(raw)).toEqual({
      facts: [{ text: '用户住在杭州', kind: 'identity' }]
    })
  })

  it('repairs a raw newline that landed mid-value', () => {
    const raw = '{"summary": "第一行\n第二行"}'
    expect(parseExtraction(raw)).toEqual({ summary: '第一行\n第二行' })
  })

  it('repairs output that was cut off before it closed', () => {
    expect(parseExtraction('{"facts": [{"text": "a"}')).toEqual({ facts: [{ text: 'a' }] })
  })

  it('repairs a string cut off mid-quote', () => {
    const parsed = parseExtraction('{"text": "unfinished') as { text: string }
    expect(parsed.text).toBe('unfinished')
  })

  it('returns null for text with no json in it', () => {
    expect(parseExtraction('I am not going to do that.')).toBeNull()
  })
})

describe('readFacts', () => {
  it('reads the documented shape', () => {
    const facts = readFacts({
      facts: [{ text: '用户养了一只叫小黑的猫', kind: 'identity', subject: 'user', importance: 4, confidence: 0.9 }]
    })
    expect(facts).toHaveLength(1)
    expect(facts[0].kind).toBe('identity')
    expect(facts[0].importance).toBe(4)
  })

  it('accepts the key drift local models produce', () => {
    const facts = readFacts({ items: [{ fact: '用户讨厌香菜', type: 'preference', weight: 9 }] })
    expect(facts[0].text).toBe('用户讨厌香菜')
    expect(facts[0].kind).toBe('preference')
    expect(facts[0].importance).toBe(5)
  })

  it('falls back to other/user for values outside the enums', () => {
    const facts = readFacts([{ text: '用户喜欢喝茶', kind: 'nonsense', subject: 'nobody' }])
    expect(facts[0].kind).toBe('other')
    expect(facts[0].subject).toBe('user')
  })

  it('accepts a bare array and a single object', () => {
    expect(readFacts([{ text: '用户喜欢喝茶' }])).toHaveLength(1)
    expect(readFacts({ text: '用户喜欢喝茶' })).toHaveLength(1)
  })

  it('drops entries with no usable text', () => {
    expect(readFacts([{ kind: 'identity' }, { text: '   ' }, null, 'nope'])).toEqual([])
  })

  it('caps the number of facts per turn', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ text: `记忆条目第 ${index} 条` }))
    expect(readFacts(many).length).toBeLessThanOrEqual(6)
  })

  it('removes duplicates', () => {
    expect(readFacts([{ text: '同一件事' }, { text: '同一件事' }])).toHaveLength(1)
  })

  it('returns nothing for junk', () => {
    expect(readFacts(null)).toEqual([])
    expect(readFacts('a string')).toEqual([])
    expect(readFacts(42)).toEqual([])
  })
})

describe('withPrefill', () => {
  it('starts the first fact so the model cannot close an empty list', () => {
    expect(FACTS_PREFILL).toContain('"text": "')
  })

  it('does not double the prefix when the server echoes the assistant turn', () => {
    const whole = `${FACTS_PREFILL}用户养了一只猫"}]\n}`
    expect(withPrefill(FACTS_PREFILL, whole)).toBe(whole)
  })

  it('adds the prefix when the server returns only the continuation', () => {
    expect(withPrefill(FACTS_PREFILL, '用户养了一只猫"}]\n}')).toBe(
      `${FACTS_PREFILL}用户养了一只猫"}]\n}`
    )
  })

  it('tolerates leading whitespace in the echo', () => {
    const whole = `${FACTS_PREFILL}用户养了一只猫"}]}`
    expect(withPrefill(FACTS_PREFILL, `  ${whole}`)).toBe(whole)
  })
})

describe('extractFacts', () => {
  it('reads the continuation after the prefill', async () => {
    const client = fakeClient(
      `${FACTS_PREFILL}用户养了一只叫小黑的猫", "kind": "identity", "subject": "user", "importance": 4, "confidence": 0.9}]}`
    )
    const result = await extractFacts(client, options)
    expect(result.drafts).toHaveLength(1)
    expect(result.drafts[0].text).toBe('用户养了一只叫小黑的猫')
  })

  it('reads a continuation the server returned without the echo', async () => {
    const client = fakeClient('用户讨厌香菜", "kind": "preference", "importance": 3}]}')
    const result = await extractFacts(client, options)
    expect(result.drafts.map((draft) => draft.text)).toEqual(['用户讨厌香菜'])
  })

  it('salvages facts when the list was never closed', async () => {
    const client = fakeClient(
      `${FACTS_PREFILL}用户讨厌香菜", "kind": "preference", "importance": 3}, {"text": "用户养了一只叫小黑的猫", "kind": "identity"`
    )
    const result = await extractFacts(client, options)
    expect(result.drafts.map((draft) => draft.text)).toEqual([
      '用户讨厌香菜',
      '用户养了一只叫小黑的猫'
    ])
  })

  it('reports nothing for an empty list', async () => {
    const client = fakeClient(`${FACTS_PREFILL}""}]}`)
    const result = await extractFacts(client, options)
    expect(result.drafts).toEqual([])
    expect(result.empty).toBe(true)
  })

  it('drops a fact the model hedged or admitted inferring', () => {
    const drafts = readFacts([
      { text: '用户养了某种宠物。' },
      { text: '用户养了只猫（根据描述推断，但用户未明确说明）。' },
      { text: '用户可能住在杭州。' },
      { text: 'The user probably owns a cat.' },
      { text: '用户养了一只名叫小黑的猫。' }
    ])
    expect(drafts.map((draft) => draft.text)).toEqual(['用户养了一只名叫小黑的猫。'])
  })

  it('drops a null text value without inventing a fact', () => {
    expect(readFacts([{ text: null }, { text: 42 }])).toEqual([])
  })

  it('discards a refusal instead of storing it as a fact', async () => {
    const client = fakeClient('I cannot help with that.')
    const result = await extractFacts(client, options)
    expect(result.drafts).toEqual([])
    expect(result.empty).toBe(false)
  })

  it('discards a fragment that is too short to be a sentence', async () => {
    const client = fakeClient(`${FACTS_PREFILL}嗯"}]}`)
    expect((await extractFacts(client, options)).drafts).toEqual([])
  })

  it('turns the cache on and pins the persona when the caller knows its length', async () => {
    const client = fakeClient(`${FACTS_PREFILL}""}]}`)
    await extractFacts(client, { ...options, nKeep: 128 })
    const [, callOptions] = client.complete.mock.calls[0]
    expect(callOptions.extraBody).toEqual({ cache_prompt: true, n_keep: 128 })
  })

  it('makes exactly one call per turn, even when it finds nothing', async () => {
    const client = fakeClient(`${FACTS_PREFILL}""}]}`)
    const result = await extractFacts(client, options)
    expect(client.complete).toHaveBeenCalledTimes(1)
    expect(result.drafts).toEqual([])
    expect(result.empty).toBe(true)
  })

  it('reads only the user statements, never the assistant turns', async () => {
    const client = fakeClient('{"facts": [{"text": "用户养了一只叫小黑的猫"}]}')
    await extractFacts(client, {
      ...options,
      history: [
        { role: 'system', content: '你是 Lumi。' },
        { role: 'user', content: '我养了一只叫小黑的猫' },
        { role: 'assistant', content: '小黑这名字真好听。' },
        { role: 'user', content: '它很调皮' }
      ]
    })

    const [request] = client.complete.mock.calls[0]
    const sent = request.messages.slice(0, -2)
    expect(sent).toEqual([{ role: 'user', content: '我养了一只叫小黑的猫\n它很调皮' }])
  })

  it('skips the call entirely when the user said nothing at all', async () => {
    const client = fakeClient('{"facts": []}')
    const result = await extractFacts(client, {
      ...options,
      history: [{ role: 'assistant', content: '你好呀。' }]
    })
    expect(client.complete).not.toHaveBeenCalled()
    expect(result.empty).toBe(true)
  })

  it('does not strip an injected memory block itself, so the caller must pass a clean history', async () => {
    // Documents the contract between `scheduleExtraction` and this module: the
    // injection is appended to the newest *user* message, so role filtering
    // cannot remove it. The caller owns that, and `CompanionTurnPlan`
    // .cleanMessages exists for it.
    const injected: ChatRequestMessage[] = [
      { role: 'user', content: '我养了一只叫小黑的猫\n\n## 你记得的事\n- 用户住在杭州。' }
    ]
    const client = fakeClient('{"facts": [{"text": "用户养了一只叫小黑的猫"}]}')
    await extractFacts(client, { ...options, history: injected })

    const [request] = client.complete.mock.calls[0]
    expect(request.messages[0].content).toContain('你记得的事')
  })
})

describe('extractRelationship', () => {
  it('reads the continuation after the prefill', async () => {
    const client = fakeClient('{"mood": "开心", "nickname": "宝贝", "stage": "亲密的伴侣", "affinity": 72}')
    const { patch } = await extractRelationship(client, options)
    expect(patch.mood).toBe('开心')
    expect(patch.nicknameForUser).toBe('宝贝')
    expect(patch.affinity).toBe(72)
  })

  it('clamps affinity and ignores junk', () => {
    expect(readRelationship({ affinity: 900 }).affinity).toBe(100)
    expect(readRelationship({ affinity: -5 }).affinity).toBe(0)
    expect(readRelationship({ mood: 42 }).mood).toBeUndefined()
    expect(readRelationship(null)).toEqual({})
  })

  it('leaves the nickname alone when the model returns null', () => {
    expect(readRelationship({ nickname: null }).nicknameForUser).toBeUndefined()
  })
})

describe('buildRollingSummary', () => {
  it('reads the continuation after the prefill', async () => {
    const client = fakeClient('{"summary": "你们聊了小黑和香菜。"}')
    expect(await buildRollingSummary(client, options)).toBe('你们聊了小黑和香菜。')
  })

  it('returns null when there is nothing usable', () => {
    expect(readSummary({})).toBeNull()
    expect(readSummary(12)).toBeNull()
  })

  it('accepts a bare string payload', () => {
    expect(readSummary('你们聊了猫。')).toBe('你们聊了猫。')
  })
})

describe('ExtractionQueue', () => {
  it('runs the job once after the delay', async () => {
    vi.useFakeTimers()
    try {
      const run = vi.fn().mockResolvedValue(undefined)
      const queue = new ExtractionQueue(run, () => 600)
      queue.schedule({ conversationId: 'c1', options })

      expect(run).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(599)
      expect(run).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(run).toHaveBeenCalledTimes(1)
      queue.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('replaces a pending job with the newer one', async () => {
    vi.useFakeTimers()
    try {
      const run = vi.fn().mockResolvedValue(undefined)
      const queue = new ExtractionQueue(run, () => 100)
      queue.schedule({ conversationId: 'c1', options })
      queue.schedule({ conversationId: 'c2', options })
      await vi.advanceTimersByTimeAsync(200)
      expect(run).toHaveBeenCalledTimes(1)
      expect(run.mock.calls[0][0].conversationId).toBe('c2')
      queue.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the job when the user types again', async () => {
    vi.useFakeTimers()
    try {
      const run = vi.fn().mockResolvedValue(undefined)
      const queue = new ExtractionQueue(run, () => 600)
      queue.schedule({ conversationId: 'c1', options })
      queue.cancel()
      await vi.advanceTimersByTimeAsync(2000)
      expect(run).not.toHaveBeenCalled()
      expect(queue.busy).toBe(false)
      queue.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('swallows a failing job', async () => {
    vi.useFakeTimers()
    try {
      const run = vi.fn().mockRejectedValue(new Error('server gone'))
      const queue = new ExtractionQueue(run, () => 0)
      queue.schedule({ conversationId: 'c1', options })
      await vi.advanceTimersByTimeAsync(10)
      expect(run).toHaveBeenCalledTimes(1)
      expect(queue.busy).toBe(false)
      queue.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('can be flushed on demand by the dream job', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const queue = new ExtractionQueue(run, () => 10_000)
    queue.schedule({ conversationId: 'c1', options })
    await queue.flushNow()
    expect(run).toHaveBeenCalledTimes(1)
    queue.dispose()
  })
})
