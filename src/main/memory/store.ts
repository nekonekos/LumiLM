import { existsSync, statSync } from 'node:fs'
import type {
  HeartbeatBookkeeping,
  MemoryEpisode,
  MemoryFact,
  MemorySnapshot,
  RelationshipState,
  SeedThought,
  SessionMemory
} from '@shared/types'
import {
  DEFAULT_HEARTBEAT,
  DEFAULT_RELATIONSHIP,
  MEMORY_STORE_VERSION,
  MAX_MEMORY_EPISODES,
  MAX_MEMORY_FACTS,
  SEED_THOUGHT_TTL_MS
} from '@shared/types'
import { readJsonSync, writeJsonAtomicSync } from '../util/atomic-json'
import { logger, toError } from '../util/logger'

/**
 * Storage contract for the long-term memory layer.
 *
 * Only the JSON backend is implemented: the project already persists every
 * other store through `writeJsonAtomicSync`, and the row count this layer is
 * sized for (a few thousand) does not justify a native module — which would
 * also drag the portable build into an electron-rebuild toolchain. The
 * interface exists so a SQLite backend can be dropped in later without
 * touching `manager.ts`.
 */
export interface MemoryBackend {
  load(): MemorySnapshot
  save(snapshot: MemorySnapshot): void
  flush(): void
  sizeBytes(): number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asBool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

export function normalizeRelationship(raw: unknown): RelationshipState {
  const value = isPlainObject(raw) ? raw : {}
  return {
    stage: asString(value.stage, DEFAULT_RELATIONSHIP.stage),
    affinity: Math.min(100, Math.max(0, asNumber(value.affinity, DEFAULT_RELATIONSHIP.affinity))),
    nicknameForUser: typeof value.nicknameForUser === 'string' ? value.nicknameForUser : null,
    nicknameForAssistant:
      typeof value.nicknameForAssistant === 'string' ? value.nicknameForAssistant : null,
    mood: typeof value.mood === 'string' ? value.mood : null,
    knownSince: asNumber(value.knownSince, 0),
    lastInteractionAt: asNumber(value.lastInteractionAt, 0)
  }
}

export function normalizeHeartbeat(raw: unknown): HeartbeatBookkeeping {
  const value = isPlainObject(raw) ? raw : {}
  return {
    lastGreetingAt: asNumber(value.lastGreetingAt, 0),
    lastCheckAt: asNumber(value.lastCheckAt, 0),
    todayCount: asNumber(value.todayCount, 0),
    dayKey: asString(value.dayKey, ''),
    unansweredStreak: asNumber(value.unansweredStreak, 0),
    snoozeUntil: asNumber(value.snoozeUntil, 0),
    lastDreamAt: asNumber(value.lastDreamAt, 0)
  }
}

export function normalizeFact(raw: unknown): MemoryFact | null {
  if (!isPlainObject(raw)) return null
  const text = asString(raw.text).trim()
  const id = asString(raw.id)
  if (id.length === 0 || text.length === 0) return null

  const createdAt = asNumber(raw.createdAt, Date.now())
  return {
    id,
    text,
    kind: (raw.kind as MemoryFact['kind']) ?? 'other',
    subject: (raw.subject as MemoryFact['subject']) ?? 'user',
    importance: Math.min(5, Math.max(1, Math.round(asNumber(raw.importance, 3)))),
    confidence: Math.min(1, Math.max(0, asNumber(raw.confidence, 0.5))),
    createdAt,
    updatedAt: asNumber(raw.updatedAt, createdAt),
    lastUsedAt: asNumber(raw.lastUsedAt, 0),
    useCount: asNumber(raw.useCount, 0),
    reinforcements: asNumber(raw.reinforcements, 0),
    sourceConversationId:
      typeof raw.sourceConversationId === 'string' ? raw.sourceConversationId : null,
    sourceMessageIds: asStringArray(raw.sourceMessageIds),
    pinned: asBool(raw.pinned),
    suppressed: asBool(raw.suppressed),
    archived: asBool(raw.archived),
    pending: asBool(raw.pending),
    embedding: null
  }
}

function normalizeEpisode(raw: unknown): MemoryEpisode | null {
  if (!isPlainObject(raw)) return null
  const id = asString(raw.id)
  if (id.length === 0) return null
  return {
    id,
    date: asString(raw.date),
    conversationId: typeof raw.conversationId === 'string' ? raw.conversationId : null,
    summary: asString(raw.summary),
    highlights: asStringArray(raw.highlights),
    emotion: typeof raw.emotion === 'string' ? raw.emotion : null,
    createdAt: asNumber(raw.createdAt, Date.now())
  }
}

function normalizeSeed(raw: unknown): SeedThought | null {
  if (!isPlainObject(raw)) return null
  const id = asString(raw.id)
  const text = asString(raw.text).trim()
  if (id.length === 0 || text.length === 0) return null
  const createdAt = asNumber(raw.createdAt, Date.now())
  return {
    id,
    text,
    createdAt,
    expiresAt: asNumber(raw.expiresAt, createdAt + SEED_THOUGHT_TTL_MS)
  }
}

export function emptySnapshot(): MemorySnapshot {
  return {
    version: MEMORY_STORE_VERSION,
    facts: [],
    episodes: [],
    // knownSince stays 0 until the first real interaction, so the UI can tell
    // "you just met" from "you have known each other for 40 days".
    relationship: { ...DEFAULT_RELATIONSHIP },
    seeds: [],
    sessions: []
  }
}

const MAX_SESSIONS = 200

function normalizeSession(raw: unknown): SessionMemory | null {
  if (!isPlainObject(raw)) return null
  const conversationId = asString(raw.conversationId)
  if (conversationId.length === 0) return null

  const facts: MemoryFact[] = []
  for (const entry of Array.isArray(raw.facts) ? raw.facts : []) {
    const fact = normalizeFact(entry)
    if (fact) facts.push(fact)
  }

  return {
    conversationId,
    summary: asString(raw.summary),
    summaryUpTo: asNumber(raw.summaryUpTo, 0),
    facts,
    extractedUpTo: asNumber(raw.extractedUpTo, 0),
    updatedAt: asNumber(raw.updatedAt, Date.now())
  }
}

/** Rebuilds a trusted snapshot from whatever happens to be on disk. */
export function normalizeSnapshot(raw: unknown): MemorySnapshot {
  if (!isPlainObject(raw)) return emptySnapshot()

  const facts: MemoryFact[] = []
  for (const entry of Array.isArray(raw.facts) ? raw.facts : []) {
    const fact = normalizeFact(entry)
    if (fact) facts.push(fact)
  }

  const episodes: MemoryEpisode[] = []
  for (const entry of Array.isArray(raw.episodes) ? raw.episodes : []) {
    const episode = normalizeEpisode(entry)
    if (episode) episodes.push(episode)
  }
  episodes.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  const seeds: SeedThought[] = []
  for (const entry of Array.isArray(raw.seeds) ? raw.seeds : []) {
    const seed = normalizeSeed(entry)
    if (seed) seeds.push(seed)
  }

  const sessions: SessionMemory[] = []
  for (const entry of Array.isArray(raw.sessions) ? raw.sessions : []) {
    const session = normalizeSession(entry)
    if (session) sessions.push(session)
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt)

  return {
    version: MEMORY_STORE_VERSION,
    // Newest first, so the truncation below drops the oldest tail.
    facts: facts.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_MEMORY_FACTS),
    episodes: episodes.slice(0, MAX_MEMORY_EPISODES),
    relationship: normalizeRelationship(raw.relationship),
    seeds,
    sessions: sessions.slice(0, MAX_SESSIONS)
  }
}

/**
 * A JSON document held in memory and written back through the same atomic
 * write the rest of the app uses. Writes are debounced because extraction
 * touches the store on every turn.
 */
export class JsonMemoryStore implements MemoryBackend {
  private snapshot: MemorySnapshot | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly file: string,
    private readonly delayMs = 400
  ) {}

  load(): MemorySnapshot {
    if (this.snapshot) return this.snapshot
    this.snapshot = normalizeSnapshot(readJsonSync<unknown>(this.file))
    return this.snapshot
  }

  save(snapshot: MemorySnapshot): void {
    this.snapshot = snapshot
    this.schedule()
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.delayMs)
    this.timer.unref?.()
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.snapshot) return
    try {
      writeJsonAtomicSync(this.file, this.snapshot)
    } catch (error) {
      logger.error('memory', `failed to persist memory: ${toError(error).message}`)
    }
  }

  sizeBytes(): number {
    try {
      return existsSync(this.file) ? statSync(this.file).size : 0
    } catch {
      return 0
    }
  }
}

/** The same debounced atomic write, for the small heartbeat bookkeeping file. */
export class JsonDocStore<T> {
  private value: T | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly file: string,
    private readonly normalize: (raw: unknown) => T,
    private readonly fallback: () => T,
    private readonly delayMs = 400
  ) {}

  get(): T {
    if (this.value === null) {
      const raw = readJsonSync<unknown>(this.file)
      this.value = raw === null ? this.fallback() : this.normalize(raw)
    }
    return this.value
  }

  set(value: T): void {
    this.value = value
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.delayMs)
    this.timer.unref?.()
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.value === null) return
    try {
      writeJsonAtomicSync(this.file, this.value)
    } catch (error) {
      logger.error('memory', `failed to persist ${this.file}: ${toError(error).message}`)
    }
  }
}

/** Convenience factory the manager uses for the heartbeat file. */
export function createHeartbeatStore(file: string): JsonDocStore<HeartbeatBookkeeping> {
  return new JsonDocStore<HeartbeatBookkeeping>(
    file,
    normalizeHeartbeat,
    () => ({ ...DEFAULT_HEARTBEAT })
  )
}
