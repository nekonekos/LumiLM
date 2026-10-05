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
  MAX_FACT_OCCURRENCES,
  MAX_FACT_PROVENANCE,
  MAX_SEED_THOUGHTS,
  MAX_MEMORY_FACTS,
  SEED_THOUGHT_TTL_MS
} from '@shared/types'
import { logger } from '../util/logger'
import { ensureDataDirs, getPaths } from '../store/paths'
import { settingsStore } from '../store/settings'
import { MAX_PROTECTED_CANDIDATES } from './consolidate'
import { localDayKey } from './day'
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

/**
 * One consolidation decision, already resolved to a real draft and a real row.
 *
 * `at` is the moment the turn happened, not the moment the decision was made: the
 * consolidation pass runs a second or two later, but a fact's timeline should be
 * stamped with when the user said it.
 */
export interface MemoryVerdict {
  draft: MemoryDraft
  op: 'new' | 'same' | 'supersede'
  /** the row the decision applies to; null when the pass named none */
  targetId: string | null
  why: string
  at?: number
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
    if (query.repeatedOnly && fact.occurrences.length < 2) return false
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
    // No consolidation available: every draft stands on its own and the lexical
    // check below is the only thing standing between the store and duplicates.
    return this.applyVerdicts(
      drafts.map((draft) => ({ draft, op: 'new' as const, targetId: null, why: '' })),
      context,
      settings
    )
  }

  /**
   * Writes consolidated facts into long-term memory.
   *
   * The decisions come from the consolidation pass, but nothing here is taken on
   * faith: the target is resolved against the live snapshot, and a verdict that
   * cannot be applied degrades to a plain insert plus the lexical near-duplicate
   * check. Losing a fact is the one outcome that is never acceptable, so every
   * failure path still stores something.
   */
  applyVerdicts(
    verdicts: MemoryVerdict[],
    context: RememberContext,
    settings: CompanionSettings
  ): MemoryFact[] {
    const snapshot = this.s()
    const now = Date.now()
    const stored: MemoryFact[] = []
    let factsChanged = false

    for (const verdict of verdicts) {
      const draft = verdict.draft
      const text = normalizeText(draft.text)
      if (text.length === 0) continue
      const at = verdict.at ?? now

      const target = verdict.targetId
        ? snapshot.facts.find((fact) => fact.id === verdict.targetId)
        : undefined

      if (verdict.op === 'same' && target) {
        this.mergeInto(target, draft, at, now, verdict.why, context)
        if (!target.archived) stored.push(target)
        continue
      }

      const inserted = this.insertFact(draft, context, settings, now, at)

      if (verdict.op === 'supersede' && target) {
        // The old row is archived, not deleted: it stays in the library behind
        // 「包含已归档」 with a way back, so a wrong supersede is recoverable.
        target.supersededBy = inserted.id
        target.archived = true
        this.recordProvenance(target, 'superseded', inserted.id, verdict.why, now)
        inserted.provenance.push({
          op: 'supersede',
          of: target.id,
          at: now,
          why: verdict.why
        })
        snapshot.facts.push(inserted)
        stored.push(inserted)
        factsChanged = true
        continue
      }

      if (!target) {
        // The model named no target. Re-stating a fact is the one shape it was
        // measured to get wrong, so the lexical check still gets a say before a
        // new row is allowed in.
        const near = snapshot.facts.find(
          (fact) =>
            !fact.archived &&
            !fact.supersededBy &&
            textSimilarity(fact.text, text) >= MERGE_THRESHOLD
        )
        if (near) {
          this.mergeInto(near, draft, at, now, 'lexical', context)
          stored.push(near)
          continue
        }
      }

      snapshot.facts.push(inserted)
      stored.push(inserted)
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

  private insertFact(
    draft: MemoryDraft,
    context: RememberContext,
    settings: CompanionSettings,
    now: number,
    at: number
  ): MemoryFact {
    const fact: MemoryFact = {
      id: randomUUID(),
      text: normalizeText(draft.text),
      kind: draft.kind,
      subject: draft.subject,
      importance: clamp(Math.round(draft.importance), 1, 5),
      confidence: clamp(draft.confidence, 0, 1),
      createdAt: now,
      updatedAt: now,
      lastUsedAt: 0,
      useCount: 0,
      reinforcements: 0,
      occurrences: [],
      supersededBy: null,
      mergedFrom: [],
      provenance: [],
      sourceConversationId: context.conversationId,
      sourceMessageIds: [...context.messageIds],
      pinned: false,
      suppressed: false,
      archived: false,
      pending: !settings.autoAcceptFacts,
      embedding: null
    }
    if (draft.kind === 'event') this.appendOccurrence(fact, at, draft.text, context)
    return fact
  }

  /**
   * Folds a re-learned fact into the row that already holds it.
   *
   * An event recurring on a later day extends its timeline instead of rewriting
   * it; anything else just gets reinforced. The text itself is never replaced:
   * letting the model re-word a stored fact on every mention is how the store
   * drifted into five paraphrases of the same thing.
   */
  private mergeInto(
    target: MemoryFact,
    draft: MemoryDraft,
    at: number,
    now: number,
    why: string,
    context: RememberContext
  ): void {
    target.reinforcements += 1
    target.updatedAt = now
    target.confidence = clamp(Math.max(target.confidence, draft.confidence), 0, 1)
    if (target.reinforcements >= FACT_PROMOTION_STREAK) {
      target.importance = clamp(Math.max(target.importance, draft.importance) + 1, 1, 5)
    } else {
      target.importance = clamp(Math.max(target.importance, draft.importance), 1, 5)
    }
    if (target.kind === 'event' || draft.kind === 'event') {
      this.appendOccurrence(target, at, draft.text, context)
    }
    this.recordProvenance(target, 'same', target.id, why, now)
  }

  /** Adds one dated instance, unless that local day is already on the timeline. */
  private appendOccurrence(
    fact: MemoryFact,
    at: number,
    note: string,
    context: RememberContext
  ): void {
    const dateKey = localDayKey(at)
    if (fact.occurrences.some((entry) => entry.dateKey === dateKey)) return
    fact.occurrences.unshift({
      at,
      dateKey,
      note: normalizeText(note),
      conversationId: context.conversationId
    })
    fact.occurrences.sort((a, b) => b.at - a.at)
    if (fact.occurrences.length > MAX_FACT_OCCURRENCES) {
      fact.occurrences = fact.occurrences.slice(0, MAX_FACT_OCCURRENCES)
    }
  }

  private recordProvenance(
    fact: MemoryFact,
    op: string,
    of: string | null,
    why: string,
    now: number
  ): void {
    if (why.length === 0 && op === 'same') return
    fact.provenance.push({ op, of, at: now, why: why.slice(0, 200) })
    if (fact.provenance.length > MAX_FACT_PROVENANCE) {
      fact.provenance = fact.provenance.slice(-MAX_FACT_PROVENANCE)
    }
  }

  /** Puts a superseded fact back, for the library's undo action. */
  restoreFact(id: string): MemoryFact[] {
    const snapshot = this.s()
    const fact = snapshot.facts.find((entry) => entry.id === id)
    if (fact) {
      fact.supersededBy = null
      fact.archived = false
      fact.updatedAt = Date.now()
      this.commit()
    }
    return this.listFacts({ includeArchived: true, includePending: true })
  }

  /**
   * Retires a stored fact without deleting it.
   *
   * Used by the tidy-up for rows that no longer pass the noise filters. The row is
   * archived rather than dropped, and `supersededBy` is left null when nothing
   * replaced it, so the library can tell "this was noise" from "this was corrected".
   */
  archiveFact(id: string, reason: string): MemoryFact[] {
    const snapshot = this.s()
    const fact = snapshot.facts.find((entry) => entry.id === id)
    if (fact && !fact.archived) {
      fact.archived = true
      fact.updatedAt = Date.now()
      this.recordProvenance(fact, 'tidied', null, reason, Date.now())
      this.commit()
    }
    return this.listFacts({ includeArchived: true, includePending: true })
  }

  /**
   * Folds one stored row into another, keeping the loser recoverable.
   *
   * The phrasing that is folded away is not thrown out: it is kept as the loser's
   * own row (archived, pointing at the survivor) and its wording is recorded on the
   * survivor, so nothing the user ever said becomes unreachable.
   */
  mergeFacts(sourceId: string, targetId: string, reason: string): MemoryFact[] {
    const snapshot = this.s()
    const source = snapshot.facts.find((fact) => fact.id === sourceId)
    const target = snapshot.facts.find((fact) => fact.id === targetId)
    if (source && target && source.id !== target.id && !source.archived) {
      const now = Date.now()
      this.mergeInto(
        target,
        {
          text: source.text,
          kind: source.kind,
          subject: source.subject,
          importance: source.importance,
          confidence: source.confidence
        },
        source.createdAt,
        now,
        reason,
        { conversationId: source.sourceConversationId, messageIds: [] }
      )
      source.supersededBy = target.id
      source.archived = true
      target.mergedFrom.push(source.id)
      this.commit()
    }
    return this.listFacts({ includeArchived: true, includePending: true })
  }

  /**
   * The rows the consolidation pass is offered for one draft.
   *
   * The shortlist is pure lexical recall, which is the one job lexical scoring is
   * genuinely good at: measured across catalogue sizes from 5 to 1955 entries, the
   * row that should match ranked first every time. Precision is the model's job.
   *
   * Boundary and pinned rows ride along regardless of the query — they are the ones
   * a duplicate must not be created alongside, and they are few by definition.
   */
  shortlist(text: string, limit: number, protectedLimit = MAX_PROTECTED_CANDIDATES): MemoryFact[] {
    const pool = this.s().facts.filter((fact) => !fact.archived && !fact.supersededBy)
    const ranked = this.ensureIndex()
      .rank(pool, text, limit)
      .map((entry) => entry.fact)
    return this.assembleShortlist(pool, ranked, protectedLimit)
  }

  /**
   * The same shortlist, with rows the caller is itself asking about removed.
   *
   * The tidy-up compares stored rows with each other, so without this every row
   * would be offered to itself as its own best match.
   */
  shortlistExcluding(
    text: string,
    limit: number,
    excludeIds: ReadonlySet<string>,
    protectedLimit = MAX_PROTECTED_CANDIDATES
  ): MemoryFact[] {
    const pool = this.s().facts.filter(
      (fact) => !fact.archived && !fact.supersededBy && !excludeIds.has(fact.id)
    )
    const ranked = this.ensureIndex()
      .rank(pool, text, limit)
      .map((entry) => entry.fact)
    return this.assembleShortlist(pool, ranked, protectedLimit)
  }

  private assembleShortlist(
    pool: MemoryFact[],
    ranked: MemoryFact[],
    protectedLimit: number
  ): MemoryFact[] {
    const seen = new Set(ranked.map((fact) => fact.id))
    const protectedFacts: MemoryFact[] = []
    for (const fact of pool) {
      if (seen.has(fact.id)) continue
      if (fact.kind !== 'boundary' && !fact.pinned) continue
      seen.add(fact.id)
      protectedFacts.push(fact)
      if (protectedFacts.length >= protectedLimit) break
    }

    return [...ranked, ...protectedFacts]
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
    // A superseded fact is one the user has since contradicted, so it must not
    // come back from a pin or an old index either.
    const pool = snapshot.facts.filter((fact) => !fact.pending && !fact.supersededBy)
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
