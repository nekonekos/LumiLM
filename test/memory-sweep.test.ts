import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { tmpdir: tmp } = await import('node:os')
  return {
    app: { getPath: () => tmp(), getAppPath: () => process.cwd(), isPackaged: false },
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

const { setDataDirOverride } = await import('../src/main/store/paths')
const { settingsStore } = await import('../src/main/store/settings')
const { memoryManager } = await import('../src/main/memory/manager')
const { companionService } = await import('../src/main/companion/service')

import type { MemoryFact } from '@shared/types'

let dataDir = ''

function makeFact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  const now = Date.now()
  return {
    id: `f-${Math.random().toString(36).slice(2)}`,
    text: '用户养了一只叫小黑的猫',
    kind: 'identity',
    subject: 'user',
    importance: 3,
    confidence: 0.8,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: 0,
    useCount: 0,
    reinforcements: 0,
    occurrences: [],
    supersededBy: null,
    mergedFrom: [],
    provenance: [],
    sourceConversationId: null,
    sourceMessageIds: [],
    pinned: false,
    suppressed: false,
    archived: false,
    pending: false,
    embedding: null,
    ...overrides
  }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'lumilm-sweep-'))
  setDataDirOverride(dataDir)
  memoryManager.reset()
  settingsStore.update({ companion: { autoAcceptFacts: true } })
})

afterEach(() => {
  memoryManager.flush()
  memoryManager.reset()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('memory tidy-up', () => {
  it('suggests archiving rows the noise filters would reject today', async () => {
    memoryManager.importJson({
      version: 2,
      facts: [
        makeFact({ id: 'noise', text: '用户今天过得没有特别的事情发生。' }),
        makeFact({ id: 'inference', text: '用户感到被忽视时会有情绪反应，希望得到关注。' }),
        makeFact({ id: 'good', text: '用户在学校有一位学工处主任叫lxy，用户觉得这个人很烦人。' })
      ]
    })

    const report = await companionService.sweep()
    expect(report.scanned).toBe(3)
    expect(report.usedModel).toBe(false)
    expect(report.proposals.map((proposal) => proposal.id).sort()).toEqual(['inference', 'noise'])
    expect(report.proposals.every((proposal) => proposal.op === 'drop')).toBe(true)
  })

  it('suggests merging rows that are the same fact verbatim', async () => {
    memoryManager.importJson({
      version: 2,
      facts: [
        makeFact({ id: 'a', text: '用户不喜欢吃香菜。', importance: 2, createdAt: 1 }),
        makeFact({ id: 'b', text: '用户不喜欢吃香菜', importance: 4, createdAt: 2 })
      ]
    })

    const [proposal] = (await companionService.sweep()).proposals
    expect(proposal.op).toBe('merge')
    // The row that was reinforced more (here: the more important, newer one) wins.
    expect(proposal.targetId).toBe('b')
    expect(proposal.id).toBe('a')
    expect(proposal.reason).toBe('duplicate')
  })

  it('keeps the row the companion has actually been using', async () => {
    memoryManager.importJson({
      version: 2,
      facts: [
        makeFact({ id: 'used', text: '用户喜欢下雨天', importance: 1, useCount: 9, createdAt: 2 }),
        makeFact({ id: 'unused', text: '用户喜欢下雨天。', importance: 5, createdAt: 1 })
      ]
    })

    const [proposal] = (await companionService.sweep()).proposals
    expect(proposal.targetId).toBe('used')
    expect(proposal.id).toBe('unused')
  })

  it('never proposes two changes for the same row', async () => {
    const facts = Array.from({ length: 6 }, (_, index) =>
      makeFact({ id: `dup-${index}`, text: '用户喜欢下雨天' })
    )
    memoryManager.importJson({ version: 2, facts })

    const report = await companionService.sweep()
    const touched = report.proposals.flatMap((proposal) => [proposal.id, proposal.targetId])
    expect(new Set(touched).size).toBe(touched.length)
  })

  it('changes nothing until the suggestions are accepted', async () => {
    memoryManager.importJson({
      version: 2,
      facts: [
        makeFact({ id: 'noise', text: '用户今天过得没有特别的事情发生。' }),
        makeFact({ id: 'good', text: '用户有一只叫小黑的猫。' })
      ]
    })

    const report = await companionService.sweep()
    expect(report.proposals).toHaveLength(1)
    expect(memoryManager.getFact('noise')?.archived).toBe(false)
  })

  it('archives only what was accepted, and leaves it recoverable', async () => {
    memoryManager.importJson({
      version: 2,
      facts: [
        makeFact({ id: 'noise', text: '用户今天过得没有特别的事情发生。' }),
        makeFact({ id: 'inference', text: '用户内心缺乏安全感。' }),
        makeFact({ id: 'good', text: '用户有一只叫小黑的猫。' })
      ]
    })

    await companionService.sweep()
    companionService.applySweep(['noise'])

    expect(memoryManager.getFact('noise')?.archived).toBe(true)
    expect(memoryManager.getFact('inference')?.archived).toBe(false)
    // The reason is kept, so the library can explain why it went away.
    expect(memoryManager.getFact('noise')?.provenance.at(-1)?.op).toBe('tidied')

    memoryManager.restoreFact('noise')
    expect(memoryManager.getFact('noise')?.archived).toBe(false)
  })

  it('merges accepted duplicates and keeps the phrasing that was folded away', async () => {
    const occurrences = [
      { at: Date.now(), dateKey: '2026-03-01', note: '用户加班到很晚', conversationId: 'c1' }
    ]
    memoryManager.importJson({
      version: 2,
      facts: [
        makeFact({ id: 'keep', text: '用户加班到很晚', kind: 'event', useCount: 3, occurrences }),
        makeFact({ id: 'lose', text: '用户加班到很晚。', kind: 'event', occurrences })
      ]
    })

    await companionService.sweep()
    companionService.applySweep(['lose'])

    const keep = memoryManager.getFact('keep')
    const lose = memoryManager.getFact('lose')
    expect(keep?.mergedFrom).toEqual(['lose'])
    expect(keep?.text).toBe('用户加班到很晚')
    // The loser keeps its own row, archived and pointing at the survivor.
    expect(lose?.archived).toBe(true)
    expect(lose?.supersededBy).toBe('keep')
  })

  it('is a no-op when apply is called without a report', () => {
    memoryManager.importJson({ version: 2, facts: [makeFact({ id: 'a', text: '用户喜欢下雨天' })] })
    expect(companionService.applySweep(['a'])).toHaveLength(1)
    expect(memoryManager.getFact('a')?.archived).toBe(false)
  })
})
