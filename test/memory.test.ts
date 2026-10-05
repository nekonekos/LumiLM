import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The stores resolve their files through electron's app paths.
vi.mock('electron', async () => {
  const { tmpdir: tmp } = await import('node:os')
  return {
    app: { getPath: () => tmp(), getAppPath: () => process.cwd(), isPackaged: false }
  }
})

const { setDataDirOverride, getPaths } = await import('../src/main/store/paths')
const { settingsStore } = await import('../src/main/store/settings')
const { JsonMemoryStore, normalizeSnapshot, normalizeFact } = await import(
  '../src/main/memory/store'
)
const { LexicalIndex, tokenizeText, textSimilarity } = await import(
  '../src/main/memory/lexical-index'
)
const { memoryManager } = await import('../src/main/memory/manager')

import type { LexicalIndex as LexicalIndexType } from '../src/main/memory/lexical-index'
import type { MemoryFact, MemorySnapshot } from '@shared/types'
import { MAX_FACT_OCCURRENCES } from '@shared/types'

let dataDir = ''

function freshDataDir(): void {
  dataDir = mkdtempSync(join(tmpdir(), 'lumilm-memory-'))
  setDataDirOverride(dataDir)
  memoryManager.reset()
}

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
  freshDataDir()
  settingsStore.update({
    companion: { autoAcceptFacts: true, recallCount: 4, memoryEnabled: true }
  })
})

afterEach(() => {
  // The memory store writes through an unref'd debounced timer, which would
  // recreate this directory after it has been removed. Cancel it first.
  memoryManager.flush()
  memoryManager.reset()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('tokenizeText', () => {
  it('turns a run of CJK characters into bigrams', () => {
    expect(tokenizeText('小黑')).toEqual(['小黑'])
    expect(tokenizeText('我讨厌香菜')).toEqual(['我讨', '讨厌', '厌香', '香菜'])
  })

  it('keeps latin words and drops single characters', () => {
    expect(tokenizeText('I love Cilantro a lot')).toEqual(['love', 'cilantro', 'lot'])
  })

  it('splits mixed scripts and does not emit a bigram across the boundary', () => {
    expect(tokenizeText('小黑cat')).toEqual(['cat', '小黑'])
  })
})

describe('normalizeSnapshot', () => {
  it('returns an empty snapshot for junk input', () => {
    const snapshot = normalizeSnapshot(null)
    expect(snapshot.facts).toEqual([])
    expect(snapshot.episodes).toEqual([])
  })

  it('drops rows without an id or text', () => {
    const snapshot = normalizeSnapshot({
      facts: [{ id: 'a', text: 'ok' }, { text: 'no id' }, { id: 'b', text: '   ' }]
    })
    expect(snapshot.facts.map((fact) => fact.id)).toEqual(['a'])
  })

  it('clamps importance and confidence into range', () => {
    const fact = normalizeFact({ id: 'a', text: 'x', importance: 99, confidence: 4 })
    expect(fact?.importance).toBe(5)
    expect(fact?.confidence).toBe(1)
  })

  it('defaults a missing relationship and keeps a stored one', () => {
    expect(normalizeSnapshot({}).relationship.stage).toBe('亲近的伴侣')
    const stored = normalizeSnapshot({ relationship: { stage: '同事', affinity: 12 } })
    expect(stored.relationship.stage).toBe('同事')
    expect(stored.relationship.affinity).toBe(12)
  })
})

describe('JsonMemoryStore', () => {
  it('round-trips through disk', () => {
    const file = join(dataDir, 'memory.json')
    const store = new JsonMemoryStore(file, 0)
    const snapshot: MemorySnapshot = normalizeSnapshot({ facts: [makeFact({ id: 'a' })] })
    store.save(snapshot)
    store.flush()

    const reloaded = new JsonMemoryStore(file, 0).load()
    expect(reloaded.facts.map((fact) => fact.id)).toEqual(['a'])
  })

  it('recovers from the backup when the file is corrupt', () => {
    const file = join(dataDir, 'memory.json')
    const store = new JsonMemoryStore(file, 0)
    store.save(normalizeSnapshot({ facts: [makeFact({ id: 'a' })] }))
    store.flush()
    // Second write moves the good file to .bak.
    store.save(normalizeSnapshot({ facts: [makeFact({ id: 'b' })] }))
    store.flush()
    writeFileSync(file, '{ this is not json', 'utf8')

    const reloaded = new JsonMemoryStore(file, 0).load()
    expect(reloaded.facts.map((fact) => fact.id)).toEqual(['a'])
  })

  it('creates the containing directory on first write', () => {
    const file = join(dataDir, 'nested', 'deeper', 'memory.json')
    const store = new JsonMemoryStore(file, 0)
    store.save(normalizeSnapshot({}))
    store.flush()
    expect(readFileSync(file, 'utf8')).toContain('"version"')
  })
})

describe('LexicalIndex', () => {
  function indexFor(facts: MemoryFact[]): LexicalIndexType {
    const index = new LexicalIndex()
    index.rebuild(facts)
    return index
  }

  it('ranks the fact that shares characters with the query first', () => {
    const cat = makeFact({ id: 'cat', text: '用户养了一只叫小黑的猫' })
    const job = makeFact({ id: 'job', text: '用户在做前端开发' })
    const hits = indexFor([cat, job]).recall([cat, job], '小黑今天怎么样', { limit: 2 })
    expect(hits[0].fact.id).toBe('cat')
    expect(hits[0].reasons.join(' ')).toContain('matched')
  })

  it('always injects boundary facts even when nothing matches', () => {
    const trauma = makeFact({ id: 'b', text: '用户对打雷有强烈恐惧', kind: 'boundary' })
    const other = makeFact({ id: 'o', text: '用户喜欢蓝色' })
    const hits = indexFor([trauma, other]).recall([trauma, other], '完全无关的问题', { limit: 1 })
    expect(hits.map((hit) => hit.fact.id)).toContain('b')
  })

  it('reserves slots for pinned facts', () => {
    const facts = [
      makeFact({ id: 'p', text: '用户在准备面试', pinned: true }),
      makeFact({ id: 'a', text: '用户喜欢喝茶' }),
      makeFact({ id: 'b', text: '用户喜欢下雨' }),
      makeFact({ id: 'c', text: '用户喜欢蓝色' })
    ]
    const hits = indexFor(facts).recall(facts, '随便聊聊', { limit: 2, pinnedSlots: 1 })
    expect(hits.map((hit) => hit.fact.id)).toContain('p')
  })

  it('skips archived and suppressed facts', () => {
    const facts = [
      makeFact({ id: 'a', text: '用户讨厌香菜', archived: true }),
      makeFact({ id: 'b', text: '用户讨厌香菜', suppressed: true })
    ]
    const hits = indexFor(facts).recall(facts, '香菜', { limit: 5 })
    expect(hits).toEqual([])
  })

  it('honours the exclusion set', () => {
    const facts = [makeFact({ id: 'a', text: '用户讨厌香菜' })]
    const hits = indexFor(facts).recall(facts, '香菜', { limit: 5, exclude: new Set(['a']) })
    expect(hits).toEqual([])
  })
})

describe('textSimilarity', () => {
  it('is 1 for identical text and 0 for unrelated text', () => {
    expect(textSimilarity('用户养了一只猫', '用户养了一只猫')).toBe(1)
    expect(textSimilarity('用户养了一只猫', '今天天气不错')).toBe(0)
  })
})

describe('memoryManager', () => {
  const context = { conversationId: 'c1', messageIds: ['m1'] }

  it('stores a new fact and keeps it out of the review queue when auto-accepting', () => {
    const stored = memoryManager.remember(
      [{ text: '用户养了一只叫小黑的猫', kind: 'identity', subject: 'user', importance: 4, confidence: 0.9 }],
      context,
      settingsStore.get().companion
    )
    expect(stored).toHaveLength(1)
    expect(stored[0].pending).toBe(false)
    expect(stored[0].sourceMessageIds).toEqual(['m1'])
  })

  it('queues a fact for review and hides it from recall until it is accepted', () => {
    settingsStore.update({ companion: { autoAcceptFacts: false } })
    const [fact] = memoryManager.remember(
      [{ text: '用户讨厌香菜', kind: 'preference', subject: 'user', importance: 3, confidence: 0.9 }],
      context,
      settingsStore.get().companion
    )
    expect(fact.pending).toBe(true)
    expect(memoryManager.recall('香菜')).toEqual([])

    memoryManager.approve([fact.id], true)
    expect(memoryManager.recall('香菜').map((hit) => hit.fact.id)).toEqual([fact.id])
  })

  it('rejects a queued fact into the archive', () => {
    settingsStore.update({ companion: { autoAcceptFacts: false } })
    const [fact] = memoryManager.remember(
      [{ text: '用户讨厌香菜', kind: 'preference', subject: 'user', importance: 3, confidence: 0.9 }],
      context,
      settingsStore.get().companion
    )
    memoryManager.approve([fact.id], false)
    expect(memoryManager.getFact(fact.id)?.archived).toBe(true)
    expect(memoryManager.recall('香菜')).toEqual([])
  })

  it('merges a re-learned fact instead of duplicating it', () => {
    const draft = {
      text: '用户养了一只叫小黑的猫',
      kind: 'identity' as const,
      subject: 'user' as const,
      importance: 3,
      confidence: 0.9
    }
    memoryManager.remember([draft], context, settingsStore.get().companion)
    const second = memoryManager.remember([draft], context, settingsStore.get().companion)
    expect(memoryManager.listFacts({ includeArchived: true })).toHaveLength(1)
    expect(second[0].reinforcements).toBe(1)
  })

  it('raises importance once a fact has been reinforced enough', () => {
    const draft = {
      text: '用户在设计一个桌面应用',
      kind: 'goal' as const,
      subject: 'user' as const,
      importance: 2,
      confidence: 0.9
    }
    memoryManager.remember([draft], context, settingsStore.get().companion)
    memoryManager.remember([draft], context, settingsStore.get().companion)
    const third = memoryManager.remember([draft], context, settingsStore.get().companion)
    expect(third[0].importance).toBeGreaterThan(2)
  })

  it('counts real usage but not the library dry-run', () => {
    const [fact] = memoryManager.remember(
      [{ text: '用户喜欢下雨天', kind: 'preference', subject: 'user', importance: 3, confidence: 0.9 }],
      context,
      settingsStore.get().companion
    )
    memoryManager.recall('下雨', { track: false })
    expect(memoryManager.getFact(fact.id)?.useCount).toBe(0)
    memoryManager.recall('下雨')
    expect(memoryManager.getFact(fact.id)?.useCount).toBe(1)
  })

  it('edits and forgets a fact', () => {
    const [fact] = memoryManager.remember(
      [{ text: '用户不喜欢咖啡', kind: 'preference', subject: 'user', importance: 2, confidence: 0.9 }],
      context,
      settingsStore.get().companion
    )
    memoryManager.updateFact(fact.id, { text: '用户喜欢手冲咖啡', importance: 5 })
    expect(memoryManager.getFact(fact.id)?.text).toBe('用户喜欢手冲咖啡')
    expect(memoryManager.getFact(fact.id)?.importance).toBe(5)

    memoryManager.removeFacts([fact.id])
    expect(memoryManager.getFact(fact.id)).toBeNull()
  })

  it('imports a batch of facts from an exported file', () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      makeFact({ id: `bulk-${index}`, text: `用户提到过第${index}件事`, importance: 1 })
    )
    memoryManager.importJson({ version: 1, facts: many })
    expect(memoryManager.listFacts({ includeArchived: true, includePending: true }).length).toBe(40)
  })

  it('does not overwrite an existing fact when importing', () => {
    const [fact] = memoryManager.remember(
      [{ text: '用户喜欢下雨天', kind: 'preference', subject: 'user', importance: 3, confidence: 0.9 }],
      context,
      settingsStore.get().companion
    )
    memoryManager.updateFact(fact.id, { text: '用户非常喜欢下雨天' })
    const added = memoryManager.importJson({ version: 1, facts: [{ ...fact, text: '被覆盖了' }] })
    expect(added).toBe(0)
    expect(memoryManager.getFact(fact.id)?.text).toBe('用户非常喜欢下雨天')
  })

  it('drops importance for facts nobody has recalled in a month', () => {
    const old = Date.now() - 60 * 24 * 60 * 60 * 1000
    memoryManager.importJson({
      version: 1,
      facts: [makeFact({ id: 'old', text: '用户提过一件很久以前的事', importance: 4, createdAt: old, updatedAt: old })]
    })
    memoryManager.decay()
    expect(memoryManager.getFact('old')?.importance).toBeLessThan(4)
  })

  it('never decays a pin or a boundary fact', () => {
    const old = Date.now() - 60 * 24 * 60 * 60 * 1000
    memoryManager.importJson({
      version: 1,
      facts: [
        makeFact({ id: 'pin', text: '用户的重要约定', importance: 4, pinned: true, createdAt: old, updatedAt: old }),
        makeFact({ id: 'b', text: '用户对打雷有强烈恐惧', kind: 'boundary', importance: 4, createdAt: old, updatedAt: old })
      ]
    })
    memoryManager.decay()
    expect(memoryManager.getFact('pin')?.importance).toBe(4)
    expect(memoryManager.getFact('b')?.importance).toBe(4)
  })

  it('records an episode once per day and updates it in place', () => {
    const base = { date: '2026-01-01', conversationId: 'c1', summary: '聊了猫', highlights: ['猫'], emotion: '开心' }
    memoryManager.recordEpisode(base)
    memoryManager.recordEpisode({ ...base, summary: '聊了猫和雨' })
    const episodes = memoryManager.episodes()
    expect(episodes).toHaveLength(1)
    expect(episodes[0].summary).toBe('聊了猫和雨')
  })

  it('hands out a seed thought at most once', () => {
    memoryManager.addSeeds(['在想他昨天说的面试'])
    expect(memoryManager.takeSeed()?.text).toContain('面试')
    expect(memoryManager.takeSeed()).toBeNull()
  })

  it('expires seed thoughts', () => {
    const past = Date.now() - 1000
    memoryManager.addSeeds(['过期念头'], past)
    const future = past + 30 * 24 * 60 * 60 * 1000
    expect(memoryManager.takeSeed(future)).toBeNull()
  })

  it('rolls the heartbeat day counter over', () => {
    memoryManager.updateHeartbeat({ dayKey: '2026-01-01', todayCount: 3 })
    const rolled = memoryManager.rollHeartbeatDay(new Date('2026-01-02T10:00:00').getTime())
    expect(rolled.todayCount).toBe(0)
    expect(rolled.dayKey).toBe('2026-01-02')
  })

  it('keeps the heartbeat day counter within the same day', () => {
    const noon = new Date('2026-01-02T12:00:00').getTime()
    memoryManager.rollHeartbeatDay(noon)
    memoryManager.updateHeartbeat({ todayCount: 2 })
    const again = memoryManager.rollHeartbeatDay(noon + 60_000)
    expect(again.todayCount).toBe(2)
  })

  it('forgets everything on request', () => {
    memoryManager.remember(
      [{ text: '用户喜欢下雨天', kind: 'preference', subject: 'user', importance: 3, confidence: 0.9 }],
      context,
      settingsStore.get().companion
    )
    memoryManager.recordEpisode({
      date: '2026-01-01',
      conversationId: 'c1',
      summary: 'x',
      highlights: [],
      emotion: null
    })
    memoryManager.forgetAll()
    expect(memoryManager.listFacts({ includeArchived: true, includePending: true })).toEqual([])
    expect(memoryManager.episodes()).toEqual([])
    expect(memoryManager.stats().facts).toBe(0)
  })

  it('reports stats for the library header', () => {
    settingsStore.update({ companion: { autoAcceptFacts: true } })
    memoryManager.remember(
      [{ text: '用户喜欢下雨天', kind: 'preference', subject: 'user', importance: 3, confidence: 0.9 }],
      context,
      settingsStore.get().companion
    )
    settingsStore.update({ companion: { autoAcceptFacts: false } })
    memoryManager.remember(
      [{ text: '用户讨厌香菜', kind: 'preference', subject: 'user', importance: 3, confidence: 0.9 }],
      context,
      settingsStore.get().companion
    )
    const stats = memoryManager.stats()
    expect(stats.facts).toBe(2)
    expect(stats.active).toBe(1)
    expect(stats.pending).toBe(1)
  })

  it('persists to the memory file under the data directory', () => {
    memoryManager.remember(
      [{ text: '用户喜欢下雨天', kind: 'preference', subject: 'user', importance: 3, confidence: 0.9 }],
      context,
      settingsStore.get().companion
    )
    memoryManager.flush()
    const raw = readFileSync(getPaths().memoryFile, 'utf8')
    expect(raw).toContain('用户喜欢下雨天')
  })

  it('marks the interaction time on the relationship', () => {
    memoryManager.touchInteraction(1000)
    expect(memoryManager.relationship().lastInteractionAt).toBe(1000)
    expect(memoryManager.relationship().knownSince).toBe(1000)
  })
})

describe('snapshot migration', () => {
  it('upgrades a v1 fact by filling the new fields with inert defaults', () => {
    const fact = normalizeFact({ id: 'a', text: '用户养了一只叫小黑的猫' })
    expect(fact?.occurrences).toEqual([])
    expect(fact?.supersededBy).toBeNull()
    expect(fact?.mergedFrom).toEqual([])
    expect(fact?.provenance).toEqual([])
  })

  it('stamps the current schema version on a v1 file', () => {
    const snapshot = normalizeSnapshot({ version: 1, facts: [{ id: 'a', text: '用户喜欢下雨天' }] })
    expect(snapshot.version).toBe(2)
    expect(snapshot.facts[0].text).toBe('用户喜欢下雨天')
  })

  it('drops an occurrence that has no usable date', () => {
    const fact = normalizeFact({
      id: 'a',
      text: '用户加班到很晚',
      occurrences: [
        { at: 0, dateKey: '2026-03-01', note: 'no timestamp' },
        { at: 1000, dateKey: '', note: 'no day' },
        { at: Date.parse('2026-03-01T20:00:00'), dateKey: '2026-03-01', note: 'ok' }
      ]
    })
    expect(fact?.occurrences).toHaveLength(1)
    expect(fact?.occurrences[0].note).toBe('ok')
  })

  it('keeps the newest occurrences first and caps the list', () => {
    const occurrences = Array.from({ length: 60 }, (_, index) => ({
      at: index + 1,
      dateKey: `2026-01-${String((index % 28) + 1).padStart(2, '0')}`,
      note: `第 ${index} 次`,
      conversationId: null
    }))
    const fact = normalizeFact({ id: 'a', text: '用户加班到很晚', occurrences })
    expect(fact?.occurrences).toHaveLength(MAX_FACT_OCCURRENCES)
    expect(fact?.occurrences[0].at).toBe(60)
  })
})

describe('temporal depth', () => {
  const context = { conversationId: 'c1', messageIds: [] }
  const settings = () => settingsStore.get().companion
  const event = {
    text: '用户加班到很晚',
    kind: 'event' as const,
    subject: 'user' as const,
    importance: 3,
    confidence: 0.9
  }

  function addEvent(at: number): MemoryFact {
    const [fact] = memoryManager.applyVerdicts(
      [{ draft: event, op: 'new', targetId: null, why: '', at }],
      context,
      settings()
    )
    return fact
  }

  it('stamps a new event with the day it happened', () => {
    const at = new Date('2026-03-01T20:00:00').getTime()
    const fact = addEvent(at)
    expect(fact.occurrences).toHaveLength(1)
    expect(fact.occurrences[0].dateKey).toBe('2026-03-01')
    expect(fact.occurrences[0].note).toBe('用户加班到很晚')
    expect(fact.occurrences[0].conversationId).toBe('c1')
  })

  it('does not start a timeline for something that is not an event', () => {
    const [fact] = memoryManager.applyVerdicts(
      [
        {
          draft: { ...event, kind: 'preference', text: '用户不喜欢吃香菜' },
          op: 'new',
          targetId: null,
          why: '',
          at: Date.now()
        }
      ],
      context,
      settings()
    )
    expect(fact.occurrences).toEqual([])
  })

  it('counts one instance however often the same day is mentioned', () => {
    const at = new Date('2026-03-01T20:00:00').getTime()
    const fact = addEvent(at)
    const [again] = memoryManager.applyVerdicts(
      [{ draft: { ...event, text: '用户今天又加班了' }, op: 'same', targetId: fact.id, why: '同一件事', at: at + 3_600_000 }],
      context,
      settings()
    )
    expect(again.occurrences).toHaveLength(1)
    expect(again.reinforcements).toBe(1)
  })

  it('adds a second instance when the same event comes up on a later day', () => {
    const day1 = new Date('2026-03-01T20:00:00').getTime()
    const day2 = new Date('2026-03-04T20:00:00').getTime()
    const fact = addEvent(day1)
    const [merged] = memoryManager.applyVerdicts(
      [
        {
          draft: { ...event, text: '用户又加班到很晚才回家' },
          op: 'same',
          targetId: fact.id,
          why: '同类事件',
          at: day2
        }
      ],
      context,
      settings()
    )
    expect(merged.occurrences.map((entry) => entry.dateKey)).toEqual(['2026-03-04', '2026-03-01'])
    // The stored sentence is never rewritten: re-wording it every mention is how
    // the store ended up with five paraphrases of the same fact.
    expect(merged.text).toBe('用户加班到很晚')
    expect(merged.occurrences[1].note).toBe('用户加班到很晚')
  })

  it('keeps only one row for a run of reports', () => {
    const fact = addEvent(new Date('2026-03-01T20:00:00').getTime())
    for (const day of [2, 3, 4]) {
      memoryManager.applyVerdicts(
        [
          {
            draft: { ...event, text: `用户第${day}天又加班到很晚` },
            op: 'same',
            targetId: fact.id,
            why: '',
            at: new Date(`2026-03-0${day}T20:00:00`).getTime()
          }
        ],
        context,
        settings()
      )
    }
    expect(memoryManager.listFacts()).toHaveLength(1)
    expect(memoryManager.getFact(fact.id)?.occurrences).toHaveLength(4)
  })

  it('archives a contradicted fact and offers it back', () => {
    const fact = addEvent(Date.now())
    const [replacement] = memoryManager.applyVerdicts(
      [
        {
          draft: { ...event, text: '用户其实挺喜欢加班的' },
          op: 'supersede',
          targetId: fact.id,
          why: '说法相反',
          at: Date.now()
        }
      ],
      context,
      settings()
    )
    const old = memoryManager.getFact(fact.id)
    expect(old?.supersededBy).toBe(replacement.id)
    expect(old?.archived).toBe(true)
    // Archived rows stay in the library so the correction is never invisible.
    expect(memoryManager.listFacts({ includeArchived: true }).map((f) => f.id)).toContain(fact.id)

    memoryManager.restoreFact(fact.id)
    expect(memoryManager.getFact(fact.id)?.supersededBy).toBeNull()
    expect(memoryManager.getFact(fact.id)?.archived).toBe(false)
  })

  it('keeps a superseded fact out of recall even after a pin revives it', () => {
    const fact = addEvent(Date.now())
    const [replacement] = memoryManager.applyVerdicts(
      [
        {
          draft: { ...event, text: '用户其实挺喜欢加班的' },
          op: 'supersede',
          targetId: fact.id,
          why: '',
          at: Date.now()
        }
      ],
      context,
      settings()
    )
    expect(replacement.id).toBeTruthy()
    // pinning clears the archive flag, which is exactly the hole to guard.
    memoryManager.updateFact(fact.id, { pinned: true })
    expect(memoryManager.getFact(fact.id)?.archived).toBe(false)
    expect(memoryManager.recall('加班').map((hit) => hit.fact.id)).not.toContain(fact.id)
  })

  it('records why a merge happened, for the library to explain', () => {
    const fact = addEvent(Date.now())
    memoryManager.applyVerdicts(
      [{ draft: event, op: 'same', targetId: fact.id, why: '同一件事', at: Date.now() }],
      context,
      settings()
    )
    expect(memoryManager.getFact(fact.id)?.provenance.map((entry) => entry.why)).toContain('同一件事')
  })

  it('degrades a verdict naming a row that no longer exists', () => {
    const stored = memoryManager.applyVerdicts(
      [{ draft: event, op: 'same', targetId: 'gone', why: '', at: Date.now() }],
      context,
      settings()
    )
    expect(stored).toHaveLength(1)
    expect(stored[0].occurrences).toHaveLength(1)
  })

  it('falls back to the lexical check when no target is named', () => {
    const [first] = memoryManager.applyVerdicts(
      [{ draft: event, op: 'new', targetId: null, why: '', at: Date.now() }],
      context,
      settings()
    )
    const stored = memoryManager.applyVerdicts(
      [{ draft: event, op: 'new', targetId: null, why: '', at: Date.now() }],
      context,
      settings()
    )
    expect(memoryManager.listFacts({ includeArchived: true })).toHaveLength(1)
    expect(stored[0].id).toBe(first.id)
  })
})

describe('similarity', () => {
  it('ignores the trailing punctuation a model likes to add', () => {
    expect(textSimilarity('用户今天加班到很晚。', '用户今天加班到很晚')).toBe(1)
    expect(textSimilarity('用户喜欢下雨天！', '用户喜欢下雨天')).toBe(1)
  })

  it('ranks the stored row that is about the same thing first', () => {
    const facts = [
      makeFact({ id: 'lxy', text: '用户在学校有一位学工处主任叫lxy，用户觉得这个人很烦人。' }),
      makeFact({ id: 'coffee', text: '用户很喜欢喝咖啡。' }),
      makeFact({ id: 'room', text: '用户的室友叫阿哲。' })
    ]
    const index = new LexicalIndex()
    index.rebuild(facts)
    const ranked = index.rank(facts, '用户在学校有一位让他感到烦恼的老师，该老师姓lxy', 3)
    expect(ranked[0].fact.id).toBe('lxy')
  })

  it('skips a superseded row when shortlisting', () => {
    const facts = [
      makeFact({ id: 'old', text: '用户喜欢加班', supersededBy: 'new' }),
      makeFact({ id: 'new', text: '用户不喜欢加班' })
    ]
    const index = new LexicalIndex()
    index.rebuild(facts)
    expect(index.rank(facts, '加班', 5).map((entry) => entry.fact.id)).toEqual(['new'])
  })
})
