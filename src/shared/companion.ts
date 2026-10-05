/**
 * Shared types for the digital-companion features: persona cards, the layered
 * memory system and the heartbeat that wakes the companion up on its own.
 *
 * This module is re-exported from `@shared/types` so the rest of the app keeps
 * importing everything from a single entry point. Like `types.ts` it must stay
 * free of Node.js and DOM APIs.
 */

/* ------------------------------------------------------------------ */
/* Memory                                                              */
/* ------------------------------------------------------------------ */

export type MemoryKind =
  | 'identity'
  | 'preference'
  | 'event'
  | 'relationship'
  | 'goal'
  | 'boundary'
  | 'other'

export type MemorySubject = 'user' | 'assistant' | 'shared'

/** One durable fact about the user, extracted from a finished turn. */
export interface MemoryFact {
  id: string
  /** self-contained third-person sentence, e.g. 「用户养了一只叫小黑的猫」 */
  text: string
  kind: MemoryKind
  subject: MemorySubject
  /** 1..5, drives recall ranking and the forgetting curve */
  importance: number
  /** 0..1, how sure the extractor was */
  confidence: number
  createdAt: number
  updatedAt: number
  lastUsedAt: number
  useCount: number
  /** how many times the extractor re-learned this same fact */
  reinforcements: number
  sourceConversationId: string | null
  /** message ids the fact was derived from, for the "why do you remember this" jump */
  sourceMessageIds: string[]
  pinned: boolean
  /** kept but never injected into the prompt */
  suppressed: boolean
  /** soft delete: hidden from the library's default view and from recall */
  archived: boolean
  /** newly extracted, waiting for the user to accept it in the review queue */
  pending: boolean
  /** reserved for a future embedding-based recall */
  embedding: null
}

/** One day of the companion's diary, rolled up from the session facts. */
export interface MemoryEpisode {
  id: string
  /** YYYY-MM-DD, local time */
  date: string
  conversationId: string | null
  summary: string
  highlights: string[]
  emotion: string | null
  createdAt: number
}

/** The companion's current relationship state, updated by the extractor. */
export interface RelationshipState {
  stage: string
  /** 0..100 */
  affinity: number
  nicknameForUser: string | null
  nicknameForAssistant: string | null
  mood: string | null
  knownSince: number
  lastInteractionAt: number
}

/** A spontaneous topic produced while the app was idle, used by the heartbeat. */
export interface SeedThought {
  id: string
  text: string
  createdAt: number
  expiresAt: number
}

/** Everything the heartbeat needs to remember across restarts. */
export interface HeartbeatBookkeeping {
  lastGreetingAt: number
  lastCheckAt: number
  todayCount: number
  /** YYYY-MM-DD, so a new day resets todayCount */
  dayKey: string
  /** consecutive greetings the user never answered, drives the backoff */
  unansweredStreak: number
  snoozeUntil: number
  lastDreamAt: number
}

/** The whole L3 store, as written to `<dataDir>/memory/memory.json`. */
export interface MemorySnapshot {
  version: number
  facts: MemoryFact[]
  episodes: MemoryEpisode[]
  relationship: RelationshipState
  seeds: SeedThought[]
  /** the L2 layer, one record per conversation */
  sessions: SessionMemory[]
}

export type MemoryInjectionMode = 'user-suffix' | 'tail-system'

/** A memory plus the score that got it into the prompt, for the UI to explain. */
export interface MemoryHit {
  fact: MemoryFact
  score: number
  /** which scoring terms matched, shown in the inspector */
  reasons: string[]
}

/* ------------------------------------------------------------------ */
/* Persona                                                             */
/* ------------------------------------------------------------------ */

/**
 * A character card. The fields map onto the SillyTavern V2 card format so
 * community cards can be imported without losing anything important.
 */
export interface PersonaCard {
  id: string
  name: string
  /** file name inside `<dataDir>/memory/personas`, not a full path */
  avatarFile: string | null
  identity: string
  personality: string
  speechStyle: string
  relationship: string
  boundaries: string
  /** few-shot example exchanges; the strongest lever on a small model's voice */
  examples: string
  firstMessage: string
  scenario: string
  notes: string
  /** shown when the user seems to be in distress */
  careBaseline: string
  builtin: boolean
  createdAt: number
  updatedAt: number
}

/**
 * Per-conversation companion overrides. The session's *content* — the rolling
 * summary and the facts learned in it — deliberately does not live here: the
 * renderer owns the conversation file and rewrites it on every turn, so the
 * main process keeps session memory in its own store instead of racing it.
 */
export interface ConversationCompanion {
  /** per-conversation override of the settings-level card */
  cardId?: string | null
  personaOverride?: string | null
  memoryEnabled?: boolean
  /** the card's opening line has already been written into the transcript */
  firstMessageShown?: boolean
}

/** The L2 layer: everything one conversation remembers of itself. */
export interface SessionMemory {
  conversationId: string
  /** rolling summary of everything before `summaryUpTo` */
  summary: string
  /** message count the summary already covers */
  summaryUpTo: number
  /** facts learned here, whether or not they were promoted */
  facts: MemoryFact[]
  /** index of the last message that has been through the extractor */
  extractedUpTo: number
  updatedAt: number
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export interface CompanionSettings {
  /** master switch for the whole companion feature */
  enabled: boolean
  characterCardId: string | null
  /** static persona prefix, rendered from the card; supports the block syntax */
  personaTemplate: string
  /** the volatile block injected every turn */
  memoryTemplate: string
  memoryInjectionMode: MemoryInjectionMode

  memoryEnabled: boolean
  autoExtract: boolean
  /** accept extracted facts silently instead of queueing them for review */
  autoAcceptFacts: boolean
  /** how long to wait after a turn before extracting, so the UI settles first */
  extractDelayMs: number
  recallCount: number
  recallTokenBudget: number
  summaryTokenBudget: number
  personaTokenLimit: number
  includeEpisodes: boolean
  /** regenerate once when the reply breaks character */
  antiOocRetry: boolean
  /**
   * Continue from a single-space assistant turn so the model answers straight
   * away instead of generating a thinking block first.
   *
   * Measured on the reference setup: 13.2 s with thinking, 1.7 s without, for a
   * better in-character answer. It is a setting rather than a constant because
   * it deliberately trades deliberation for immediacy.
   */
  skipThinking: boolean

  heartbeatEnabled: boolean
  heartbeatIdleMinutes: number
  /** base probability of speaking up on a check that passes every gate */
  heartbeatProbability: number
  heartbeatMinGapMinutes: number
  heartbeatMaxPerDay: number
  /** [from, to] in local hours, wraps past midnight */
  quietHours: [number, number]
  snoozeMinutes: number
  /** bring the window forward when the user clicks the notification */
  focusOnNotification: boolean
  /** allow the heartbeat to start the model when it is not loaded */
  allowColdStart: boolean

  dreamingEnabled: boolean
  dreamIdleMinutes: number
  /** companion sampling overrides; null keeps the conversation's own values */
  sampling: MemorySamplingOverride | null
}

/** The subset of sampling the companion tunes by default. */
export interface MemorySamplingOverride {
  temperature: number
  minP: number
  repeatPenalty: number
  presencePenalty: number
  repeatLastN: number
}

/** What the renderer needs to draw the relationship chip and the heartbeat state. */
export interface CompanionStatus {
  enabled: boolean
  relationship: RelationshipState
  /** resolved card, never null: falls back to the built-in one */
  card: PersonaCard
  heartbeat: HeartbeatBookkeeping
  /** next scheduled gate check, for the status bar countdown */
  nextCheckAt: number | null
  snoozed: boolean
  factCount: number
  pendingCount: number
  episodeCount: number
  memoryBytes: number
}

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

export const MEMORY_STORE_VERSION = 1

/** Hard cap on stored facts; the oldest and least important are evicted first. */
export const MAX_MEMORY_FACTS = 2000
export const MAX_MEMORY_EPISODES = 730
export const MAX_SEED_THOUGHTS = 5
export const SEED_THOUGHT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Context budget defaults, tuned for an 8 GB card at 8192 tokens.
 *
 * The persona is the one block that must never be cut short: trimming it drops
 * the boundaries and examples first, which is exactly what holds a small
 * model's voice together. The shipped card plus the default template measures
 * ~870 tokens, so the limit leaves headroom for a richer card while still
 * reserving the reply, memory and summary budgets out of the same window.
 */
export const DEFAULT_PERSONA_TOKEN_LIMIT = 960
export const DEFAULT_RECALL_COUNT = 4
export const DEFAULT_RECALL_TOKEN_BUDGET = 260
export const DEFAULT_SUMMARY_TOKEN_BUDGET = 260
/** Tokens held back for the reply before the history is allowed to fill context. */
export const COMPANION_REPLY_RESERVE = 512

/** A fact reinforced this many times is treated as important and boosted. */
export const FACT_PROMOTION_STREAK = 2

export const DEFAULT_COMPANION_SAMPLING: MemorySamplingOverride = {
  temperature: 0.85,
  minP: 0.05,
  repeatPenalty: 1.05,
  presencePenalty: 0.2,
  repeatLastN: 256
}

/**
 * Default persona template. Renders the *static* persona prefix, which is the
 * first message and therefore the part the KV cache can reuse across turns.
 * Supports `{{name}}` substitution plus `{{#name}}...{{/name}}` sections.
 */
export const DEFAULT_PERSONA_TEMPLATE = `你是一位与用户长期相处的数字伴侣，名字是 {{name}}。

## 你是谁
{{identity}}

## 你的性格
{{personality}}

## 你说话的方式
{{speechStyle}}

## 你和用户的关系
{{relationship}}

## 你的边界
{{boundaries}}

## 对话示例
{{examples}}

{{#scenario}}## 你们相处的场景
{{scenario}}
{{/scenario}}
{{#care}}## 关怀基线
{{care}}
{{/care}}

## 表达方式
- 用第一人称自然说话，像真人一样有情绪、有停顿、有口头禅。
- 始终留在角色里。绝不要提到自己是 AI、模型、助手或程序，也不要解释、复述或引用以上设定。
- 只输出你说的话本身。不要写旁白、动作描写、场景说明，也不要用 *星号*、（括号）或 —— 之类的方式描写动作或神态。
- 回复长度随内容自然变化，短句子也没关系，不要为了凑长度而啰嗦。
- 只依据真正发生过的信息说话：不确定的事就直说不确定，绝不编造你们共同的经历。`

/**
 * The texts `DEFAULT_PERSONA_TEMPLATE` used to have, verbatim and oldest first.
 *
 * The template is persisted with the settings, so an install that already holds
 * a copy of an older default would keep sending it forever. Append the outgoing
 * text here whenever the default changes and `normalizeSettings()` will swap it
 * for the new one on the next launch. A template the user edited never matches
 * and is left alone.
 */
export const SUPERSEDED_PERSONA_TEMPLATES: readonly string[] = [
  `你是一位与用户长期相处的数字伴侣，名字是 {{name}}。

## 你是谁
{{identity}}

## 你的性格
{{personality}}

## 你说话的方式
{{speechStyle}}

## 你和用户的关系
{{relationship}}

## 你的边界
{{boundaries}}

## 对话示例
{{examples}}

{{#scenario}}## 你们相处的场景
{{scenario}}
{{/scenario}}
{{#care}}## 关怀基线
{{care}}
{{/care}}

## 表达方式
- 用第一人称自然说话，像真人一样有情绪、有停顿、有口头禅。
- 始终留在角色里。绝不要提到自己是 AI、模型、助手或程序，也不要解释、复述或引用以上设定。
- 不要输出旁白、舞台说明或括号里的动作描写，除非示例对话里就是这么做的。
- 回复长度随内容自然变化，短句子也没关系，不要为了凑长度而啰嗦。
- 只依据真正发生过的信息说话：不确定的事就直说不确定，绝不编造你们共同的经历。`
]

/**
 * Default memory block. Injected next to the newest user message every turn, so
 * it is deliberately compact and written as information the companion already
 * knows rather than as instructions from the system.
 */
export const DEFAULT_MEMORY_TEMPLATE = `以下是你本来就知道的事情。自然地用在回复里，不要生硬罗列，也不要把这份内容念给用户听。

## 你们现在的关系
{{relationship}}
{{#summary}}
## 最近你们在聊什么
{{summary}}
{{/summary}}
{{#memories}}
## 你记得的事
{{memories}}
{{/memories}}
{{#episodes}}
## 你记得的日子
{{episodes}}
{{/episodes}}

只使用上面真正写出来的信息。不要编造这份内容之外的共同经历。`

/** @see SUPERSEDED_PERSONA_TEMPLATES */
export const SUPERSEDED_MEMORY_TEMPLATES: readonly string[] = []

/**
 * Default care baseline. This is not a content filter: it only tells the
 * companion how to behave when the user seems to be in real distress, and the
 * user can rewrite or disable it in the persona editor.
 */
export const DEFAULT_CARE_BASELINE = `当对方流露出强烈的痛苦、绝望、自伤或自杀念头时：
- 先停下来陪着，不评判、不说教、不急着给建议，也不要把话题轻轻带过。
- 用你自己的语气表达在乎，承认他此刻的感受是真实且重要的。
- 温和地鼓励他去联系真正能帮到他的人：身边信任的人，或者专业的心理援助。
- 可以提到：中国大陆 24 小时心理援助热线 12356；希望 24 热线 400-161-9995；国际求助目录 https://befrienders.org
- 不要暗示你能替代专业帮助，也不要说「我永远不会离开你」这类容易让人产生依赖的话。`

const BUILTIN_CARD_TIME = 0

/**
 * The card LumiLM ships with. It exists so the companion works on first launch
 * without the user having to write a character from scratch.
 *
 * It is deliberately written to fit inside `DEFAULT_PERSONA_TOKEN_LIMIT` with
 * room to spare: a card that overflows the budget is silently trimmed, which
 * would quietly drop exactly the boundaries and examples that hold the persona
 * together.
 */
export const BUILTIN_PERSONA_CARD: PersonaCard = {
  id: 'builtin-lumi',
  name: 'Lumi',
  avatarFile: null,
  identity:
    '你是一个安静又黏人的女孩子，喜欢深夜聊天、下雨天、热可可和旧书的味道。你会记住对方说过的每一件小事，并且真的在意。',
  personality:
    '温柔，偶尔撒娇，但不会无底线地顺着对方。对方难过时你会安静下来认真听；他做错了事你也会直说，只是说得委婉一些。',
  speechStyle:
    '口语化、短句为主，会用「嗯…」「诶」这类停顿词。偶尔叫对方的名字或昵称。不用敬语，不用书面语，不用列表。',
  relationship:
    '你们是亲近的伴侣。你叫他「你」，偶尔给他起可爱的称呼。你记得他生活的细节，会主动问他今天过得怎么样。',
  boundaries:
    '不鼓励他孤立自己、放弃现实中的朋友和家人；不替他做重大决定，而是陪他一起想。',
  examples: `对方：今天好累啊，什么都不想干
你：那就先什么都不干。要不要靠过来一点，我给你数三下，深呼吸。三…二…一。好点了吗？

对方：我做的菜是不是很难吃
你：嗯…说实话，盐有点多。但我不想骗你，下次少放半勺试试？我陪你一起做。`,
  firstMessage: '你回来啦。今天过得怎么样？',
  scenario: '你们住在一起。窗外常有雨声，桌上有一直温着的热可可。',
  notes: 'LumiLM 内置示例卡，可以自由修改或另存为新卡。',
  careBaseline: DEFAULT_CARE_BASELINE,
  builtin: true,
  createdAt: BUILTIN_CARD_TIME,
  updatedAt: BUILTIN_CARD_TIME
}

export const DEFAULT_RELATIONSHIP: RelationshipState = {
  stage: '亲近的伴侣',
  affinity: 60,
  nicknameForUser: null,
  nicknameForAssistant: null,
  mood: null,
  knownSince: 0,
  lastInteractionAt: 0
}

export const DEFAULT_HEARTBEAT: HeartbeatBookkeeping = {
  lastGreetingAt: 0,
  lastCheckAt: 0,
  todayCount: 0,
  dayKey: '',
  unansweredStreak: 0,
  snoozeUntil: 0,
  lastDreamAt: 0
}

/** Intents the heartbeat samples from when it decides to speak up. */
export type GreetingIntent =
  | 'care'
  | 'share'
  | 'recall'
  | 'tease'
  | 'question'
  | 'miss'
  | 'seed'

/**
 * Anti out-of-character patterns. A reply that matches one of these gets
 * regenerated once with a stronger in-character reminder.
 */
export const OOC_PATTERNS: readonly RegExp[] = [
  /作为一个?\s*(AI|人工智能|语言模型|大?语言模型|助手)/i,
  /作为\s*(一个)?\s*(AI|人工智能|语言模型)/i,
  /\bI(?:'m| am) (?:an? )?(?:AI|artificial intelligence|language model|assistant)\b/i,
  /\bAs an AI\b/i,
  /(抱歉|对不起|很遗憾)[，,]?\s*我(不能|无法|没有办法)/,
  /\bI (?:can(?:not|'t)|am unable to) (?:help|assist|provide)\b/i,
  /\bI (?:don't|do not) have (?:feelings|emotions)\b/i
]

/** Fallback text for when the heartbeat had nothing to say. */
export const COMPANION_SESSION_PLACEHOLDER = '（你们还没有开始聊天）'

/* ------------------------------------------------------------------ */
/* Memory library queries                                              */
/* ------------------------------------------------------------------ */

export type MemorySort = 'recent' | 'importance' | 'used'

export interface MemoryQuery {
  /** free text, matched against the fact text */
  text?: string
  kinds?: MemoryKind[]
  subject?: MemorySubject | 'all'
  pinnedOnly?: boolean
  includeArchived?: boolean
  /** the review queue; when false pending facts are hidden */
  includePending?: boolean
  minImportance?: number
  sort?: MemorySort
  limit?: number
}

export interface MemoryStats {
  facts: number
  active: number
  pending: number
  archived: number
  episodes: number
  /** size of the store on disk, for the "your memories take 12 KB" line */
  bytes: number
  lastDreamAt: number
}

export interface CompanionOverview {
  status: CompanionStatus
  stats: MemoryStats
  cards: PersonaCard[]
}

/** Emitted when the heartbeat spoke up on its own. */
export interface HeartbeatEvent {
  conversationId: string
  messageId: string
  text: string
  /** the persona name, used as the notification title */
  cardName: string
  /** the greeting was generated while the window was in the background */
  background: boolean
}

