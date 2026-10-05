import { randomUUID } from 'node:crypto'
import type {
  CompanionSettings,
  HeartbeatBookkeeping,
  MemoryEpisode,
  MemoryFact,
  MemoryHit,
  MemoryKind,
  MemoryQuery,
  MemorySnapshot,
  MemoryStats,
  MemorySubject,
  RelationshipState,
  SeedThought,
  SessionMemory
} from '@shared/types'
import {
  FACT_PROMOTION_STREAK,
  MAX_SEED_THOUGHTS,
  MAX_MEMORY_FACTS,
  SEED_THOUGHT_TTL_MS
} from '@shared/types'
import { logger } from '../util/logger'
import { ensureDataDirs, getPaths } from '../store/paths'
import { settingsStore } from '../store/settings'
import { LexicalIndex, textSimilarity } from './lexical-index'
import {
  createHeartbeatStore,
  emptySnapshot,
  JsonDocStore,
  JsonMemoryStore,
  normalizeSnapshot,
  type MemoryBackend
} from './store'

/** Above this Jaccard similarity a re-learned fact updates the existing row. */
const MERGE_THRESHOLD = 0.85
const MAX_FACT_CHARS = 240
/** A recall hit newer than this is considered "just learned" by the UI. */
const RECENT_MS = 5 * 60 * 1000

export interface MemoryDraft {
  text: string
  kind: MemoryKind
  subject: MemorySubject
  importance: number
  confidence: number
}

export interface RememberContext {
  conversationId: string | null
  messageIds: string[]
}

export interface RecallOptions {
  limit?: number
  /** used by the library's dry-run, which must not count as real usage */
  track?: boolean
  exclude?: Set<string>
  now?: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_CHARS)
}

function localDayKey(timestamp: number): string {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Owns the long-term memory layer (L3) and the heartbeat bookkeeping.
 *
 * Everything the renderer can do to a memory goes through here, so the library
 * UI and the extraction pipeline can never disagree about what is stored. The
 * snapshot is the single source of truth while the app runs; the file is only
 * a debounced mirror of it.
 */
class MemoryManager {
  private backend: MemoryBackend | null = null
  private heartbeatStore: JsonDocStore<HeartbeatBookkeeping> | null = null
  private snapshot: MemorySnapshot | null = null
  private index = new LexicalIndex()
  private listeners = new Set<() => void>()
  private indexDirty = true

  init(): void {
    if (this.backend) return
    ensureDataDirs()
    const paths = getPaths()
    this.backend = new JsonMemoryStore(paths.memoryFile)
    this.heartbeatStore = createHeartbeatStore(paths.heartbeatFile)
    this.snapshot = this.backend.load()
    this.indexDirty = true
    logger.info(
      'memory',
      `loaded ${this.snapshot.facts.length} fact(s), ${this.snapshot.episodes.length} episode(s)`
    )
  }

  /** Idempotent teardown for tests and for the data-directory switch. */
  reset(): void {
    this.backend = null
    this.heartbeatStore = null
    this.snapshot = null
    this.index = new LexicalIndex()
    this.indexDirty = true
  }

  flush(): void {
    this.backend?.flush()
    this.heartbeatStore?.flush()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private s(): MemorySnapshot {
    this.init()
    return this.snapshot ?? emptySnapshot()
  }

  private hb(): JsonDocStore<HeartbeatBookkeeping> {
    this.init()
    const store = this.heartbeatStore
    if (!store) throw new Error('memory manager not initialised')
    return store
  }

  private commit(): void {
    this.indexDirty = true
    this.backend?.save(this.s())
    this.emit()
  }

  private ensureIndex(): LexicalIndex {
    if (this.indexDirty) {
      this.index.rebuild(this.s().facts)
      this.indexDirty = false
    }
    return this.index
  }

  /* ---------------------------------------------------------------- */
  /* Relationship                                                      */
  /* ---------------------------------------------------------------- */

  relationship(): RelationshipState {
    return { ...this.s().relationship }
  }

  updateRelationship(patch: Partial<RelationshipState>): RelationshipState {
    const snapshot = this.s()
    snapshot.relationship = { ...snapshot.relationship, ...patch }
    this.commit()
    return { ...snapshot.relationship }
  }

  touchInteraction(timestamp = Date.now()): void {
    const snapshot = this.s()
    if (!snapshot.relationship.knownSince) snapshot.relationship.knownSince = timestamp
    snapshot.relationship.lastInteractionAt = timestamp
    this.commit()
  }

  /* ---------------------------------------------------------------- */
  /* Facts                                                             */
  /* ---------------------------------------------------------------- */

  listFacts(query: MemoryQuery = {}): MemoryFact[] {
    const all = this.s().facts
    const needle = query.text?.trim().toLowerCase() ?? ''

    let facts = all.filter((fact) => {
      if (!query.includeArchived && fact.archived) return false
      if (query.includePending === false && fact.pending) return false
      if (query.pinnedOnly && !fact.pinned) return false
      if (query.minImportance !== undefined && fact.importance < query.minImportance) return false
      if (query.kinds && query.kinds.length > 0 && !query.kinds.includes(fact.kind)) return false
      if (query.subject && query.subject !== 'all' && fact.subject !== query.subject) return false
      if (needle.length > 0 && !fact.text.toLowerCase().includes(needle)) return false
      return true
    })

    const sort = query.sort ?? 'recent'
    facts = [...facts].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      if (sort === 'importance') return b.importance - a.importance || b.updatedAt - a.updatedAt
      if (sort === 'used') return b.useCount - a.useCount || b.updatedAt - a.updatedAt
      return b.updatedAt - a.updatedAt
    })

    return query.limit && query.limit > 0 ? facts.slice(0, query.limit) : facts
  }

  getFact(id: string): MemoryFact | null {
    return this.s().facts.find((fact) => fact.id === id) ?? null
  }

  /**
   * Writes extracted facts into long-term memory.
   *
   * A fact the extractor has already seen is merged rather than duplicated:
   * its reinforcement count goes up and, past `FACT_PROMOTION_STREAK`, so does
   * its importance — which is what makes something the user keeps coming back
   * to outrank a one-off remark.
   */
  remember(
    drafts: MemoryDraft[],
    context: RememberContext,
    settings: CompanionSettings
  ): MemoryFact[] {
    const snapshot = this.s()
    const now = Date.now()
    const stored: MemoryFact[] = []
    let factsChanged = false

    for (const draft of drafts) {
      const text = normalizeText(draft.text)
      if (text.length === 0) continue

      const existing = snapshot.facts.find(
        (fact) => !fact.archived && textSimilarity(fact.text, text) >= MERGE_THRESHOLD
      )

      if (existing) {
        existing.reinforcements += 1
        existing.updatedAt = now
        existing.confidence = clamp(Math.max(existing.confidence, draft.confidence), 0, 1)
        if (existing.reinforcements >= FACT_PROMOTION_STREAK) {
          existing.importance = clamp(Math.max(existing.importance, draft.importance) + 1, 1, 5)
        } else {
          existing.importance = clamp(Math.max(existing.importance, draft.importance), 1, 5)
        }
        // A fact the user rejected stays rejected unless they ask for it back.
        if (!existing.archived) stored.push(existing)
        continue
      }

      const fact: MemoryFact = {
        id: randomUUID(),
        text,
        kind: draft.kind,
        subject: draft.subject,
        importance: clamp(Math.round(draft.importance), 1, 5),
        confidence: clamp(draft.confidence, 0, 1),
        createdAt: now,
        updatedAt: now,
        lastUsedAt: 0,
        useCount: 0,
        reinforcements: 0,
        sourceConversationId: context.conversationId,
        sourceMessageIds: [...context.messageIds],
        pinned: false,
        suppressed: false,
        archived: false,
        pending: !settings.autoAcceptFacts,
        embedding: null
      }

      snapshot.facts.push(fact)
      stored.push(fact)
      factsChanged = true
    }

    if (stored.length > 0) this.evictIfNeeded(snapshot)
    if (factsChanged || stored.length > 0) {
      this.indexDirty = true
      this.backend?.save(snapshot)
      this.emit()
    }
    return stored
  }

  /** Keeps the store bounded by dropping the least valuable unpinned facts. */
  private evictIfNeeded(snapshot: MemorySnapshot): void {
    if (snapshot.facts.length <= MAX_MEMORY_FACTS) return

    const removable = snapshot.facts
      .map((fact, index) => ({ fact, index }))
      .filter((entry) => !entry.fact.pinned && entry.fact.kind !== 'boundary')
      .sort((a, b) => {
        const left = a.fact.importance * 1000 + a.fact.useCount * 10
        const right = b.fact.importance * 1000 + b.fact.useCount * 10
        if (left !== right) return left - right
        return a.fact.updatedAt - b.fact.updatedAt
      })

    const overflow = snapshot.facts.length - MAX_MEMORY_FACTS
    const doomed = new Set(removable.slice(0, overflow).map((entry) => entry.fact.id))
    if (doomed.size === 0) return

    snapshot.facts = snapshot.facts.filter((fact) => !doomed.has(fact.id))
    logger.info('memory', `evicted ${doomed.size} low-value fact(s) to stay under the cap`)
  }

  updateFact(id: string, patch: Partial<MemoryFact>): MemoryFact[] {
    const snapshot = this.s()
    const fact = snapshot.facts.find((entry) => entry.id === id)
    if (!fact) return this.listFacts({ includeArchived: true, includePending: true })

    const next: MemoryFact = { ...fact, ...patch, id: fact.id, embedding: null }
    if (patch.text !== undefined) next.text = normalizeText(patch.text)
    if (patch.pinned === true) next.archived = false
    if (patch.importance !== undefined) next.importance = clamp(Math.round(patch.importance), 1, 5)
    if (patch.confidence !== undefined) next.confidence = clamp(patch.confidence, 0, 1)
    if (patch.pending === false) next.pending = false
    next.updatedAt = Date.now()

    const index = snapshot.facts.indexOf(fact)
    snapshot.facts[index] = next
    this.commit()
    return this.listFacts({ includeArchived: true, includePending: true })
  }

  removeFacts(ids: string[]): MemoryFact[] {
    const doomed = new Set(ids)
    const snapshot = this.s()
    snapshot.facts = snapshot.facts.filter((fact) => !doomed.has(fact.id))
    this.commit()
    logger.info('memory', `forgot ${doomed.size} fact(s)`)
    return this.listFacts({ includeArchived: true, includePending: true })
  }

  /** Accepts or rejects everything sitting in the review queue. */
  approve(ids: string[], accept: boolean): MemoryFact[] {
    const snapshot = this.s()
    const target = new Set(ids)
    for (const fact of snapshot.facts) {
      if (!target.has(fact.id)) continue
      if (accept) {
        fact.pending = false
        fact.updatedAt = Date.now()
      } else {
        fact.archived = true
      }
    }
    this.commit()
    return this.listFacts({ includeArchived: true, includePending: true })
  }

  private markUsed(hits: MemoryHit[], now: number): void {
    if (hits.length === 0) return
    const snapshot = this.s()
    for (const hit of hits) {
      const fact = snapshot.facts.find((entry) => entry.id === hit.fact.id)
      if (!fact) continue
      fact.lastUsedAt = now
      fact.useCount += 1
    }
    this.backend?.save(snapshot)
    this.emit()
  }

  /** The facts the next turn should be told about. */
  recall(query: string, options: RecallOptions = {}): MemoryHit[] {
    const settings = this.settings()
    const limit = options.limit ?? settings.recallCount
    const snapshot = this.s()
    // Pending facts are deliberately invisible to the model: the review queue
    // exists precisely so nothing reaches the prompt before the user sees it.
    const pool = snapshot.facts.filter((fact) => !fact.pending)
    const now = options.now ?? Date.now()

    const hits = this.ensureIndex().recall(pool, query, {
      limit,
      exclude: options.exclude,
      now
    })

    if (options.track !== false) this.markUsed(hits, now)
    return hits
  }

  /* ---------------------------------------------------------------- */
  /* Session memory (L2)                                               */
  /* ---------------------------------------------------------------- */

  session(conversationId: string): SessionMemory {
    const found = this.s().sessions.find((entry) => entry.conversationId === conversationId)
    if (found) return { ...found, facts: [...found.facts] }
    return {
      conversationId,
      summary: '',
      summaryUpTo: 0,
      facts: [],
      extractedUpTo: 0,
      updatedAt: 0
    }
  }

  updateSession(conversationId: string, patch: Partial<SessionMemory>): SessionMemory {
    const snapshot = this.s()
    const index = snapshot.sessions.findIndex((entry) => entry.conversationId === conversationId)
    const base =
      index >= 0
        ? snapshot.sessions[index]
        : {
            conversationId,
            summary: '',
            summaryUpTo: 0,
            facts: [],
            extractedUpTo: 0,
            updatedAt: 0
          }

    const next: SessionMemory = { ...base, ...patch, conversationId, updatedAt: Date.now() }
    if (index >= 0) snapshot.sessions[index] = next
    else snapshot.sessions.unshift(next)

    snapshot.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    snapshot.sessions = snapshot.sessions.slice(0, 200)

    this.backend?.save(snapshot)
    this.emit()
    return { ...next, facts: [...next.facts] }
  }

  forgetSession(conversationId: string): void {
    const snapshot = this.s()
    const next = snapshot.sessions.filter((entry) => entry.conversationId !== conversationId)
    if (next.length === snapshot.sessions.length) return
    snapshot.sessions = next
    this.backend?.save(snapshot)
  }

  /* ---------------------------------------------------------------- */
  /* Episodes and seeds                                                */
  /* ---------------------------------------------------------------- */

  episodes(): MemoryEpisode[] {
    return this.s().episodes.map((episode) => ({ ...episode }))
  }

  recordEpisode(episode: Omit<MemoryEpisode, 'id' | 'createdAt'>): MemoryEpisode {
    const snapshot = this.s()
    const existing = snapshot.episodes.find(
      (entry) => entry.date === episode.date && entry.conversationId === episode.conversationId
    )
    const now = Date.now()

    if (existing) {
      existing.summary = episode.summary
      existing.highlights = [...episode.highlights]
      existing.emotion = episode.emotion
      this.commit()
      return { ...existing }
    }

    const created: MemoryEpisode = { ...episode, id: randomUUID(), createdAt: now }
    snapshot.episodes.unshift(created)
    this.commit()
    return { ...created }
  }

  addSeeds(texts: string[], now = Date.now()): SeedThought[] {
    const snapshot = this.s()
    for (const text of texts) {
      const trimmed = normalizeText(text)
      if (trimmed.length === 0) continue
      snapshot.seeds.push({
        id: randomUUID(),
        text: trimmed,
        createdAt: now,
        expiresAt: now + SEED_THOUGHT_TTL_MS
      })
    }
    snapshot.seeds = snapshot.seeds
      .filter((seed) => seed.expiresAt > now)
      .slice(-MAX_SEED_THOUGHTS)
    this.commit()
    return snapshot.seeds.map((seed) => ({ ...seed }))
  }

  /** Takes the newest live seed and removes it, so it is used at most once. */
  takeSeed(now = Date.now()): SeedThought | null {
    const snapshot = this.s()
    const live = snapshot.seeds.filter((seed) => seed.expiresAt > now)
    const seed = live.length > 0 ? live[live.length - 1] : null
    if (snapshot.seeds.length !== live.length || seed) {
      snapshot.seeds = live.filter((entry) => entry.id !== seed?.id)
      this.commit()
    }
    return seed ? { ...seed } : null
  }

  /* ---------------------------------------------------------------- */
  /* Maintenance                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Ages facts that have not been recalled for a while.
   *
   * Importance is the only knob that changes: the row itself stays until it is
   * evicted or the user deletes it, so nothing silently disappears from the
   * memory library behind the user's back.
   */
  decay(now = Date.now(), days = 1): number {
    const snapshot = this.s()
    const dayMs = 24 * 60 * 60 * 1000
    let changed = 0

    for (const fact of snapshot.facts) {
      if (fact.pinned || fact.kind === 'boundary' || fact.importance <= 1) continue
      const stamp = Math.max(fact.lastUsedAt, fact.updatedAt)
      const idleDays = (now - stamp) / dayMs
      if (idleDays < 30) continue
      const drop = 0.02 * days * 30
      const next = Math.max(1, fact.importance - drop)
      if (next !== fact.importance) {
        fact.importance = next
        changed += 1
      }
    }

    if (changed > 0) this.commit()
    return changed
  }

  pruneSeeds(now = Date.now()): void {
    const snapshot = this.s()
    const live = snapshot.seeds.filter((seed) => seed.expiresAt > now)
    if (live.length === snapshot.seeds.length) return
    snapshot.seeds = live
    this.commit()
  }

  forgetAll(): void {
    const fresh = emptySnapshot()
    this.snapshot = fresh
    this.backend?.save(fresh)
    this.indexDirty = true
    this.emit()
    logger.warn('memory', 'the user erased the whole memory store')
  }
  /* ---------------------------------------------------------------- */
  /* Import / export                                                   */
  /* ---------------------------------------------------------------- */

  exportJson(): string {
    return `${JSON.stringify(this.s(), null, 2)}\n`
  }

  /**
   * Merges an exported file back in. Existing rows win on id collisions so an
   * import can never silently overwrite a memory the user edited.
   */
  importJson(raw: unknown): number {
    const incoming = normalizeSnapshot(raw)
    const snapshot = this.s()
    const known = new Set(snapshot.facts.map((fact) => fact.id))
    let added = 0

    for (const fact of incoming.facts) {
      if (known.has(fact.id)) continue
      snapshot.facts.push(fact)
      known.add(fact.id)
      added += 1
    }

    const episodeIds = new Set(snapshot.episodes.map((episode) => episode.id))
    for (const episode of incoming.episodes) {
      if (episodeIds.has(episode.id)) continue
      snapshot.episodes.push(episode)
      episodeIds.add(episode.id)
    }

    const sessionIds = new Set(snapshot.sessions.map((session) => session.conversationId))
    for (const session of incoming.sessions) {
      if (sessionIds.has(session.conversationId)) continue
      snapshot.sessions.push(session)
      sessionIds.add(session.conversationId)
    }

    if (added > 0) this.evictIfNeeded(snapshot)
    this.commit()
    return added
  }

  /* ---------------------------------------------------------------- */
  /* Heartbeat bookkeeping                                             */
  /* ---------------------------------------------------------------- */

  heartbeat(): HeartbeatBookkeeping {
    return { ...this.hb().get() }
  }

  updateHeartbeat(patch: Partial<HeartbeatBookkeeping>): HeartbeatBookkeeping {
    const next = { ...this.hb().get(), ...patch }
    this.hb().set(next)
    return { ...next }
  }

  /** Rolls the daily counter over when the local date changes. */
  rollHeartbeatDay(now = Date.now()): HeartbeatBookkeeping {
    const current = this.hb().get()
    const key = localDayKey(now)
    if (current.dayKey === key) return { ...current }
    return this.updateHeartbeat({ dayKey: key, todayCount: 0 })
  }

  /* ---------------------------------------------------------------- */
  /* Stats                                                             */
  /* ---------------------------------------------------------------- */

  stats(): MemoryStats {
    const snapshot = this.s()
    return {
      facts: snapshot.facts.length,
      active: snapshot.facts.filter((fact) => !fact.archived && !fact.pending).length,
      pending: snapshot.facts.filter((fact) => fact.pending && !fact.archived).length,
      archived: snapshot.facts.filter((fact) => fact.archived).length,
      episodes: snapshot.episodes.length,
      bytes: this.backend?.sizeBytes() ?? 0,
      lastDreamAt: this.hb().get().lastDreamAt
    }
  }

  /** Snapshot used by the "just learned" highlight in the library. */
  recentlyLearned(now = Date.now()): MemoryFact[] {
    return this.s().facts.filter((fact) => now - fact.createdAt < RECENT_MS)
  }

  private settings(): CompanionSettings {
    return settingsStore.get().companion
  }
}

export const memoryManager = new MemoryManager()
