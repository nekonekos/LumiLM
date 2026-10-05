import type {
  ChatRequest,
  ChatRequestMessage,
  CompanionOverview,
  CompanionStatus,
  Conversation,
  HeartbeatEvent,
  MemoryHit,
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
import { memoryManager } from '../memory/manager'
import {
  ExtractionQueue,
  buildRollingSummary,
  extractFacts,
  extractRelationship,
  type ExtractOptions,
  type ExtractionJob
} from '../memory/extract'
import { listCards, resolveCard } from './persona'

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
    this.extractionQueue().schedule({ conversationId, options })
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
    const result = await extractFacts(client, options)

    if (result.drafts.length > 0) {
      memoryManager.remember(result.drafts, { conversationId, messageIds: [] }, settings)
      logger.info(
        'memory',
        `learned ${result.drafts.length} fact(s) in ${Math.round(
          result.timings.durationMs ?? 0
        )}ms (prompt ${result.timings.promptTokens ?? '?'} tok)`
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
