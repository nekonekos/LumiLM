import type { ChatRequest, ChatRequestMessage, MemoryKind } from '@shared/types'
import { DEFAULT_SAMPLING } from '@shared/types'
import type { ChatTimings, CompleteOptions, CompletionResult } from '../llama/client'
import { logger } from '../util/logger'
import { localDayKey, shortDayKey } from './day'
import { withPrefill } from './extract'

/**
 * The silent consolidation pass.
 *
 * Memory extraction on its own cannot avoid duplicates: it re-reads the same
 * conversation every turn, so the same fact comes back re-worded and lexical
 * similarity is nowhere near strong enough to see it. Measured on the reference
 * model, a true paraphrase («很烦人» vs «感到烦恼») scores 0.40 on IDF cosine while
 * two facts that merely share a topic reach 0.74 — there is no threshold that
 * separates them, so the decision has to come from the model.
 *
 * The catalogue must **not** be folded into the extraction call, though: measured,
 * the model then copies a catalogue entry straight into its facts array, and the
 * memory-strategy prompt itself becomes a contamination risk once it shares a
 * context with the extraction instructions. Hence a second, independent call whose
 * context is only the two short tables below.
 *
 * The safety property that makes this acceptable is structural, not prompt-based:
 * this pass can only ever return a *decision*. It never supplies fact text, its
 * `of` is an index into a list we built, and anything that does not parse is
 * discarded. Even if it echoed the strategy prompt verbatim, nothing of it can
 * reach the store.
 */

/** Opening of the assistant turn the pass continues from, so it never thinks. */
export const CONSOLIDATE_PREFILL = '{"verdicts": [{"i": 0, "op": "'

/** Rows the pass is shown at most; a bounded prompt regardless of store size. */
export const MAX_CANDIDATES = 10
/** Boundary and pinned rows are always offered, on top of the ranked shortlist. */
export const MAX_PROTECTED_CANDIDATES = 4
/** One entry per candidate plus wrapper, with room for a rambling `why`. */
const MAX_VERDICT_TOKENS = 220

const MAX_WHY_CHARS = 24

/** What the pass is told about an existing row. Deliberately not the real id. */
export interface ConsolidationCandidate {
  id: string
  text: string
  kind: MemoryKind
  /** newest occurrence, or null when the row has no timeline */
  lastAt: number | null
}

export interface ConsolidationInput {
  text: string
  kind: MemoryKind
}

export interface ConsolidationDecision {
  op: 'new' | 'same' | 'supersede'
  /** the row the decision applies to; null when the pass named none */
  targetId: string | null
  why: string
}

export interface ConsolidationClient {
  complete(
    request: ChatRequest,
    options?: CompleteOptions,
    signal?: AbortSignal
  ): Promise<CompletionResult>
}

export interface ConsolidationResult {
  /** one entry per draft, in order */
  decisions: ConsolidationDecision[]
  raw: string
  timings: ChatTimings
}

const OPS: readonly ConsolidationDecision['op'][] = ['new', 'same', 'supersede']

/**
 * The instruction, and the reason it is worded the way it is.
 *
 * The model is asked only what a *text* says about another *text*. Date reasoning
 * was tried here and removed: asked to choose between "same" and "occurrence" the
 * model sat on a knife edge (10/13 both ways depending on one clause), so the
 * timeline decision was moved into code where the turn's timestamp is known. This
 * version scores 13/13.
 */
const CONSOLIDATE_INSTRUCTION = `作为记忆整理器工作。你没有对话上下文，只能看到下面两张表。

【已有记忆】是数据库里的条目。【新候选】是刚刚从对话里抽出的候选事实。
逐条判断每个候选和已有记忆的关系：
- "same": 候选和某条已有记忆说的是同一件事，只是措辞、程度或角度不同。同一件事后来又发生一次也算 same。
- "supersede": 候选和某条已有记忆互相矛盾，新的覆盖旧的。
- "new": 候选和所有已有记忆都无关。

只输出 JSON，不要解释。每一项: {"i": 序号, "op": "same|supersede|new", "of": "已有记忆编号，没有就写 null", "why": "不超过10个字"}
外层: {"verdicts": [...]}`

function candidateLine(candidate: ConsolidationCandidate, index: number): string {
  const when =
    candidate.lastAt === null ? '' : `（最近 ${shortDayKey(localDayKey(candidate.lastAt))}）`
  return `#${index + 1} ${candidate.kind} ${candidate.text}${when}`
}

/**
 * Builds the pass request.
 *
 * `cache_prompt` is still passed, but there is nothing to reuse here — the context
 * is the two tables and nothing else, which is the point: it cannot grow with the
 * conversation, so a 500-message chat costs exactly as much as a new one.
 */
export function buildConsolidationRequest(
  drafts: ConsolidationInput[],
  candidates: ConsolidationCandidate[]
): ChatRequest {
  const body = [
    '【已有记忆】',
    candidates.length > 0 ? candidates.map(candidateLine).join('\n') : '（空）',
    '',
    '【新候选】',
    drafts.map((draft, index) => `${index}. ${draft.kind} ${draft.text}`).join('\n')
  ].join('\n')

  const messages: ChatRequestMessage[] = [
    { role: 'user', content: `${CONSOLIDATE_INSTRUCTION}\n\n${body}` },
    { role: 'assistant', content: CONSOLIDATE_PREFILL }
  ]

  return {
    streamId: 'memory-consolidate',
    conversationId: 'memory',
    modelId: null,
    // A fixed, tiny system prompt keeps this call independent of the persona.
    systemPrompt: '你是记忆整理器。',
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
      maxTokens: MAX_VERDICT_TOKENS
    }
  }
}

/**
 * Reads the verdicts, discarding everything that is not a usable decision.
 *
 * Every field is validated against the request we sent: `i` must address a real
 * draft and `of` must address a real candidate. A verdict that fails either test
 * becomes `null`, and the caller treats that as a plain insert plus the lexical
 * backstop — losing a fact is the one outcome that is never acceptable.
 */
export function parseConsolidationVerdicts(
  raw: string,
  draftCount: number,
  candidates: ConsolidationCandidate[]
): (ConsolidationDecision | null)[] {
  const out: (ConsolidationDecision | null)[] = new Array(draftCount).fill(null)

  let payload: unknown = null
  const attempts = [raw, raw.replace(/,\s*([}\]])/g, '$1')]
  for (const attempt of attempts) {
    try {
      payload = JSON.parse(attempt)
      break
    } catch {
      /* try the next repair */
    }
  }
  if (typeof payload !== 'object' || payload === null) return out

  const list = (payload as { verdicts?: unknown }).verdicts
  if (!Array.isArray(list)) return out

  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>

    const index = typeof record.i === 'number' ? record.i : Number(record.i)
    if (!Number.isInteger(index) || index < 0 || index >= draftCount) continue

    const op = typeof record.op === 'string' ? record.op.trim().toLowerCase() : ''
    if (!OPS.includes(op as ConsolidationDecision['op'])) continue

    // The model answers with a bare number (`3`), a string (`"3"`) or the form we
    // printed (`"#3"`). All three mean the same slot.
    const rawOf = typeof record.of === 'string' ? record.of.trim() : record.of
    const slot = rawOf === null || rawOf === undefined || rawOf === '' ? 0 : Number(String(rawOf).replace(/^#/, ''))
    const target = Number.isInteger(slot) && slot >= 1 && slot <= candidates.length
      ? candidates[slot - 1]
      : null

    // A relation with nothing to relate to is not a decision: leave it null so the
    // caller falls back to the lexical check instead of trusting a phantom target.
    if (op !== 'new' && target === null) continue

    out[index] = {
      op: op as ConsolidationDecision['op'],
      targetId: target?.id ?? null,
      why: typeof record.why === 'string' ? record.why.trim().slice(0, MAX_WHY_CHARS) : ''
    }
  }

  return out
}

/**
 * Runs the pass and returns one decision per draft.
 *
 * Any failure — a dead model, an unparsable answer, a timeout — comes back as
 * `new`/null rather than throwing: the caller must be able to store the facts
 * regardless. The one exception is the whole call failing, which the caller logs
 * and treats as "no consolidation available".
 */
export async function consolidateFacts(
  client: ConsolidationClient,
  drafts: ConsolidationInput[],
  candidates: ConsolidationCandidate[],
  signal?: AbortSignal
): Promise<ConsolidationResult | null> {
  if (drafts.length === 0) return null

  // With nothing stored there is nothing to compare against, and asking would
  // only burn a model call to be told "new" for every draft.
  if (candidates.length === 0) {
    return {
      decisions: drafts.map(() => ({ op: 'new' as const, targetId: null, why: '' })),
      raw: '',
      timings: { promptTokens: 0, completionTokens: 0 }
    }
  }

  const request = buildConsolidationRequest(drafts, candidates)
  const result = await client.complete(request, { extraBody: { cache_prompt: true } }, signal)
  const raw = withPrefill(CONSOLIDATE_PREFILL, result.content)
  const parsed = parseConsolidationVerdicts(raw, drafts.length, candidates)
  const decisions = parsed.map(
    (decision) => decision ?? { op: 'new' as const, targetId: null, why: '' }
  )

  logger.info(
    'memory',
    `consolidated ${drafts.length} draft(s) against ${candidates.length} row(s): ${decisions
      .map((decision) => decision.op)
      .join(',')}`
  )

  return { decisions, raw, timings: result.timings }
}
