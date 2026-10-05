import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryEpisode, MemoryFact, MemoryHit, PersonaCard, RelationshipState } from '@shared/types'
import { BUILTIN_PERSONA_CARD, DEFAULT_CARE_BASELINE } from '@shared/types'
import { writeJsonAtomicSync } from '../util/atomic-json'
import { logger, toError } from '../util/logger'
import { ensureDataDirs, getPaths } from '../store/paths'
import { renderTemplate } from '../agent/template'
import { estimateTokens } from '../agent/budget'
import { shortDayKey } from '../memory/day'

const CARD_VERSION = 1

/** The builtin card is seeded to disk once so it is editable like any other. */
const BUILTIN_ID = BUILTIN_PERSONA_CARD.id

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/* ------------------------------------------------------------------ */
/* Reading and writing cards                                          */
/* ------------------------------------------------------------------ */

export function emptyCard(): PersonaCard {
  const now = Date.now()
  return {
    id: randomUUID(),
    name: '',
    avatarFile: null,
    identity: '',
    personality: '',
    speechStyle: '',
    relationship: '',
    boundaries: '',
    examples: '',
    firstMessage: '',
    scenario: '',
    notes: '',
    careBaseline: DEFAULT_CARE_BASELINE,
    builtin: false,
    createdAt: now,
    updatedAt: now
  }
}

/** Rebuilds a trusted card from whatever a file or an import contained. */
export function normalizeCard(raw: unknown): PersonaCard | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>

  const name = asString(value.name).trim()
  if (name.length === 0) return null

  const now = Date.now()
  const createdAt = typeof value.createdAt === 'number' ? value.createdAt : now

  return {
    id: asString(value.id).trim() || randomUUID(),
    name: name.slice(0, 60),
    avatarFile: typeof value.avatarFile === 'string' ? value.avatarFile : null,
    identity: asString(value.identity),
    personality: asString(value.personality),
    speechStyle: asString(value.speechStyle),
    relationship: asString(value.relationship),
    boundaries: asString(value.boundaries),
    examples: asString(value.examples),
    firstMessage: asString(value.firstMessage),
    scenario: asString(value.scenario),
    notes: asString(value.notes),
    careBaseline: asString(value.careBaseline, DEFAULT_CARE_BASELINE),
    builtin: value.builtin === true,
    createdAt,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : createdAt
  }
}

/* ------------------------------------------------------------------ */
/* SillyTavern V2 interoperability                                    */
/* ------------------------------------------------------------------ */

/** `mes_example` uses `<START>` between exchanges; blank lines read better. */
function normalizeExamples(text: string): string {
  return text
    .replace(/<START>/gi, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface SillyTavernCard {
  spec?: string
  spec_version?: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Converts a SillyTavern V2 or V1 card into a LumiLM persona card.
 *
 * The fields do not line up one to one, so the description is split between
 * identity and personality: the first paragraph usually says who the character
 * is, the rest says how they behave.
 */
export function fromSillyTavern(raw: unknown): PersonaCard | null {
  if (typeof raw !== 'object' || raw === null) return null
  const outer = raw as SillyTavernCard
  const data = (
    outer.data && typeof outer.data === 'object' ? outer.data : outer
  ) as Record<string, unknown>

  const name = asString(data.name).trim()
  if (name.length === 0) return null

  const description = asString(data.description).trim()
  const paragraphs = description.split(/\n{2,}/)
  const identity = paragraphs[0]?.trim() ?? ''
  const personality = paragraphs.slice(1).join('\n\n').trim()

  const card = emptyCard()
  return {
    ...card,
    name: name.slice(0, 60),
    identity,
    personality,
    speechStyle: asString(data.personality).trim(),
    scenario: asString(data.scenario).trim(),
    firstMessage: asString(data.first_mes).trim(),
    examples: normalizeExamples(asString(data.mes_example)),
    notes: asString(data.creator_notes).trim()
  }
}

/** Converts a persona card back into a V2 card other apps can read. */
export function toSillyTavern(card: PersonaCard): SillyTavernCard {
  const description = [card.identity, card.personality].filter((part) => part.trim()).join('\n\n')
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: card.name,
      description,
      personality: card.speechStyle,
      scenario: card.scenario,
      first_mes: card.firstMessage,
      mes_example: card.examples.replace(/\n{2,}/g, '\n<START>\n'),
      creator_notes: card.notes
    }
  }
}

/**
 * Reads a card file in any of the three shapes seen in the wild: a V2 card
 * wrapper, a flat V1 card, or a LumiLM card exported by this app.
 */
export function parseCardFile(text: string): PersonaCard | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    logger.warn('persona', 'card file is not valid json')
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>

  // Our own export keeps the native field names and is the most faithful.
  const native = normalizeCard(record)
  if (native && (record.identity !== undefined || record.speechStyle !== undefined)) {
    return { ...native, id: randomUUID(), builtin: false, updatedAt: Date.now() }
  }

  const converted = fromSillyTavern(record)
  if (converted) return converted

  return native
}

/* ------------------------------------------------------------------ */
/* Storage                                                            */
/* ------------------------------------------------------------------ */

function personasDir(): string {
  return getPaths().personasDir
}

function cardFile(id: string): string {
  return join(personasDir(), `${id}.json`)
}

function readCards(): PersonaCard[] {
  const dir = personasDir()
  if (!existsSync(dir)) return []

  const cards: PersonaCard[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json') || entry.startsWith('.')) continue
    try {
      const raw = JSON.parse(readFileSync(join(dir, entry), 'utf8')) as unknown
      const card = normalizeCard(raw)
      if (card) cards.push(card)
    } catch (error) {
      logger.warn('persona', `skipping unreadable card ${entry}: ${toError(error).message}`)
    }
  }

  return cards.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Writes the builtin card out on first run so the user can edit it in place.
 * It is seeded whenever the folder holds no cards at all, which keeps the
 * companion from ever ending up without a persona to speak with.
 */
function ensureSeeded(): void {
  ensureDataDirs()
  const dir = personasDir()
  const hasAny = existsSync(dir) && readdirSync(dir).some((entry) => entry.endsWith('.json'))
  if (hasAny) return
  try {
    writeJsonAtomicSync(cardFile(BUILTIN_ID), { version: CARD_VERSION, ...BUILTIN_PERSONA_CARD })
  } catch (error) {
    logger.warn('persona', `failed to seed the builtin card: ${toError(error).message}`)
  }
}

export function listCards(): PersonaCard[] {
  ensureSeeded()
  const cards = readCards()
  if (cards.length === 0) return [{ ...BUILTIN_PERSONA_CARD }]
  return cards
}

export function getCard(id: string | null | undefined): PersonaCard | null {
  if (!id) return null
  ensureSeeded()
  return readCards().find((card) => card.id === id) ?? null
}

/**
 * Resolves the card a conversation should use, falling back through the
 * preference, the first stored card and finally the builtin one — the
 * companion must always have a persona to speak with.
 */
export function resolveCard(
  preferred: string | null | undefined,
  overrideId?: string | null
): PersonaCard {
  const cards = listCards()
  const wanted = overrideId ?? preferred
  if (wanted) {
    const match = cards.find((card) => card.id === wanted) ?? getCard(wanted)
    if (match) return match
  }
  return cards[0] ?? { ...BUILTIN_PERSONA_CARD }
}

export function saveCard(card: PersonaCard): PersonaCard[] {
  ensureDataDirs()
  const normalized = normalizeCard({ ...card, updatedAt: Date.now() })
  if (!normalized) throw new Error('CARD_NAME_REQUIRED')

  try {
    writeJsonAtomicSync(cardFile(normalized.id), { version: CARD_VERSION, ...normalized })
  } catch (error) {
    logger.error('persona', `failed to save card: ${toError(error).message}`)
    throw error
  }
  return listCards()
}

export function removeCard(id: string): PersonaCard[] {
  const file = cardFile(id)
  try {
    if (existsSync(file)) unlinkSync(file)
    if (existsSync(`${file}.bak`)) unlinkSync(`${file}.bak`)
  } catch (error) {
    logger.warn('persona', `failed to delete card ${id}: ${toError(error).message}`)
  }
  return listCards()
}

/** Re-creates the shipped card after it was edited or deleted. */
export function restoreBuiltinCard(): PersonaCard[] {
  ensureDataDirs()
  writeJsonAtomicSync(cardFile(BUILTIN_ID), { version: CARD_VERSION, ...BUILTIN_PERSONA_CARD })
  return listCards()
}

/* ------------------------------------------------------------------ */
/* Rendering                                                          */
/* ------------------------------------------------------------------ */

export interface PersonaRenderResult {
  text: string
  /** estimated tokens, so the editor can warn before the budget is blown */
  tokens: number
  /** true when the text had to be cut down to `tokenLimit` */
  truncated: boolean
}

/**
 * Renders the static persona prefix.
 *
 * This string is the first system message and must stay byte-identical across
 * turns: llama.cpp reuses the KV cache for a matching prefix, and that reuse is
 * what keeps a full 8192 context affordable on an 8 GB card. Anything that
 * changes per turn belongs in the memory block instead.
 */
export function renderPersona(
  card: PersonaCard,
  template: string,
  tokenLimit: number
): PersonaRenderResult {
  const text = renderTemplate(template, {
    name: card.name,
    identity: card.identity,
    personality: card.personality,
    speechStyle: card.speechStyle,
    relationship: card.relationship,
    boundaries: card.boundaries,
    examples: normalizeExamples(card.examples),
    scenario: card.scenario,
    notes: card.notes,
    care: card.careBaseline
  })

  const tokens = estimateTokens(text)
  if (tokenLimit <= 0 || tokens <= tokenLimit) return { text, tokens, truncated: false }

  // Cut on a line boundary so the persona never ends mid-instruction.
  const lines = text.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    const candidate = [...kept, line].join('\n')
    if (estimateTokens(candidate) > tokenLimit) break
    kept.push(line)
  }

  const truncated = kept.join('\n').trim()
  logger.warn(
    'persona',
    `persona is ${tokens} tokens, trimmed to ${estimateTokens(truncated)} (limit ${tokenLimit})`
  )
  return { text: truncated, tokens: estimateTokens(truncated), truncated: true }
}

/** One line describing where the relationship stands right now. */
export function renderRelationship(relationship: RelationshipState, name: string): string {
  const parts = [`阶段: ${relationship.stage}`]
  if (relationship.nicknameForAssistant) parts.push(`她自称: ${relationship.nicknameForAssistant}`)
  if (relationship.nicknameForUser) parts.push(`她叫你: ${relationship.nicknameForUser}`)
  if (relationship.mood) parts.push(`她当下的心情: ${relationship.mood}`)
  if (relationship.knownSince > 0) {
    const days = Math.max(1, Math.floor((Date.now() - relationship.knownSince) / 86_400_000))
    parts.push(`你们认识: ${days} 天`)
  }
  parts.push(`亲密度: ${relationship.affinity}/100`)
  return `${name} 与用户的关系 — ${parts.join(' | ')}`
}

/**
 * A remembered fact as one line.
 *
 * An event that has happened before carries its history with it. 「加班到很晚」 and
 * 「这是第三次加班，最近一次是昨天」 are different things to be told, and the second
 * is the whole point of tracking occurrences: without it the timeline would exist
 * in the library and nowhere the model can see.
 */
export function factLine(fact: MemoryFact, now = Date.now()): string {
  const latest = fact.occurrences[0]
  if (!latest) return fact.text

  const days = Math.max(0, Math.floor((now - latest.at) / 86_400_000))
  const when =
    days === 0 ? '最近一次是今天' : days === 1 ? '最近一次是昨天' : `最近一次 ${shortDayKey(latest.dateKey)}`
  const times = fact.occurrences.length > 1 ? `已发生 ${fact.occurrences.length} 次，` : ''
  return `${fact.text}（${times}${when}）`
}

export function renderMemories(hits: MemoryHit[]): string {
  return hits
    .filter((hit) => hit.fact.kind !== 'boundary')
    .map((hit) => `- ${factLine(hit.fact)}`)
    .join('\n')
}

/**
 * Boundary facts are rendered first and in their own section: they describe
 * things the companion must never forget or trample on.
 */
export function renderBoundaries(hits: MemoryHit[]): string {
  return hits
    .filter((hit) => hit.fact.kind === 'boundary')
    .map((hit) => `- ${hit.fact.text}`)
    .join('\n')
}

export function renderEpisodes(episodes: MemoryEpisode[]): string {
  return episodes
    .slice(0, 5)
    .map((episode) => {
      const highlights = episode.highlights.length > 0 ? `（${episode.highlights.join('；')}）` : ''
      return `- ${episode.date}：${episode.summary}${highlights}`
    })
    .join('\n')
}

/** File name a card should be exported under. */
export function cardFileName(card: PersonaCard): string {
  const safe = card.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'persona'
  return `${safe}.json`
}
