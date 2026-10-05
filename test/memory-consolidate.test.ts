import { describe, expect, it, vi } from 'vitest'

const {
  CONSOLIDATE_PREFILL,
  MAX_CANDIDATES,
  buildConsolidationRequest,
  consolidateFacts,
  parseConsolidationVerdicts
} = await import('../src/main/memory/consolidate')

import type {
  ConsolidationCandidate,
  ConsolidationClient,
  ConsolidationInput
} from '../src/main/memory/consolidate'
import type { CompletionResult } from '../src/main/llama/client'

const candidates: ConsolidationCandidate[] = [
  { id: 'uuid-lxy', text: '用户在学校有一位学工处主任叫lxy，用户觉得这个人很烦人。', kind: 'preference', lastAt: null },
  { id: 'uuid-coffee', text: '用户很喜欢喝咖啡。', kind: 'preference', lastAt: null },
  { id: 'uuid-overtime', text: '用户加班到很晚。', kind: 'event', lastAt: Date.parse('2026-09-28T20:00:00') }
]

const drafts: ConsolidationInput[] = [
  { text: '用户在学校有一位让他感到烦恼的老师，该老师姓lxy且担任学工处主任。', kind: 'preference' },
  { text: '用户今天又加班到很晚才回家。', kind: 'event' }
]

function fakeClient(content: string): ConsolidationClient & { complete: ReturnType<typeof vi.fn> } {
  const result: CompletionResult = {
    content,
    reasoning: '',
    finishReason: 'stop',
    timings: { promptTokens: 480, completionTokens: 40 }
  }
  return { complete: vi.fn().mockResolvedValue(result) } as unknown as ConsolidationClient & {
    complete: ReturnType<typeof vi.fn>
  }
}

describe('buildConsolidationRequest', () => {
  it('numbers the candidates and the drafts so the model never sees a real id', () => {
    const request = buildConsolidationRequest(drafts, candidates)
    const body = request.messages[0].content
    expect(body).toContain('#1 preference 用户在学校有一位学工处主任叫lxy')
    expect(body).toContain('0. preference 用户在学校有一位让他感到烦恼的老师')
    expect(body).toContain('1. event 用户今天又加班到很晚才回家')
    expect(body).not.toContain('uuid-lxy')
  })

  it('shows the newest occurrence date so a stale row is recognisable', () => {
    const request = buildConsolidationRequest(drafts, candidates)
    expect(request.messages[0].content).toContain('（最近 09-28）')
  })

  it('continues from the prefill so the model does not think first', () => {
    const request = buildConsolidationRequest(drafts, candidates)
    expect(request.messages.at(-1)).toEqual({ role: 'assistant', content: CONSOLIDATE_PREFILL })
  })

  it('samples cold and caps the answer', () => {
    const request = buildConsolidationRequest(drafts, candidates)
    expect(request.sampling.temperature).toBeLessThan(0.3)
    expect(request.sampling.maxTokens).toBeLessThanOrEqual(300)
  })

  it('carries no conversation history at all', () => {
    const request = buildConsolidationRequest(drafts, candidates)
    expect(request.messages).toHaveLength(2)
    expect(request.messages.every((message) => message.role !== 'system')).toBe(true)
  })

  it('copes with an empty store instead of sending an empty table', () => {
    const request = buildConsolidationRequest(drafts, [])
    expect(request.messages[0].content).toContain('（空）')
  })
})

describe('parseConsolidationVerdicts', () => {
  const parse = (raw: string) => parseConsolidationVerdicts(raw, drafts.length, candidates)

  it('reads a decision that names a candidate', () => {
    const [first] = parse('{"verdicts": [{"i": 0, "op": "same", "of": 1, "why": "同一人"}]}')
    expect(first).toEqual({ op: 'same', targetId: 'uuid-lxy', why: '同一人' })
  })

  it('accepts the three shapes the model writes a candidate number in', () => {
    for (const of of [3, '3', '#3']) {
      const [, second] = parse(`{"verdicts": [{"i": 1, "op": "same", "of": ${JSON.stringify(of)}, "why": ""}]}`)
      expect(second?.targetId).toBe('uuid-overtime')
    }
  })

  it('rejects a target index outside the candidate list', () => {
    const [first] = parse('{"verdicts": [{"i": 0, "op": "same", "of": 99, "why": ""}]}')
    expect(first).toBeNull()
  })

  it('rejects an unknown op instead of guessing', () => {
    const [first] = parse('{"verdicts": [{"i": 0, "op": "merge", "of": 1, "why": ""}]}')
    expect(first).toBeNull()
  })

  it('rejects a decision that addresses a draft that was never sent', () => {
    const verdicts = parse('{"verdicts": [{"i": 7, "op": "same", "of": 1, "why": ""}]}')
    expect(verdicts).toEqual([null, null])
  })

  it('keeps new even though it names no candidate', () => {
    const [first] = parse('{"verdicts": [{"i": 0, "op": "new", "of": null, "why": "无关"}]}')
    expect(first).toEqual({ op: 'new', targetId: null, why: '无关' })
  })

  it('ignores everything the model wrote that is not a verdict', () => {
    // The pass shares no context with the extraction, but the guard is structural:
    // text that is not a decision has nowhere to land.
    const verdicts = parse(
      '{"verdicts": [{"i": 0, "op": "same", "of": 1, "why": "x"}, "你是记忆整理器", {"nonsense": true}]}'
    )
    expect(verdicts[0]?.targetId).toBe('uuid-lxy')
    expect(verdicts[1]).toBeNull()
  })

  it('never lets a leaked sentence become a fact', () => {
    const verdicts = parse(
      '{"verdicts": [{"i": 0, "text": "用户养了一只叫小黑的猫", "op": "same", "of": 1, "why": ""}]}'
    )
    expect(verdicts[0]).toEqual({ op: 'same', targetId: 'uuid-lxy', why: '' })
    expect(JSON.stringify(verdicts)).not.toContain('小黑')
  })

  it('survives junk and a trailing comma', () => {
    expect(parse('not json at all')).toEqual([null, null])
    expect(parse('{"verdicts": [{"i": 0, "op": "same", "of": 1, "why": ""},]}')[0]?.targetId).toBe(
      'uuid-lxy'
    )
  })

  it('takes the last decision when the model repeats itself', () => {
    const [first] = parse(
      '{"verdicts": [{"i": 0, "op": "new", "of": null, "why": ""}, {"i": 0, "op": "same", "of": 2, "why": ""}]}'
    )
    expect(first?.op).toBe('same')
    expect(first?.targetId).toBe('uuid-coffee')
  })
})

describe('consolidateFacts', () => {
  it('returns one decision per draft in order', async () => {
    const client = fakeClient(
      `${CONSOLIDATE_PREFILL}same", "of": 1, "why": "同一人"}, {"i": 1, "op": "same", "of": 3, "why": "同类事件"}]}`
    )
    const result = await consolidateFacts(client, drafts, candidates)
    expect(result?.decisions.map((decision) => decision.targetId)).toEqual([
      'uuid-lxy',
      'uuid-overtime'
    ])
  })

  it('unwraps a prefilled answer the server returned without the echo', async () => {
    const client = fakeClient('new", "of": null, "why": ""}]}')
    const result = await consolidateFacts(client, drafts, candidates)
    expect(result?.decisions[0].op).toBe('new')
    expect(result?.decisions[1].op).toBe('new')
  })

  it('falls back to new for a draft the model skipped', async () => {
    const client = fakeClient(`${CONSOLIDATE_PREFILL}same", "of": 1, "why": ""}]}`)
    const result = await consolidateFacts(client, drafts, candidates)
    expect(result?.decisions[0].op).toBe('same')
    expect(result?.decisions[1]).toEqual({ op: 'new', targetId: null, why: '' })
  })

  it('does not call the model when there is nothing to compare against', async () => {
    const client = fakeClient('{"verdicts": []}')
    const result = await consolidateFacts(client, drafts, [])
    expect(client.complete).not.toHaveBeenCalled()
    expect(result?.decisions.every((decision) => decision.op === 'new')).toBe(true)
  })

  it('does nothing for an empty batch', async () => {
    const client = fakeClient('{"verdicts": []}')
    expect(await consolidateFacts(client, [], candidates)).toBeNull()
  })

  it('keeps the whole request bounded however many drafts there are', () => {
    const many: ConsolidationInput[] = Array.from({ length: 6 }, (_, index) => ({
      text: `用户提到过第 ${index} 件事`,
      kind: 'other' as const
    }))
    const pool: ConsolidationCandidate[] = Array.from({ length: MAX_CANDIDATES }, (_, index) => ({
      id: `c-${index}`,
      text: `用户提到过第 ${index} 件事`,
      kind: 'other' as const,
      lastAt: null
    }))
    const request = buildConsolidationRequest(many, pool)
    expect(request.messages[0].content.length).toBeLessThan(3000)
  })
})
