import type {
  ChatRequest,
  ChatRequestMessage,
  MemoryKind,
  MemorySubject,
  RelationshipState
} from '@shared/types'
import { DEFAULT_SAMPLING } from '@shared/types'
import type { ChatTimings, CompleteOptions, CompletionResult } from '../llama/client'
import { normalizeJsonish } from '../agent/tool-text'
import { logger } from '../util/logger'
import type { MemoryDraft } from './manager'

/**
 * Background memory extraction.
 *
 * Everything here is built around one measured fact (see the plan's Phase 0):
 * on a thinking model, asking for JSON in the prompt costs ~30 seconds because
 * the whole reasoning block is generated first. Continuing from an
 * *assistant message that already contains the opening brace* skips that block
 * entirely — 0 reasoning tokens, ~24 generated tokens, under a second. The same
 * request reuses the KV cache of the turn that just finished, so the prompt is
 * nearly free too.
 */

/** The client surface this module needs; `LlamaClient` satisfies it. */
export interface CompletionClient {
  complete(
    request: ChatRequest,
    options?: CompleteOptions,
    signal?: AbortSignal
  ): Promise<CompletionResult>
}

/**
 * Opening of the assistant message the extractor continues from.
 *
 * The prefill deliberately carries a *first fact's* opening rather than the
 * bare `{"facts": [`. A short skeleton invites the model to close it with the
 * shortest legal completion — measured `{"facts": [null]}` on a 9B model, which
 * loses every fact — while starting the first item's text forces it to actually
 * write one.
 */
export const FACTS_PREFILL = '{"facts": [{"text": "'
export const RELATIONSHIP_PREFILL = '{"mood": '
export const SUMMARY_PREFILL = '{"summary": "'

const MAX_FACTS_PER_TURN = 6
const MAX_FACT_CHARS = 200

const KINDS: readonly MemoryKind[] = [
  'identity',
  'preference',
  'event',
  'relationship',
  'goal',
  'boundary',
  'other'
]
const SUBJECTS: readonly MemorySubject[] = ['user', 'assistant', 'shared']

const FACT_INSTRUCTION = `Ignore the roleplay and act as a memory indexer.

Below are the user's own messages from a conversation. List the durable facts about the user worth remembering later.
- Only facts the user actually stated. Never guess, never invent, never infer feelings or intent.
- Never turn the assistant's earlier words into a fact, and never restate something you already know.
- Each fact must be one self-contained sentence in the third person, understandable on its own.
- Prefer lasting things: identity, preferences, habits, important people, ongoing goals, hard boundaries.
- Skip small talk, greetings, questions, and anything that only mattered for one moment.
- At most ${MAX_FACTS_PER_TURN} facts. If there is nothing new worth keeping, output an empty list.
- Output JSON only. No commentary, no markdown.

Each item: {"text": "...", "kind": "identity|preference|event|relationship|goal|boundary|other", "subject": "user|assistant|shared", "importance": 1-5, "confidence": 0-1}`

const RELATIONSHIP_INSTRUCTION = `Ignore the roleplay above and act as a relationship tracker.

Based on the conversation above, describe the current state of the relationship between the user and the assistant.
- "mood" is the assistant's own emotional state right now, a few words.
- "nickname" is what the assistant calls the user, or null if there is no nickname yet.
- "stage" is a short description of the relationship.
- "affinity" is 0-100: how close they have become, counting only what the conversation shows.
- Output JSON only, and do not invent any progress that the conversation does not support.

Shape: {"mood": "...", "nickname": "...", "stage": "...", "affinity": 0-100}`

const SUMMARY_INSTRUCTION = `Ignore the roleplay above and act as a note taker.

Write a short summary of what happened in the conversation above, from the assistant's point of view, that the assistant would want to remember at the start of the next conversation.
- At most 3 sentences. Plain prose, no lists, no headings.
- Keep names, plans and open questions. Drop small talk.

Shape: {"summary": "..."}`

/**
 * The language reminder is appended after the whole instruction rather than
 * stated once in the middle of a bullet list.
 *
 * A 9B model reads the last line it was given far more reliably than the fifth
 * bullet: with the rule only in the list it answered 「我住在杭州」 in English,
 * because the instruction itself is English and the model mirrored it.
 */
const LANGUAGE_NUDGE: Record<Script, string> = {
  zh: '以上对话是中文的。所有 text 字段必须用中文书写。',
  en: 'The conversation above is in English. Write every "text" value in English.',
  ja: '上の会話は日本語です。すべての text は日本語で書いてください。'
}

export type Script = 'zh' | 'en' | 'ja'

/** Picks the language of the history so the extractor answers in kind. */
export function dominantScript(messages: readonly ChatRequestMessage[]): Script {
  let cjk = 0
  let kana = 0
  let latin = 0

  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const char of message.content) {
      const code = char.codePointAt(0) ?? 0
      if (code >= 0x3040 && code <= 0x30ff) kana += 1
      else if (code >= 0x4e00 && code <= 0x9fff) cjk += 1
      else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin += 1
    }
  }

  // Any kana at all means Japanese: a Japanese sentence is mostly kanji, so a
  // CJK-count-only test would misclassify it as Chinese.
  if (kana > 0) return 'ja'
  if (cjk > latin) return 'zh'
  return 'en'
}

/* ------------------------------------------------------------------ */
/* Tolerant JSON reading                                               */
/* ------------------------------------------------------------------ */

function closesFor(open: string): string {
  return open === '{' ? '}' : ']'
}

/** Appends whatever brackets are still open, for output cut off mid-object. */
function closeOpenBrackets(text: string): string {
  const stack: string[] = []
  let inString = false
  let escaped = false

  for (const char of text) {
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (inString) {
      if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{' || char === '[') stack.push(char)
    else if (char === '}' || char === ']') stack.pop()
  }

  if (inString) return `${text}"${stack.reverse().map(closesFor).join('')}`
  return text + stack.reverse().map(closesFor).join('')
}

/** Pulls every balanced `{...}` object out of `text`, ignoring string contents. */
function scrapeObjects(text: string): string[] {
  const objects: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (inString) {
      if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (char === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1))
        start = -1
      }
    }
  }

  return objects
}

/**
 * Rebuilds the whole JSON document from an assistant-prefill continuation.
 *
 * llama.cpp returns the prefilled assistant text as part of `content`, so the
 * document is usually already complete; some builds return only the
 * continuation instead. Both shapes are accepted here, because getting this
 * wrong silently produces `{"facts": [{"facts": [` and loses every fact.
 */
export function withPrefill(prefill: string, content: string): string {
  const trimmed = content.trimStart()
  if (trimmed.startsWith(prefill)) return trimmed
  return `${prefill}${content}`
}

/**
 * Reads the JSON an extractor call produced.
 *
 * The model continues from a prefill, so the text handed in is already the
 * *whole* document; a truncated or sloppy tail is repaired rather than
 * discarded, because an extraction that loses one fact is far better than one
 * that loses all of them.
 */
/** Escapes raw control characters a model left inside a JSON string. */
function escapeRawControls(text: string): string {
  let out = ''
  let inString = false
  let escaped = false

  for (const char of text) {
    if (escaped) {
      escaped = false
      out += char
      continue
    }
    if (char === '\\') {
      escaped = true
      out += char
      continue
    }
    if (char === '"') {
      inString = !inString
      out += char
      continue
    }
    if (inString && (char === '\n' || char === '\r' || char === '\t')) {
      out += char === '\t' ? '\\t' : '\\n'
      continue
    }
    out += char
  }
  return out
}

export function parseExtraction(text: string): unknown {
  const cleaned = escapeRawControls(text)
  const attempts = [
    text,
    cleaned,
    normalizeJsonish(text),
    normalizeJsonish(cleaned),
    normalizeJsonish(closeOpenBrackets(text)),
    normalizeJsonish(closeOpenBrackets(cleaned))
  ]
  for (const attempt of attempts) {
    const trimmed = attempt.trim()
    if (trimmed.length === 0) continue
    try {
      return JSON.parse(trimmed)
    } catch {
      /* try the next repair */
    }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Facts                                                               */
/* ------------------------------------------------------------------ */

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/** Rejects the shapes a small model produces when it refuses the task. */
const REFUSAL_PATTERN =
  /^(i (cannot|can't|can not|am unable)|as an ai|i'm sorry|sorry,)|^(抱歉|对不起|我无法|我不能|作为一个)/i
/**
 * Rejects a fact the model itself flagged as a guess.
 *
 * Asked what the user keeps, a 9B model answers a *question* with
 * 「用户养了某种宠物。」 or, worse, 「…（根据行为推断，但用户未明确说明）」. Neither
 * is something the user stated, and a memory store that admits hedges is worse
 * than one that stays empty — the guess gets injected into every later turn as
 * if it were true.
 */
const HEDGE_PATTERN =
  /某种|某个|大概|可能|也许|似乎|应该是|根据.{0,12}(推断|推测)|未(明确)?(说明|提及)|不确定|some kind|some sort|probably|maybe|perhaps|seems to|i (guess|think)|according to/i
/** A fact shorter than this is a fragment, not a sentence worth keeping. */
const MIN_FACT_CHARS = 4

function toDraft(source: unknown): MemoryDraft | null {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return null
  const record = source as Record<string, unknown>

  // Local models drift on the key name; accept the obvious variants.
  const text =
    readString(record, 'text') ??
    readString(record, 'fact') ??
    readString(record, 'content') ??
    readString(record, 'statement')
  if (!text) return null

  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length < MIN_FACT_CHARS) return null
  if (REFUSAL_PATTERN.test(normalized) || HEDGE_PATTERN.test(normalized)) return null

  const kindRaw = readString(record, 'kind') ?? readString(record, 'type') ?? 'other'
  const subjectRaw = readString(record, 'subject') ?? 'user'
  const importanceRaw = record.importance ?? record.weight ?? record.score
  const confidenceRaw = record.confidence ?? record.certainty

  const importance =
    typeof importanceRaw === 'number' && Number.isFinite(importanceRaw) ? importanceRaw : 3
  const confidence =
    typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw) ? confidenceRaw : 0.6

  return {
    text: normalized.slice(0, MAX_FACT_CHARS),
    kind: KINDS.includes(kindRaw as MemoryKind) ? (kindRaw as MemoryKind) : 'other',
    subject: SUBJECTS.includes(subjectRaw as MemorySubject)
      ? (subjectRaw as MemorySubject)
      : 'user',
    importance: Math.min(5, Math.max(1, Math.round(importance))),
    confidence: Math.min(1, Math.max(0, confidence))
  }
}

function dedupe(drafts: MemoryDraft[]): MemoryDraft[] {
  const seen = new Set<string>()
  const result: MemoryDraft[] = []
  for (const draft of drafts) {
    const key = draft.text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(draft)
  }
  return result
}

/** Reads a facts payload, tolerating every shape the model has produced. */
export function readFacts(payload: unknown): MemoryDraft[] {
  if (Array.isArray(payload)) {
    return dedupe(
      payload
        .map(toDraft)
        .filter((draft): draft is MemoryDraft => draft !== null)
        .slice(0, MAX_FACTS_PER_TURN)
    )
  }

  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>
    for (const key of ['facts', 'items', 'memories', 'results']) {
      if (Array.isArray(record[key])) return readFacts(record[key])
    }
    // A single object instead of a list.
    const single = toDraft(record)
    if (single) return [single]
  }

  return []
}

/** True when the model said "nothing worth keeping", however it spelled it. */
export function isEmptyExtraction(raw: string): boolean {
  // Any non-empty value under a fact key means it did keep something. The
  // closing quote is optional: output cut off mid-string still counts as text.
  return !/"(text|fact|content|statement)"\s*:\s*"(?!\s*")[^"]+/.test(raw)
}

export interface FactsExtraction {
  drafts: MemoryDraft[]
  /** the text the model actually produced, kept for the log line */
  raw: string
  /** the model answered "nothing worth keeping" rather than failing to parse */
  empty: boolean
  timings: ChatTimings
}

export interface ExtractOptions {
  /**
   * The clean conversation, newest assistant reply included.
   *
   * Never pass the injected wire messages here: the extractor would read the
   * "here is what you already know" block as conversation and re-learn its own
   * memories as new facts.
   */
  history: ChatRequestMessage[]
  systemPrompt: string
  signal?: AbortSignal
  maxTokens?: number
  /** tokens of the persona prefix llama.cpp must never evict; 0 leaves it alone */
  nKeep?: number
}

/**
 * The wire request for one extractor call.
 *
 * `history` is passed through untouched so llama.cpp finds the longest common
 * token prefix with the turn that just ran and reuses its KV cache. Only the
 * two trailing messages are new: the instruction, and the assistant turn the
 * model continues from.
 */
export function buildExtractionRequest(
  options: ExtractOptions,
  instruction: string,
  prefill: string
): ChatRequest {
  const messages: ChatRequestMessage[] = [
    ...options.history,
    { role: 'user', content: `${instruction}\n${LANGUAGE_NUDGE[dominantScript(options.history)]}` },
    { role: 'assistant', content: prefill }
  ]

  return {
    streamId: 'memory-extraction',
    conversationId: 'memory',
    modelId: null,
    systemPrompt: options.systemPrompt,
    messages,
    sampling: {
      ...DEFAULT_SAMPLING,
      temperature: 0.1,
      topP: 0.9,
      minP: 0.02,
      repeatPenalty: 1.05,
      repeatLastN: 128,
      presencePenalty: 0,
      frequencyPenalty: 0,
      seed: 1,
      maxTokens: options.maxTokens ?? 400
    }
  }
}

/**
 * `cache_prompt` is llama.cpp's switch for reusing the prefix it already holds.
 * `n_keep` is deliberately left out unless the caller knows the persona length:
 * pinning the wrong count would cost more than it saves.
 */
function extractionBody(options: ExtractOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { cache_prompt: true }
  if (options.nKeep && options.nKeep > 0) body.n_keep = options.nKeep
  return body
}

/**
 * What the fact extractor is allowed to read: the user's own words, in order.
 *
 * The assistant turns are deliberately dropped. A model reading its own reply
 * treats it as evidence and re-learns what it just said — measured, it turned
 * the reply 「小黑呀…」 into a new fact 「用户养了一只叫小黑的小动物」 on every
 * turn, and once produced a fact whose text openly admitted to inferring the
 * species. Collapsing the user turns into one message also keeps the prompt
 * small and avoids handing a chat template two consecutive same-role messages.
 */
export function userStatements(messages: readonly ChatRequestMessage[]): ChatRequestMessage[] {
  const said = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0)
  if (said.length === 0) return []
  return [{ role: 'user', content: said.join('\n') }]
}

export async function extractFacts(
  client: CompletionClient,
  options: ExtractOptions
): Promise<FactsExtraction> {
  const said = userStatements(options.history)
  if (said.length === 0) {
    return {
      drafts: [],
      raw: '',
      empty: true,
      timings: { promptTokens: 0, completionTokens: 0 }
    }
  }
  return runFacts(client, { ...options, history: said })
}

async function runFacts(
  client: CompletionClient,
  options: ExtractOptions
): Promise<FactsExtraction> {
  const request = buildExtractionRequest(options, FACT_INSTRUCTION, FACTS_PREFILL)
  const result = await client.complete(request, { extraBody: extractionBody(options) }, options.signal)

  const raw = withPrefill(FACTS_PREFILL, result.content)
  const payload = parseExtraction(raw)
  let drafts = readFacts(payload)

  if (drafts.length === 0 && result.content.trim().length > 0) {
    // Last resort: the list was cut off before it closed, so salvage what is
    // there object by object.
    const scraped = scrapeObjects(raw)
      .map((object) => parseExtraction(object))
      .map(toDraft)
      .filter((draft): draft is MemoryDraft => draft !== null)
    drafts = dedupe(scraped).slice(0, MAX_FACTS_PER_TURN)
  }

  return { drafts, raw, empty: isEmptyExtraction(raw), timings: result.timings }
}

export interface RelationshipExtraction {
  patch: Partial<RelationshipState>
  raw: string
}

export function readRelationship(payload: unknown): Partial<RelationshipState> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return {}
  const record = payload as Record<string, unknown>
  const patch: Partial<RelationshipState> = {}

  const mood = readString(record, 'mood') ?? readString(record, 'emotion')
  if (mood) patch.mood = mood.slice(0, 40)

  const nickname = record.nickname ?? record.nicknameForUser
  if (typeof nickname === 'string' && nickname.trim().length > 0) {
    patch.nicknameForUser = nickname.trim().slice(0, 24)
  }

  const stage = readString(record, 'stage')
  if (stage) patch.stage = stage.slice(0, 40)

  const affinity = record.affinity ?? record.closeness
  if (typeof affinity === 'number' && Number.isFinite(affinity)) {
    patch.affinity = Math.min(100, Math.max(0, Math.round(affinity)))
  }

  return patch
}

export async function extractRelationship(
  client: CompletionClient,
  options: ExtractOptions
): Promise<RelationshipExtraction> {
  const request = buildExtractionRequest(options, RELATIONSHIP_INSTRUCTION, RELATIONSHIP_PREFILL)
  const result = await client.complete(request, { extraBody: extractionBody(options) }, options.signal)
  const raw = withPrefill(RELATIONSHIP_PREFILL, result.content)
  return { patch: readRelationship(parseExtraction(raw)), raw }
}

export function readSummary(payload: unknown): string | null {
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>
    const summary = readString(record, 'summary') ?? readString(record, 'text')
    if (summary) return summary
  }
  if (typeof payload === 'string' && payload.trim().length > 0) return payload.trim()
  return null
}

export async function buildRollingSummary(
  client: CompletionClient,
  options: ExtractOptions
): Promise<string | null> {
  const request = buildExtractionRequest(options, SUMMARY_INSTRUCTION, SUMMARY_PREFILL)
  const result = await client.complete(request, { extraBody: extractionBody(options) }, options.signal)
  return readSummary(parseExtraction(withPrefill(SUMMARY_PREFILL, result.content)))
}

/* ------------------------------------------------------------------ */
/* Scheduling                                                          */
/* ------------------------------------------------------------------ */

export interface ExtractionJob {
  conversationId: string
  /** the finished turn's wire request, reused verbatim for the cache hit */
  options: ExtractOptions
}

/**
 * Debounces the extraction call that follows a turn.
 *
 * The delay exists so the UI has finished painting the reply before the GPU is
 * asked for more work, and so a user who immediately types again is not kept
 * waiting behind a background job: `cancel()` drops the pending job, and the
 * next turn schedules a fresh one that covers everything up to the newer
 * message anyway.
 */
export class ExtractionQueue {
  private timer: NodeJS.Timeout | null = null
  private pending: ExtractionJob | null = null
  private running = false

  constructor(
    private readonly run: (job: ExtractionJob) => Promise<void>,
    private readonly delayMs: () => number
  ) {}

  schedule(job: ExtractionJob): void {
    this.pending = job
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drain()
    }, Math.max(0, this.delayMs()))
    this.timer.unref?.()
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = null
  }

  private async drain(): Promise<void> {
    if (this.running) return
    const job = this.pending
    this.pending = null
    if (!job) return

    this.running = true
    try {
      await this.run(job)
    } catch (error) {
      logger.warn('memory', `extraction failed: ${String(error)}`)
    } finally {
      this.running = false
    }
  }

  /** Runs whatever is pending right now, used by the dream job and the tests. */
  async flushNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.drain()
  }

  get busy(): boolean {
    return this.running || this.pending !== null
  }

  dispose(): void {
    this.cancel()
  }
}
