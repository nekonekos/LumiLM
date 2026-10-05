import type { MemoryFact, MemoryHit } from '@shared/types'

/**
 * Lexical recall with no embedding model.
 *
 * The app targets an 8 GB card and a single loaded model, so a second model
 * just for retrieval is not an option. CJK text is handled with character
 * bigrams (which needs no dictionary and never mis-segments) and latin text
 * with plain words. That keeps recall deterministic, free and — because every
 * hit carries the terms it matched — explainable in the memory library.
 */
export function tokenizeText(text: string): string[] {
  const tokens: string[] = []
  const lower = text.toLowerCase()

  for (const match of lower.matchAll(/[a-z0-9_]+/g)) {
    if (match[0].length >= 2) tokens.push(match[0])
  }

  let run: string[] = []
  const flush = (): void => {
    if (run.length === 1) tokens.push(run[0])
    else for (let index = 0; index + 1 < run.length; index += 1) tokens.push(run[index] + run[index + 1])
    run = []
  }

  for (const char of lower) {
    const code = char.codePointAt(0) ?? 0
    if (code > 0x2e80) run.push(char)
    else flush()
  }
  flush()

  return tokens
}

/** Half-life of the recency term, in days. */
const RECENCY_HALF_LIFE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

const WEIGHT_LEXICAL = 0.6
const WEIGHT_RECENCY = 0.2
const WEIGHT_IMPORTANCE = 0.2
const PINNED_BOOST = 0.15
const BOUNDARY_BOOST = 0.2

export interface RecallOptions {
  limit: number
  /** the fact ids already injected this turn, so they are not repeated */
  exclude?: Set<string>
  /** inject every boundary fact regardless of the query */
  forceBoundaries?: boolean
  /** always inject this many pinned facts */
  pinnedSlots?: number
  now?: number
}

function recencyScore(fact: MemoryFact, now: number): number {
  const stamp = Math.max(fact.lastUsedAt, fact.updatedAt, fact.createdAt)
  const ageDays = Math.max(0, (now - stamp) / DAY_MS)
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS)
}

function importanceScore(fact: MemoryFact): number {
  return (fact.importance - 1) / 4
}

/**
 * Inverted index over the fact texts. It is rebuilt from the snapshot on
 * startup rather than persisted: at a few thousand facts that costs a few
 * milliseconds and removes a whole class of desynchronisation bugs.
 */
export class LexicalIndex {
  private postings = new Map<string, Set<string>>()
  private documentFrequency = new Map<string, number>()
  private tokenCount = 0

  rebuild(facts: MemoryFact[]): void {
    this.postings = new Map()
    this.documentFrequency = new Map()
    this.tokenCount = 0
    for (const fact of facts) this.add(fact)
  }

  private static tokensFor(fact: MemoryFact): string[] {
    return [...new Set(tokenizeText(fact.text))]
  }

  add(fact: MemoryFact): void {
    const tokens = LexicalIndex.tokensFor(fact)
    this.tokenCount += 1
    for (const token of tokens) {
      const bucket = this.postings.get(token)
      if (bucket) bucket.add(fact.id)
      else this.postings.set(token, new Set([fact.id]))
      this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1)
    }
  }

  remove(fact: MemoryFact): void {
    for (const token of LexicalIndex.tokensFor(fact)) {
      const bucket = this.postings.get(token)
      if (!bucket) continue
      bucket.delete(fact.id)
      if (bucket.size === 0) this.postings.delete(token)
      const frequency = (this.documentFrequency.get(token) ?? 1) - 1
      if (frequency <= 0) this.documentFrequency.delete(token)
      else this.documentFrequency.set(token, frequency)
    }
    this.tokenCount = Math.max(0, this.tokenCount - 1)
  }

  private idf(token: string): number {
    const frequency = this.documentFrequency.get(token) ?? 0
    if (frequency === 0) return 0
    return Math.log(1 + this.tokenCount / frequency)
  }

  /** Raw lexical score plus the matched terms, before any normalisation. */
  private rawScore(fact: MemoryFact, queryTokens: string[]): { score: number; matched: string[] } {
    const factTokens = new Set(tokenizeText(fact.text))
    let score = 0
    const matched: string[] = []

    for (const token of queryTokens) {
      if (!factTokens.has(token)) continue
      const weight = this.idf(token)
      if (weight <= 0) continue
      score += weight
      matched.push(token)
    }

    return { score, matched }
  }

  /**
   * Ranks the catalogue against a query.
   *
   * The strongest lexical match is normalised to 1 so the three terms can be
   * added with fixed weights; a query that matches nothing falls back to
   * recency and importance alone, which is what makes the companion still feel
   * grounded when the user opens with something unrelated.
   */
  recall(facts: MemoryFact[], query: string, options: RecallOptions): MemoryHit[] {
    const now = options.now ?? Date.now()
    const queryTokens = [...new Set(tokenizeText(query))]
    const exclude = options.exclude ?? new Set<string>()

    const candidates = facts.filter(
      (fact) => !fact.archived && !fact.suppressed && !exclude.has(fact.id)
    )

    let best = 0
    const raw = new Map<string, { score: number; matched: string[] }>()
    for (const fact of candidates) {
      const entry = this.rawScore(fact, queryTokens)
      raw.set(fact.id, entry)
      if (entry.score > best) best = entry.score
    }

    const scored: MemoryHit[] = []
    for (const fact of candidates) {
      const entry = raw.get(fact.id) ?? { score: 0, matched: [] }
      const lexical = best > 0 ? entry.score / best : 0
      let score =
        WEIGHT_LEXICAL * lexical +
        WEIGHT_RECENCY * recencyScore(fact, now) +
        WEIGHT_IMPORTANCE * importanceScore(fact)
      if (fact.pinned) score += PINNED_BOOST
      if (fact.kind === 'boundary') score += BOUNDARY_BOOST

      const reasons: string[] = []
      if (entry.matched.length > 0) reasons.push(`matched: ${entry.matched.slice(0, 6).join(', ')}`)
      if (fact.pinned) reasons.push('pinned')
      if (fact.kind === 'boundary') reasons.push('boundary')
      reasons.push(`importance ${fact.importance}`)
      reasons.push(`used ${fact.useCount}×`)

      scored.push({ fact, score, reasons })
    }

    scored.sort((a, b) => b.score - a.score)

    const limit = Math.max(1, options.limit)
    const chosen: MemoryHit[] = []
    const seen = new Set<string>()

    // Boundary facts and the user's pins are never left to the ranking: these
    // are the ones the companion must not forget half a conversation later.
    if (options.forceBoundaries !== false) {
      for (const hit of scored) {
        if (hit.fact.kind !== 'boundary' || seen.has(hit.fact.id)) continue
        seen.add(hit.fact.id)
        chosen.push(hit)
      }
    }

    const pinnedSlots = options.pinnedSlots ?? 2
    let pinnedTaken = 0
    for (const hit of scored) {
      if (pinnedTaken >= pinnedSlots) break
      if (!hit.fact.pinned || seen.has(hit.fact.id)) continue
      seen.add(hit.fact.id)
      pinnedTaken += 1
      chosen.push(hit)
    }

    for (const hit of scored) {
      if (chosen.length >= limit) break
      if (seen.has(hit.fact.id)) continue
      // A fact that matched nothing still gets in on recency, but only while
      // there is room and only above a floor, so the block stays relevant.
      if (hit.score < 0.18 && seen.size > 0) continue
      seen.add(hit.fact.id)
      chosen.push(hit)
    }

    return chosen.slice(0, limit)
  }
}

/**
 * Jaccard similarity over token sets, used to merge a re-learned fact into the
 * one already stored instead of keeping two near-identical rows.
 */
export function textSimilarity(a: string, b: string): number {
  const left = new Set(tokenizeText(a))
  const right = new Set(tokenizeText(b))
  if (left.size === 0 || right.size === 0) return 0

  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1

  return shared / (left.size + right.size - shared)
}
