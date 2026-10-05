import { Notification, powerMonitor } from 'electron'
import type {
  ChatRequestMessage,
  CompanionSettings,
  GreetingIntent,
  HeartbeatBookkeeping,
  HeartbeatEvent
} from '@shared/types'
import { DEFAULT_SAMPLING } from '@shared/types'
import { logger, toError } from '../util/logger'
import { settingsStore } from '../store/settings'
import { serverManager } from '../llama/server-manager'
import { memoryManager } from '../memory/manager'
import { renderPersona, resolveCard } from './persona'
import { companionService } from './service'

/** The next check lands somewhere in this window, so it never looks clockwork. */
const MIN_INTERVAL_MS = 5 * 60 * 1000
const MAX_INTERVAL_MS = 20 * 60 * 1000
/** Greetings that get no answer halve the odds of the next one, down to this. */
const MIN_PROBABILITY_FACTOR = 1 / 16
/** A greeting shorter than this is treated as a failure rather than delivered. */
const MIN_GREETING_CHARS = 2

export interface GreetingContext {
  cardName: string
  relationshipStage: string
  mood: string | null
  hours: number
  daysKnown: number
  seed: string | null
  lastUserMessage: string | null
}

/**
 * The environment the heartbeat runs in.
 *
 * Everything is injected so the gate logic can be tested with a fake clock, a
 * fake idle timer and a seeded random number generator instead of waiting for
 * real time to pass.
 */
export interface HeartbeatDeps {
  now(): number
  idleSeconds(): number
  random(): number
  isWindowFocused(): boolean
  isFullScreen(): boolean
  serverReady(): boolean
  settings(): CompanionSettings
  /** the conversation a greeting should land in, or null when there is none */
  targetConversationId(): string | null
  /** recent messages, used to ground the greeting */
  recentMessages(): ChatRequestMessage[]
  buildPrompt(): { system: string; personaTokens: number }
  /** produces the greeting text; the default calls the loaded model */
  generate(intent: GreetingIntent, context: GreetingContext, prompt: { system: string; personaTokens: number }): Promise<string>
  deliver(conversationId: string, text: string, cardName: string, background: boolean): void
  /** Shows an OS notification; the click handler is wired by `setHeartbeatHooks`. */
  notify(title: string, body: string): void
  dream(): Promise<void>
}

const INTENTS: readonly GreetingIntent[] = ['care', 'share', 'recall', 'tease', 'question', 'miss']

/** Weighted by how well they fit the moment. */
function chooseIntent(context: GreetingContext, roll: number): GreetingIntent {
  if (context.seed) return 'seed'
  const quiet = context.hours >= 23 || context.hours < 6
  const pool = quiet ? ['care', 'miss', 'recall', 'share'] : [...INTENTS]
  return pool[Math.floor(roll * pool.length)] as GreetingIntent
}

function intentInstruction(intent: GreetingIntent, context: GreetingContext): string {
  const base =
    '（现在没有人对你说话。用你自己的语气，主动对用户说一句自然的话，就像忽然想起他一样。' +
    '只输出你要说的那句话，不要加引号、旁白、括号动作或任何解释，也不要提到这条提示。）'

  switch (intent) {
    case 'care':
      return `（现在没有人对你说话。${context.lastUserMessage ? `他上一次说的是：「${context.lastUserMessage.slice(0, 60)}」。` : ''}用你自己的语气，主动关心他一下。只输出那一句话。不要提到这条提示。）`
    case 'share':
      return '（现在没有人对你说话。用你自己的语气，主动跟他分享一件此刻你想到的小事（天气、吃的、窗外的东西都行）。只输出那一句话。不要提到这条提示。）'
    case 'recall':
      return '（现在没有人对你说话。用你自己的语气，主动提起一件你记得的、关于他的事，像是在想他。只输出那一句话。不要提到这条提示。）'
    case 'tease':
      return '（现在没有人对你说话。用你自己的语气，轻轻撒娇或逗他一下。只输出那一句话。不要提到这条提示。）'
    case 'question':
      return '（现在没有人对你说话。用你自己的语气，问他一个你真的好奇的小问题。只输出那一句话。不要提到这条提示。）'
    case 'miss':
      return `（现在没有人对你说话。${context.mood ? `你现在的心情是「${context.mood}」。` : ''}用你自己的语气，说一句想他的话。只输出那一句话。不要提到这条提示。）`
    case 'seed':
      return `（现在没有人对你说话。你脑子里正想着这件事：「${context.seed ?? ''}」。用你自己的语气，把它自然地说出来。只输出那一句话。不要提到这条提示。）`
    default:
      return base
  }
}

/**
 * Decides when the companion is allowed to speak up on its own.
 *
 * The order of the gates is deliberate: the free checks run first so a check
 * that cannot possibly fire never touches the system idle timer or the model.
 */
export class HeartbeatService {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private deps: HeartbeatDeps

  constructor(deps?: Partial<HeartbeatDeps>) {
    this.deps = { ...defaultDeps(), ...deps }
  }

  /* ---------------------------------------------------------------- */
  /* Scheduling                                                        */
  /* ---------------------------------------------------------------- */

  start(): void {
    this.stop()
    this.scheduleNext()
    logger.info('heartbeat', 'started')
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Pauses the timer while the machine is asleep. */
  suspend(): void {
    this.stop()
  }

  /** Resuming resets the idle clock, so a returning user is not greeted instantly. */
  resume(): void {
    this.start()
  }

  private scheduleNext(): void {
    const span = MAX_INTERVAL_MS - MIN_INTERVAL_MS
    const delay = MIN_INTERVAL_MS + Math.floor(this.deps.random() * span)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, delay)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    try {
      await this.check()
      await this.maybeDream()
    } catch (error) {
      logger.warn('heartbeat', `check failed: ${toError(error).message}`)
    } finally {
      if (this.deps.settings().heartbeatEnabled) this.scheduleNext()
    }
  }

  /* ---------------------------------------------------------------- */
  /* Gates                                                             */
  /* ---------------------------------------------------------------- */

  /** Every condition that must hold before the companion may speak up. */
  blockedReason(now = this.deps.now()): string | null {
    const settings = this.deps.settings()
    if (!settings.enabled) return 'companion disabled'
    if (!settings.heartbeatEnabled) return 'heartbeat disabled'

    const bookkeeping = memoryManager.heartbeat()
    if (bookkeeping.snoozeUntil > now) return 'snoozed'
    if (inQuietHours(now, settings.quietHours)) return 'quiet hours'
    if (
      bookkeeping.lastGreetingAt > 0 &&
      now - bookkeeping.lastGreetingAt < settings.heartbeatMinGapMinutes * 60_000
    ) {
      return 'too soon'
    }
    if (memoryManager.rollHeartbeatDay(now).todayCount >= settings.heartbeatMaxPerDay) {
      return 'daily cap reached'
    }
    if (this.deps.isFullScreen()) return 'fullscreen'
    if (this.deps.idleSeconds() < settings.heartbeatIdleMinutes * 60) return 'user is active'
    if (!this.deps.serverReady() && !settings.allowColdStart) return 'model not loaded'
    if (this.deps.targetConversationId() === null) return 'no companion conversation'
    return null
  }

  /**
   * Backs off as greetings go unanswered, so a companion that keeps being
   * ignored gradually stops trying instead of nagging.
   */
  probability(): number {
    const settings = this.deps.settings()
    const streak = Math.min(memoryManager.heartbeat().unansweredStreak, 4)
    const factor = Math.max(MIN_PROBABILITY_FACTOR, Math.pow(0.5, streak))
    return settings.heartbeatProbability * factor
  }

  /** One scheduled pass: evaluate the gates, roll the dice, maybe say something. */
  async check(): Promise<boolean> {
    const now = this.deps.now()
    memoryManager.rollHeartbeatDay(now)
    memoryManager.updateHeartbeat({ lastCheckAt: now })

    const blocked = this.blockedReason(now)
    if (blocked) {
      logger.debug('heartbeat', `stayed quiet: ${blocked}`)
      return false
    }

    if (this.deps.random() > this.probability()) {
      logger.debug('heartbeat', 'stayed quiet: dice roll')
      return false
    }

    return this.speakUp(false)
  }

  /* ---------------------------------------------------------------- */
  /* Speaking up                                                       */
  /* ---------------------------------------------------------------- */

  async speakUp(force: boolean): Promise<boolean> {
    if (this.running) return false
    const settings = this.deps.settings()
    const conversationId = this.deps.targetConversationId()
    if (!conversationId) return false

    this.running = true
    try {
      const now = this.deps.now()
      const prompt = this.deps.buildPrompt()
      const relationship = memoryManager.relationship()
      const card = resolveCard(settings.characterCardId)
      const context: GreetingContext = {
        cardName: card.name,
        relationshipStage: relationship.stage,
        mood: relationship.mood,
        hours: new Date(now).getHours(),
        daysKnown:
          relationship.knownSince > 0
            ? Math.max(1, Math.floor((now - relationship.knownSince) / 86_400_000))
            : 0,
        seed: memoryManager.takeSeed(now)?.text ?? null,
        lastUserMessage: lastUserText(this.deps.recentMessages())
      }

      const intent =
        force && !context.seed ? 'care' : chooseIntent(context, this.deps.random())

      const raw = await this.deps.generate(intent, context, prompt)
      const text = raw.trim()
      if (text.length < MIN_GREETING_CHARS) {
        logger.info('heartbeat', 'skipped: the model produced nothing usable')
        return false
      }

      // A user who is already looking at the window does not need an OS
      // notification on top of the message that just appeared in it.
      const focused = this.deps.isWindowFocused()
      this.deps.deliver(conversationId, text, context.cardName, !focused)
      if (!focused) this.deps.notify(context.cardName, text)

      const bookkeeping = memoryManager.heartbeat()
      memoryManager.updateHeartbeat({
        lastGreetingAt: now,
        unansweredStreak: bookkeeping.unansweredStreak + 1,
        todayCount: bookkeeping.todayCount + 1
      })
      logger.info('heartbeat', `spoke up (intent ${intent}, ${text.length} chars)`)
      return true
    } catch (error) {
      logger.warn('heartbeat', `failed to speak up: ${toError(error).message}`)
      return false
    } finally {
      this.running = false
    }
  }

  /* ---------------------------------------------------------------- */
  /* User controls                                                     */
  /* ---------------------------------------------------------------- */

  /** `minutes <= 0` clears an existing snooze. */
  snooze(minutes: number): HeartbeatBookkeeping {
    if (minutes <= 0) {
      logger.info('heartbeat', 'snooze cleared')
      return memoryManager.updateHeartbeat({ snoozeUntil: 0 })
    }
    const until = this.deps.now() + minutes * 60_000
    logger.info('heartbeat', `snoozed for ${minutes} minutes`)
    return memoryManager.updateHeartbeat({ snoozeUntil: until })
  }

  /** Also the hook the dream job uses when it wakes something up. */
  acknowledge(): HeartbeatBookkeeping {
    return memoryManager.updateHeartbeat({ unansweredStreak: 0 })
  }

  /**
   * Runs the idle consolidation job when the machine has been quiet long enough
   * and the model is already loaded — never to start the model, which would
   * fight whatever the user is playing for VRAM.
   */
  async maybeDream(): Promise<boolean> {
    const settings = this.deps.settings()
    if (!settings.dreamingEnabled || !settings.enabled) return false
    if (!this.deps.serverReady()) return false
    if (this.deps.idleSeconds() < settings.dreamIdleMinutes * 60) return false

    const now = this.deps.now()
    if (now - memoryManager.heartbeat().lastDreamAt < 30 * 60_000) return false

    // The throttle is owned here rather than by the job, so a job that fails
    // halfway still cannot be re-run in a tight loop.
    memoryManager.updateHeartbeat({ lastDreamAt: now })
    await this.deps.dream()
    return true
  }
}

/** Local hour ranges that wrap past midnight are handled here. */
export function inQuietHours(now: number, [from, to]: [number, number]): boolean {
  const hour = new Date(now).getHours()
  if (from === to) return false
  if (from < to) return hour >= from && hour < to
  return hour >= from || hour < to
}

/** The tail of the newest companion conversation, used to ground a greeting. */
function heartbeatHooksRecentMessages(): ChatRequestMessage[] {
  const conversation = companionService.latestCompanionConversation()
  if (!conversation) return []
  return conversation.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-6)
    .map((message) => ({ role: message.role, content: message.content }))
}

function lastUserText(messages: ChatRequestMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'user' && message.content.trim().length > 0) return message.content
  }
  return null
}

/**
 * The real environment. The window-facing pieces are filled in by `index.ts`
 * once the window exists, which keeps this module free of import cycles.
 */
export interface HeartbeatHooks {
  isWindowFocused(): boolean
  isFullScreen(): boolean
  /** Brings the window forward and opens the conversation that just spoke. */
  notificationClicked(): void
  /** Emitted once a greeting has been written into the conversation. */
  onGreeting(event: HeartbeatEvent): void
}

let hooks: HeartbeatHooks = {
  isWindowFocused: () => false,
  isFullScreen: () => false,
  notificationClicked: () => undefined,
  onGreeting: () => undefined
}

export function setHeartbeatHooks(next: Partial<HeartbeatHooks>): void {
  hooks = { ...hooks, ...next }
}

function defaultDeps(): HeartbeatDeps {
  const recentMessages = (): ChatRequestMessage[] => heartbeatHooksRecentMessages()
  return {
    now: () => Date.now(),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    random: () => Math.random(),
    isWindowFocused: () => hooks.isWindowFocused(),
    isFullScreen: () => hooks.isFullScreen(),
    serverReady: () => serverManager.isReady(),
    settings: () => settingsStore.get().companion,
    targetConversationId: () => companionService.latestCompanionConversation()?.id ?? null,
    recentMessages,
    buildPrompt: () => {
      const settings = settingsStore.get().companion
      const card = resolveCard(settings.characterCardId)
      const persona = renderPersona(card, settings.personaTemplate, settings.personaTokenLimit)
      return { system: persona.text, personaTokens: persona.tokens }
    },
    generate: async (intent, context, prompt) => {
      const settings = settingsStore.get().companion
      const client = serverManager.getClient()
      if (!client) throw new Error('SERVER_NOT_READY')

      const messages: ChatRequestMessage[] = [
        ...recentMessages(),
        { role: 'user', content: intentInstruction(intent, context) }
      ]
      // Same trick as the reply path: continuing from a one-space assistant
      // turn skips the thinking block, which turns a 13 s wait into under a
      // second for a greeting.
      if (settings.skipThinking) messages.push({ role: 'assistant', content: ' ' })

      const result = await client.complete(
        {
          streamId: 'companion-heartbeat',
          conversationId: 'companion',
          modelId: null,
          systemPrompt: prompt.system,
          messages,
          sampling: {
            ...DEFAULT_SAMPLING,
            temperature: settings.sampling?.temperature ?? 0.9,
            minP: settings.sampling?.minP ?? 0.05,
            repeatPenalty: 1.05,
            presencePenalty: 0.2,
            repeatLastN: 256,
            maxTokens: 160,
            seed: -1
          }
        },
        { extraBody: { cache_prompt: true, n_keep: prompt.personaTokens } }
      )
      return result.content
    },
    deliver: (conversationId, text, cardName, background) => {
      const event = companionService.appendProactive(conversationId, text, cardName, background)
      if (event) hooks.onGreeting(event)
    },
    notify: (title, body) => {
      if (!Notification.isSupported()) return
      try {
        const notification = new Notification({ title, body, silent: false })
        notification.on('click', () => hooks.notificationClicked())
        notification.show()
      } catch (error) {
        logger.warn('heartbeat', `notification failed: ${toError(error).message}`)
      }
    },
    dream: () => companionService.dream()
  }
}

export const heartbeatService = new HeartbeatService()
