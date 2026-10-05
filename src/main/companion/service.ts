import type {
  ChatRequest,
  ChatRequestMessage,
  CompanionOverview,
  CompanionStatus,
  Conversation,
  HeartbeatEvent,
  MemoryFact,
  MemoryHit,
  MemorySweepProposal,
  MemorySweepReport,
  PersonaCard,
  PromptBlockInfo,
  PromptPreviewInput,
  RelationshipState,
  SamplingParams
} from '@shared/types'
import { OOC_PATTERNS } from '@shared/types'
import { logger, toError } from '../util/logger'
import { settingsStore } from '../store/settings'
import { conversationStore } from '../store/conversations'
import { serverManager } from '../llama/server-manager'
import {
  applyMemoryInjection,
  composeCompanionPrompt,
  type ComposedCompanionPrompt
} from '../agent/prompt'
import { memoryManager, type MemoryDraft, type MemoryVerdict } from '../memory/manager'
import {
  MAX_CANDIDATES,
  MAX_PROTECTED_CANDIDATES,
  consolidateFacts,
  type ConsolidationCandidate,
  type ConsolidationClient
} from '../memory/consolidate'
import {
  ExtractionQueue,
  buildRollingSummary,
  extractFacts,
  extractRelationship,
  noiseReason,
  type ExtractOptions,
  type ExtractionJob
} from '../memory/extract'
import { textSimilarity } from '../memory/lexical-index'
import { listCards, resolveCard } from './persona'

/**
 * Rows offered to the consolidation pass per draft, and in total.
 *
 * Both are load-bearing: `MAX_PER_DRAFT_CANDIDATES` bounds how far down one draft's
 * ranking the pass will look, and the total bounds the prompt, which is otherwise
 * the only thing here that could grow with the size of the store.
 */
const MAX_PER_DRAFT_CANDIDATES = MAX_CANDIDATES + MAX_PROTECTED_CANDIDATES
const MAX_TOTAL_CANDIDATES = 24

/** Facts the tidy-up compares in one consolidation call, and per call batch. */
const SWEEP_BATCH = 6
/** Similarity above which the offline check calls two stored rows the same fact. */
const SWEEP_SIMILARITY = 0.85

/**
 * Which of two duplicate rows survives.
 *
 * Deterministic, and deliberately boring: whatever the user has actually been shown
 * wins, because that is the row the companion's replies have been built on. Then
 * importance, then age, so the outcome never depends on array order.
 */
function pickSurvivor(a: MemoryFact, b: MemoryFact): [MemoryFact, MemoryFact] {
  const weight = (fact: MemoryFact): number =>
    fact.useCount * 1000 + fact.importance * 10 + Math.min(fact.reinforcements, 9)
  const left = weight(a)
  const right = weight(b)
  if (left !== right) return left > right ? [a, b] : [b, a]
  return a.createdAt <= b.createdAt ? [a, b] : [b, a]
}

/**
 * Everything the companion needs that is not a transport concern.
 *
 * The IPC layer and the heartbeat both drive turns through here, so a message
 * the user sent and a message the companion started on its own go through
 * exactly the same persona, recall and extraction path.
 */

/** How many trailing messages form the recall query. */
const QUERY_MESSAGES = 2
/** Summarise once the conversation gets this long and it is not up to date. */
const SUMMARY_AFTER_MESSAGES = 24

export interface CompanionTurnPlan {
  request: ChatRequest
  composed: ComposedCompanionPrompt
  card: PersonaCard
  hits: MemoryHit[]
  /** the messages the model actually receives, injection included */
  wireMessages: ChatRequestMessage[]
  /**
   * The same messages before the memory injection was appended.
   *
   * Kept because the extraction pass must read this and never `wireMessages`:
   * an extractor that is shown the injected block indexes its own recollection
   * as brand-new facts ("亲密度为 60/100").
   */
  cleanMessages: ChatRequestMessage[]
}

function plainMessages(conversation: Conversation): ChatRequestMessage[] {
  return conversation.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ role: message.role, content: message.content }))
}

/** The text used to look up relevant memories: the newest user messages. */
function recallQuery(messages: ChatRequestMessage[]): string {
  const users = messages.filter((message) => message.role === 'user').slice(-QUERY_MESSAGES)
  return users.map((message) => message.content).join('\n')
}

/**
 * Drops the empty assistant bubble the renderer keeps as its streaming target.
 *
 * It is a UI placeholder, not history: once the companion prefill adds the
 * one-space assistant turn that skips the thinking block, a placeholder left in
 * the list makes llama.cpp reject the whole request with
 *
 *   "Cannot have 2 or more assistant messages at the end of the list"
 *
 * which surfaced as an unexplained error that reloading the model could not
 * clear.
 */
export function withoutTrailingPlaceholder(
  messages: ChatRequestMessage[]
): ChatRequestMessage[] {
  let end = messages.length
  while (end > 0) {
    const last = messages[end - 1]
    const empty = last.content.trim().length === 0
    if (last.role !== 'assistant' || !empty || (last.toolCalls?.length ?? 0) > 0) break
    end -= 1
  }
  return end === messages.length ? messages : messages.slice(0, end)
}

class CompanionService {
  private queue: ExtractionQueue | null = null
  private lastInjection = ''
  private lastBlocks: PromptBlockInfo[] = []
  /**
   * The suggestions the last tidy-up produced.
   *
   * Kept here so `applySweep` can resolve what to do from the report the user was
   * actually looking at, instead of trusting anything sent back across the bridge.
   */
  private lastSweep: MemorySweepReport | null = null

  /** The extraction queue, created on first use. */
  private extractionQueue(): ExtractionQueue {
    if (!this.queue) {
      this.queue = new ExtractionQueue(
        (job) => this.runExtraction(job),
        () => settingsStore.get().companion.extractDelayMs
      )
    }
    return this.queue
  }

  /* ---------------------------------------------------------------- */
  /* Status                                                            */
  /* ---------------------------------------------------------------- */

  status(): CompanionStatus {
    const settings = settingsStore.get().companion
    const snapshot = memoryManager.stats()
    const card = resolveCard(settings.characterCardId)
    return {
      enabled: settings.enabled,
      relationship: memoryManager.relationship(),
      card,
      heartbeat: memoryManager.heartbeat(),
      nextCheckAt: null,
      snoozed: memoryManager.heartbeat().snoozeUntil > Date.now(),
      factCount: snapshot.facts,
      pendingCount: snapshot.pending,
      episodeCount: snapshot.episodes,
      memoryBytes: snapshot.bytes
    }
  }

  overview(): CompanionOverview {
    return {
      status: this.status(),
      stats: memoryManager.stats(),
      cards: listCards()
    }
  }

  updateRelationship(patch: Partial<RelationshipState>): RelationshipState {
    return memoryManager.updateRelationship(patch)
  }

  /**
   * The memory tidy-up: reads what is already stored and *proposes* changes.
   *
   * Nothing is written here. The store that motivated this held six rows of which
   * five were noise, and a filter that only guards new writes would leave every
   * existing install full of them — but rewriting someone's memories behind their
   * back is worse than the noise. So this returns a report and the user decides.
   *
   * Three checks run, cheapest first: the noise filters that were tightened, then
   * verbatim duplicates (which need no model at all), then the consolidation pass on
   * what is left. The offline half is what makes the button useful even when the
   * model is not loaded.
   */
  async sweep(): Promise<MemorySweepReport> {
    const facts = memoryManager.listFacts({})
    const proposals: MemorySweepProposal[] = []
    const claimed = new Set<string>()

    for (const fact of facts) {
      const reason = noiseReason(fact.text)
      if (!reason) continue
      claimed.add(fact.id)
      proposals.push({
        op: 'drop',
        id: fact.id,
        targetId: null,
        reason,
        text: fact.text,
        targetText: null
      })
    }

    for (const fact of facts) {
      if (claimed.has(fact.id)) continue
      const near = facts.find(
        (other) =>
          other.id !== fact.id &&
          !claimed.has(other.id) &&
          textSimilarity(other.text, fact.text) >= SWEEP_SIMILARITY
      )
      if (!near) continue
      const [keep, lose] = pickSurvivor(fact, near)
      claimed.add(keep.id)
      claimed.add(lose.id)
      proposals.push({
        op: 'merge',
        id: lose.id,
        targetId: keep.id,
        reason: 'duplicate',
        text: lose.text,
        targetText: keep.text
      })
    }

    const client = serverManager.getClient()
    const remaining = facts.filter((fact) => !claimed.has(fact.id))
    const usedModel = Boolean(client && serverManager.isReady() && remaining.length > 1)
    if (client && serverManager.isReady()) {
      for (let start = 0; start < remaining.length; start += SWEEP_BATCH) {
        const batch = remaining.slice(start, start + SWEEP_BATCH)
        const verdicts = await this.verdictsFor(
          client,
          batch.map((fact) => ({
            text: fact.text,
            kind: fact.kind,
            subject: fact.subject,
            importance: fact.importance,
            confidence: fact.confidence
          })),
          Date.now(),
          batch.map((fact) => fact.id)
        )

        batch.forEach((fact, index) => {
          const verdict = verdicts[index]
          if (verdict.op !== 'same' || !verdict.targetId) return
          const target = facts.find((entry) => entry.id === verdict.targetId)
          if (!target || claimed.has(fact.id) || claimed.has(target.id)) return
          const [keep, lose] = pickSurvivor(fact, target)
          claimed.add(keep.id)
          claimed.add(lose.id)
          proposals.push({
            op: 'merge',
            id: lose.id,
            targetId: keep.id,
            reason: 'modelDuplicate',
            text: lose.text,
            targetText: keep.text
          })
        })
      }
    }

    logger.info(
      'memory',
      `tidy-up scanned ${facts.length} row(s) and suggested ${proposals.length} change(s)`
    )
    this.lastSweep = { scanned: facts.length, proposals, usedModel }
    return this.lastSweep
  }

  /**
   * Applies the suggestions the user accepted.
   *
   * Resolved against `lastSweep` rather than against anything the renderer sends
   * back: the renderer only ever chooses *which* suggestions to accept, never what
   * they do.
   */
  applySweep(ids: string[]): MemoryFact[] {
    const accepted = new Set(ids)
    const report = this.lastSweep
    let facts: MemoryFact[] = memoryManager.listFacts({ includeArchived: true })
    if (!report) return facts

    for (const proposal of report.proposals) {
      if (!accepted.has(proposal.id)) continue
      facts =
        proposal.op === 'merge' && proposal.targetId
          ? memoryManager.mergeFacts(proposal.id, proposal.targetId, proposal.reason)
          : memoryManager.archiveFact(proposal.id, proposal.reason)
    }

    this.lastSweep = null
    return facts
  }

  /**
   * Applies the companion's own sampling on top of the conversation's.
   *
   * A higher temperature and a small `presence_penalty` measurably cut down the
   * "as an AI I cannot" boilerplate and the repetition loops that an 8B model
   * falls into when it is trying to stay in character.
   */
  applySampling(base: SamplingParams): SamplingParams {
    const override = settingsStore.get().companion.sampling
    if (!override) return base
    return {
      ...base,
      temperature: override.temperature,
      minP: override.minP,
      repeatPenalty: override.repeatPenalty,
      presencePenalty: override.presencePenalty,
      repeatLastN: override.repeatLastN
    }
  }

  /** Blocks the preview panel shows for the last composed turn. */
  lastPromptBlocks(): PromptBlockInfo[] {
    return this.lastBlocks
  }

  injectionText(): string {
    return this.lastInjection
  }

  /* ---------------------------------------------------------------- */
  /* Turn composition                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Builds the request for one companion turn.
   *
   * The persona goes into the system message and the volatile memory block into
   * `wireMessages` only — the conversation on disk keeps the user's own text, so
   * the transcript never shows the scaffolding and the injection never gets
   * re-summarised into the next turn's context.
   */
  plan(conversation: Conversation, request: ChatRequest): CompanionTurnPlan {
    const settings = settingsStore.get().companion
    const card = resolveCard(settings.characterCardId, conversation.companion?.cardId)
    const session = memoryManager.session(conversation.id)
    const relationship = memoryManager.relationship()

    // The renderer already trimmed the history to the context window and sent
    // exactly what it wants answered, so that is the authoritative list. The
    // conversation file is the fallback for callers that do not send one — and
    // using the same prefix here is also what makes the extraction pass reuse
    // this turn's KV cache.
    const history =
      request.messages.length > 0
        ? withoutTrailingPlaceholder(
            request.messages.map((message) => ({ role: message.role, content: message.content }))
          )
        : plainMessages(conversation)
    const query = recallQuery(history)
    const hits = settings.memoryEnabled
      ? memoryManager.recall(query, { limit: settings.recallCount })
      : []

    const composed = composeCompanionPrompt({
      card,
      companion: conversation.companion,
      relationship,
      summary: session.summary,
      hits,
      episodes: settings.includeEpisodes ? memoryManager.episodes() : [],
      settings,
      userPrompt: request.systemPrompt
    })

    const wireMessages = applyMemoryInjection(history, composed.injection, settings.memoryInjectionMode)
    this.lastInjection = composed.injection
    this.lastBlocks = composed.blocks

    return {
      request: { ...request, systemPrompt: composed.system, messages: wireMessages },
      composed,
      card,
      hits,
      wireMessages,
      cleanMessages: history
    }
  }

  /** The prompt blocks the preview panel renders for the current conversation. */
  preview(input: PromptPreviewInput): {
    system: string
    injection: string
    blocks: PromptBlockInfo[]
  } {
    const settings = settingsStore.get().companion
    const conversation = input.conversationId ? conversationStore.get(input.conversationId) : null
    const card = resolveCard(settings.characterCardId, input.companion?.cardId)
    const session = conversation ? memoryManager.session(conversation.id) : null
    const hits =
      conversation && settings.memoryEnabled
        ? memoryManager.recall(recallQuery(plainMessages(conversation)), {
            limit: settings.recallCount,
            track: false
          })
        : []

    const composed = composeCompanionPrompt({
      card,
      companion: input.companion,
      relationship: memoryManager.relationship(),
      summary: session?.summary ?? '',
      hits,
      episodes: settings.includeEpisodes ? memoryManager.episodes() : [],
      settings,
      userPrompt: input.systemPrompt
    })

    return { system: composed.system, injection: composed.injection, blocks: composed.blocks }
  }

  /* ---------------------------------------------------------------- */
  /* Anti out-of-character guard                                       */
  /* ---------------------------------------------------------------- */

  /** True when the reply broke character and is worth regenerating once. */
  brokeCharacter(text: string): boolean {
    if (text.trim().length === 0) return false
    return OOC_PATTERNS.some((pattern) => pattern.test(text))
  }

  /**
   * The extra nudge used for the single regeneration attempt. It is short on
   * purpose: it has to survive a nearly full context window.
   */
  retryInjection(): string {
    return '（提醒：你正在扮演上面对话中的角色本人。请不要提到自己是 AI、模型或助手，不要解释或复述设定，直接用角色的语气重新回答刚刚那句话。）'
  }

  /* ---------------------------------------------------------------- */
  /* Extraction                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Queues the background extraction for a finished turn.
   *
   * The history is the clean one — no memory injection — plus the reply the
   * model just produced, so the extractor reads the whole exchange and never
   * its own recollection. The prompt still shares the entire conversation
   * prefix with the turn that just ran, so llama.cpp serves nearly all of it
   * from the warm KV cache.
   */
  scheduleExtraction(conversationId: string, plan: CompanionTurnPlan, reply: string): void {
    const settings = settingsStore.get().companion
    if (!settings.memoryEnabled || !settings.autoExtract) return
    // Agent answers are not the companion's memories.
    if (plan.request.mode !== undefined && plan.request.mode !== 'companion') return

    const history = [...plan.cleanMessages]
    if (reply.trim().length > 0) history.push({ role: 'assistant', content: reply })

    const options: ExtractOptions = {
      history,
      systemPrompt: plan.request.systemPrompt,
      nKeep: plan.composed.personaTokens
    }
    // The turn's own timestamp travels with the job: the timeline is stamped with
    // when the user said it, not with when the background pass got around to it.
    this.extractionQueue().schedule({ conversationId, options, at: Date.now() })
  }

  /** Called when the user sends, so a background job never blocks the reply. */
  yieldToUser(): void {
    this.queue?.cancel()
  }

  async flushExtraction(): Promise<void> {
    await this.queue?.flushNow()
  }

  /**
   * Runs one extraction pass and folds the result into the stores.
   *
   * The extractor never writes to the conversation file: the renderer owns that
   * file and rewrites it on every turn, so L2 lives in the memory store instead.
   */
  async runExtraction(job: ExtractionJob): Promise<void> {
    const client = serverManager.getClient()
    if (!client || !serverManager.isReady()) {
      logger.info('memory', 'skipping extraction: the model is not loaded')
      return
    }
    const conversationId = job.conversationId
    const options = job.options
    const settings = settingsStore.get().companion
    const at = job.at ?? Date.now()
    const result = await extractFacts(client, options)

    if (result.drafts.length > 0) {
      const context = { conversationId, messageIds: [] }
      const verdicts = await this.verdictsFor(client, result.drafts, at)
      const stored = memoryManager.applyVerdicts(verdicts, context, settings)
      logger.info(
        'memory',
        `learned ${result.drafts.length} fact(s) in ${Math.round(
          result.timings.durationMs ?? 0
        )}ms (prompt ${result.timings.promptTokens ?? '?'} tok) -> ${stored.length} row(s)`
      )
    } else {
      // An extraction that finds nothing is normal, but an extraction that
      // keeps finding nothing is worth seeing without a debugger.
      logger.info(
        'memory',
        `extraction found nothing (${result.empty ? 'empty answer' : 'unparsed'}, ${result.raw.length} chars back): ${result.raw.slice(0, 200).replace(/\s+/g, ' ')}`
      )
    }

    const session = memoryManager.session(conversationId)
    const newFacts = memoryManager
      .recentlyLearned()
      .filter((fact) => !session.facts.some((entry) => entry.id === fact.id))
    memoryManager.updateSession(conversationId, {
      extractedUpTo: options.history.length,
      facts: [...session.facts, ...newFacts].slice(-60)
    })

    memoryManager.touchInteraction()
  }

  /**
   * Turns drafts into decisions, with the silent consolidation pass.
   *
   * The candidate pool is assembled round-robin across the drafts rather than by
   * filling one draft's shortlist first, so a turn that produced six candidates
   * cannot crowd out a later draft's only match. The pool is capped: the prompt
   * this pass builds must stay a fixed size no matter how large the store or the
   * turn grows.
   *
   * Failure is never fatal. A model that is gone, or an answer that does not parse,
   * leaves every draft as a plain insert and the lexical backstop takes over —
   * exactly the behaviour the app had before this pass existed.
   */
  private async verdictsFor(
    client: ConsolidationClient,
    drafts: MemoryDraft[],
    at: number,
    /** rows the drafts already *are*, so a stored row is not offered itself */
    selfIds?: readonly string[]
  ): Promise<MemoryVerdict[]> {
    const asNew = (): MemoryVerdict[] =>
      drafts.map((draft) => ({ draft, op: 'new' as const, targetId: null, why: '', at }))

    const empty: ReadonlySet<string> = new Set()
    const perDraft = drafts.map((draft, index) => {
      const self = selfIds?.[index]
      const exclude = self ? new Set([self]) : empty
      return memoryManager
        .shortlistExcluding(draft.text, MAX_CANDIDATES, exclude)
        .slice(0, MAX_PER_DRAFT_CANDIDATES)
    })

    const candidates: ConsolidationCandidate[] = []
    const seen = new Set<string>()
    const deepest = Math.max(0, ...perDraft.map((list) => list.length))
    for (let level = 0; level < deepest && candidates.length < MAX_TOTAL_CANDIDATES; level += 1) {
      for (const list of perDraft) {
        const fact = list[level]
        if (!fact || seen.has(fact.id)) continue
        if (candidates.length >= MAX_TOTAL_CANDIDATES) break
        seen.add(fact.id)
        candidates.push({
          id: fact.id,
          text: fact.text,
          kind: fact.kind,
          lastAt: fact.occurrences[0]?.at ?? null
        })
      }
    }

    if (candidates.length === 0) return asNew()

    try {
      const result = await consolidateFacts(client, drafts, candidates)
      if (!result) return asNew()
      return drafts.map((draft, index) => ({ draft, ...result.decisions[index], at }))
    } catch (error) {
      logger.warn('memory', `consolidation failed, storing as new: ${toError(error).message}`)
      return asNew()
    }
  }

  /**
   * The idle consolidation pass: catch up on extraction, refresh the
   * relationship, write the day's diary entry and prepare a seed thought.
   */
  async dream(): Promise<void> {
    const settings = settingsStore.get().companion
    if (!settings.dreamingEnabled) return

    const client = serverManager.getClient()
    if (!client || !serverManager.isReady()) return

    const conversation = this.latestCompanionConversation()
    if (conversation) {
      await this.flushExtraction()

      const history = plainMessages(conversation)
      if (history.length >= 4) {
        const options: ExtractOptions = {
          history,
          systemPrompt: this.status().card.name,
          maxTokens: 256
        }

        const { patch } = await extractRelationship(client, options)
        if (Object.keys(patch).length > 0) memoryManager.updateRelationship(patch)

        const session = memoryManager.session(conversation.id)
        if (history.length >= SUMMARY_AFTER_MESSAGES && session.summaryUpTo < history.length) {
          const summary = await buildRollingSummary(client, options)
          if (summary) {
            memoryManager.updateSession(conversation.id, {
              summary,
              summaryUpTo: history.length
            })
          }
        }
      }

      const session = memoryManager.session(conversation.id)
      if (session.facts.length > 0) {
        const now = new Date()
        memoryManager.recordEpisode({
          date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
            now.getDate()
          ).padStart(2, '0')}`,
          conversationId: conversation.id,
          summary: summarizeSession(session.facts.map((fact) => fact.text)),
          highlights: session.facts.slice(0, 3).map((fact) => fact.text),
          emotion: memoryManager.relationship().mood
        })
      }
    }

    const decayed = memoryManager.decay()
    memoryManager.pruneSeeds()
    logger.info('memory', `dream pass done (aged ${decayed} fact(s))`)
  }

  /** The conversation the heartbeat and the dream job should act on. */
  latestCompanionConversation(): Conversation | null {
    const metas = conversationStore
      .list()
      .filter((meta) => meta.mode === 'companion' && !meta.archived)
    const meta = metas[0]
    return meta ? conversationStore.get(meta.id) : null
  }

  /* ---------------------------------------------------------------- */
  /* Proactive messages                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Appends a message the companion started on its own.
   *
   * It is written straight to the conversation file rather than streamed, so a
   * greeting that arrives while the window is closed is simply there when the
   * user comes back.
   */
  appendProactive(
    conversationId: string,
    text: string,
    cardName: string,
    background: boolean
  ): HeartbeatEvent | null {
    const conversation = conversationStore.get(conversationId)
    if (!conversation) return null

    const message = {
      id: `proactive_${Date.now().toString(36)}`,
      role: 'assistant' as const,
      content: text,
      createdAt: Date.now(),
      proactive: true,
      unread: true
    }

    conversationStore.save({
      ...conversation,
      messages: [...conversation.messages, message]
    })

    return {
      conversationId,
      messageId: message.id,
      text,
      cardName,
      background
    }
  }

  /** Marks every proactive message in a conversation as read. */
  markRead(conversationId: string): void {
    const conversation = conversationStore.get(conversationId)
    if (!conversation) return
    if (!conversation.messages.some((message) => message.unread)) return
    conversationStore.save({
      ...conversation,
      messages: conversation.messages.map((message) =>
        message.unread ? { ...message, unread: false } : message
      )
    })
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /** Loads the store and folds in the memory-store listeners. */
  start(onChanged: () => void): void {
    memoryManager.init()
    memoryManager.subscribe(onChanged)
    try {
      conversationStore.list()
    } catch (error) {
      logger.warn('companion', `failed to warm the conversation index: ${toError(error).message}`)
    }
  }

  shutdown(): void {
    this.queue?.dispose()
    memoryManager.flush()
  }
}

function summarizeSession(texts: string[]): string {
  const joined = texts.slice(0, 4).join('；')
  return joined.length > 240 ? `${joined.slice(0, 239)}…` : joined
}

export const companionService = new CompanionService()
