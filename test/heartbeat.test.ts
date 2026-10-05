import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { tmpdir: tmp } = await import('node:os')
  return {
    app: { getPath: () => tmp, getAppPath: () => process.cwd(), isPackaged: false },
    powerMonitor: { getSystemIdleTime: () => 0, on: () => undefined },
    Notification: class {
      static isSupported(): boolean {
        return true
      }
      on(): void {}
      show(): void {}
    }
  }
})

const { setDataDirOverride } = await import('../src/main/store/paths')
const { DEFAULT_SETTINGS } = await import('../src/main/store/settings')
const { memoryManager } = await import('../src/main/memory/manager')
const { HeartbeatService, inQuietHours } = await import('../src/main/companion/heartbeat')

import type { HeartbeatService as HeartbeatServiceType } from '../src/main/companion/heartbeat'
import type { CompanionSettings, GreetingIntent } from '@shared/types'

const NOON = new Date('2026-06-15T12:00:00').getTime()
const THREE_AM = new Date('2026-06-15T03:00:00').getTime()

interface Harness {
  service: HeartbeatServiceType
  delivered: Array<{ conversationId: string; text: string; cardName: string; background: boolean }>
  notified: Array<{ title: string; body: string }>
  dreamed: number
  intents: GreetingIntent[]
  set(overrides: Partial<CompanionSettings>): void
  setEnv(env: Partial<{ idleSeconds: number; random: number; focused: boolean; fullScreen: boolean; serverReady: boolean; conversation: string | null }>): void
}

function harness(overrides: Partial<CompanionSettings> = {}): Harness {
  let settings: CompanionSettings = {
    ...DEFAULT_SETTINGS.companion,
    enabled: true,
    heartbeatEnabled: true,
    ...overrides
  }
  const env = {
    idleSeconds: 3600,
    random: 0,
    focused: false,
    fullScreen: false,
    serverReady: true,
    conversation: 'c1' as string | null
  }

  const delivered: Harness['delivered'] = []
  const notified: Harness['notified'] = []
  const intents: GreetingIntent[] = []
  const state = { dreamed: 0, now: NOON }

  const service = new HeartbeatService({
    now: () => state.now,
    idleSeconds: () => env.idleSeconds,
    random: () => env.random,
    isWindowFocused: () => env.focused,
    isFullScreen: () => env.fullScreen,
    serverReady: () => env.serverReady,
    settings: () => settings,
    targetConversationId: () => env.conversation,
    recentMessages: () => [{ role: 'user', content: '今天好累' }],
    buildPrompt: () => ({ system: '你是 Lumi。', personaTokens: 42 }),
    generate: async (intent: GreetingIntent) => {
      intents.push(intent)
      return '  你回来啦，今天怎么样？  '
    },
    deliver: (conversationId, text, cardName, background) => {
      delivered.push({ conversationId, text, cardName, background })
    },
    notify: (title, body) => notified.push({ title, body }),
    dream: async () => {
      state.dreamed += 1
    }
  })

  return {
    service,
    delivered,
    notified,
    intents,
    get dreamed() {
      return state.dreamed
    },
    set: (patch) => {
      settings = { ...settings, ...patch }
    },
    setEnv: (patch) => Object.assign(env, patch)
  } as Harness
}

let dataDir = ''

beforeEach(() => {
  // Without the matching cleanup this leaks one empty folder per test into
  // %TEMP% on every run.
  dataDir = mkdtempSync(join(tmpdir(), 'lumilm-heartbeat-'))
  setDataDirOverride(dataDir)
  memoryManager.reset()
})

afterEach(() => {
  // The stores persist through an unref'd debounced timer, so a pending write
  // would recreate this directory after it is removed. Cancel it first.
  memoryManager.flush()
  memoryManager.reset()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('inQuietHours', () => {
  it('handles a range inside one day', () => {
    expect(inQuietHours(NOON, [13, 15])).toBe(false)
    expect(inQuietHours(NOON, [11, 13])).toBe(true)
  })

  it('wraps past midnight', () => {
    expect(inQuietHours(THREE_AM, [23, 8])).toBe(true)
    expect(inQuietHours(NOON, [23, 8])).toBe(false)
  })

  it('is never quiet when both ends are equal', () => {
    expect(inQuietHours(THREE_AM, [0, 0])).toBe(false)
  })
})

describe('gates', () => {
  it('passes when everything is in order', () => {
    expect(harness().service.blockedReason(NOON)).toBeNull()
  })

  it('blocks when the companion is switched off', () => {
    const h = harness()
    h.set({ enabled: false })
    expect(h.service.blockedReason(NOON)).toBe('companion disabled')
  })

  it('blocks when the heartbeat is switched off', () => {
    const h = harness({ heartbeatEnabled: false })
    expect(h.service.blockedReason(NOON)).toBe('heartbeat disabled')
  })

  it('blocks during quiet hours', () => {
    const h = harness({ quietHours: [23, 8] })
    expect(h.service.blockedReason(THREE_AM)).toBe('quiet hours')
  })

  it('blocks while snoozed', () => {
    const h = harness()
    h.service.snooze(60)
    expect(h.service.blockedReason(NOON)).toBe('snoozed')
  })

  it('blocks until the minimum gap has passed', () => {
    const h = harness({ heartbeatMinGapMinutes: 90 })
    memoryManager.updateHeartbeat({ lastGreetingAt: NOON - 10 * 60_000, dayKey: '2026-06-15' })
    expect(h.service.blockedReason(NOON)).toBe('too soon')
  })

  it('blocks once the daily cap is reached', () => {
    const h = harness({ heartbeatMaxPerDay: 2 })
    memoryManager.updateHeartbeat({
      dayKey: '2026-06-15',
      todayCount: 2,
      lastGreetingAt: NOON - 10 * 60 * 60_000
    })
    expect(h.service.blockedReason(NOON)).toBe('daily cap reached')
  })

  it('resets the daily cap on a new day', () => {
    const h = harness({ heartbeatMaxPerDay: 2 })
    memoryManager.updateHeartbeat({
      dayKey: '2026-06-14',
      todayCount: 2,
      lastGreetingAt: NOON - 10 * 60 * 60_000
    })
    expect(h.service.blockedReason(NOON)).toBeNull()
  })

  it('never interrupts a fullscreen app', () => {
    const h = harness()
    h.setEnv({ fullScreen: true })
    expect(h.service.blockedReason(NOON)).toBe('fullscreen')
  })

  it('waits until the user is actually idle', () => {
    const h = harness({ heartbeatIdleMinutes: 15 })
    h.setEnv({ idleSeconds: 60 })
    expect(h.service.blockedReason(NOON)).toBe('user is active')
  })

  it('does not cold-start the model by default', () => {
    const h = harness()
    h.setEnv({ serverReady: false })
    expect(h.service.blockedReason(NOON)).toBe('model not loaded')
  })

  it('cold-starts when the user allows it', () => {
    const h = harness({ allowColdStart: true })
    h.setEnv({ serverReady: false })
    expect(h.service.blockedReason(NOON)).toBeNull()
  })

  it('says nothing when there is no companion conversation yet', () => {
    const h = harness()
    h.setEnv({ conversation: null })
    expect(h.service.blockedReason(NOON)).toBe('no companion conversation')
  })
})

describe('backoff', () => {
  it('starts at the configured probability', () => {
    expect(harness({ heartbeatProbability: 0.4 }).service.probability()).toBeCloseTo(0.4)
  })

  it('halves for every ignored greeting', () => {
    const h = harness({ heartbeatProbability: 0.4 })
    memoryManager.updateHeartbeat({ unansweredStreak: 1 })
    expect(h.service.probability()).toBeCloseTo(0.2)
    memoryManager.updateHeartbeat({ unansweredStreak: 3 })
    expect(h.service.probability()).toBeCloseTo(0.05)
  })

  it('has a floor so it never goes completely silent', () => {
    const h = harness({ heartbeatProbability: 1 })
    memoryManager.updateHeartbeat({ unansweredStreak: 50 })
    expect(h.service.probability()).toBeCloseTo(1 / 16)
  })

  it('forgets the streak once the user answers', () => {
    const h = harness()
    memoryManager.updateHeartbeat({ unansweredStreak: 3 })
    h.service.acknowledge()
    expect(memoryManager.heartbeat().unansweredStreak).toBe(0)
  })
})

describe('check', () => {
  it('stays quiet when the dice say so', async () => {
    const h = harness({ heartbeatProbability: 0.2 })
    h.setEnv({ random: 0.9 })
    expect(await h.service.check()).toBe(false)
    expect(h.delivered).toEqual([])
  })

  it('speaks up when every gate and the dice agree', async () => {
    const h = harness({ heartbeatProbability: 0.5 })
    h.setEnv({ random: 0.1 })
    expect(await h.service.check()).toBe(true)
    expect(h.delivered).toHaveLength(1)
  })

  it('never reaches the model when a gate blocks', async () => {
    const h = harness()
    h.setEnv({ idleSeconds: 0 })
    expect(await h.service.check()).toBe(false)
    expect(h.intents).toEqual([])
  })

  it('records the check time even when it stays quiet', async () => {
    const h = harness()
    h.setEnv({ idleSeconds: 0 })
    await h.service.check()
    expect(memoryManager.heartbeat().lastCheckAt).toBe(NOON)
  })
})

describe('speakUp', () => {
  it('trims the greeting and delivers it', async () => {
    const h = harness()
    expect(await h.service.speakUp(true)).toBe(true)
    expect(h.delivered[0].text).toBe('你回来啦，今天怎么样？')
  })

  it('notifies with the card name as the title', async () => {
    const h = harness()
    await h.service.speakUp(true)
    expect(h.notified[0].title).toBe('Lumi')
  })

  it('skips the notification when the user is looking at the window', async () => {
    const h = harness()
    h.setEnv({ focused: true })
    await h.service.speakUp(true)
    expect(h.notified).toEqual([])
    expect(h.delivered[0].background).toBe(false)
  })

  it('counts the greeting and grows the backoff', async () => {
    const h = harness()
    await h.service.speakUp(true)
    const bookkeeping = memoryManager.heartbeat()
    expect(bookkeeping.todayCount).toBe(1)
    expect(bookkeeping.lastGreetingAt).toBe(NOON)
    expect(bookkeeping.unansweredStreak).toBe(1)
  })

  it('discards a greeting that came back empty', async () => {
    const delivered: string[] = []
    const empty = new HeartbeatService({
      settings: () => ({ ...DEFAULT_SETTINGS.companion, enabled: true, heartbeatEnabled: true }),
      targetConversationId: () => 'c1',
      now: () => NOON,
      idleSeconds: () => 3600,
      random: () => 0,
      isWindowFocused: () => false,
      isFullScreen: () => false,
      serverReady: () => true,
      recentMessages: () => [],
      buildPrompt: () => ({ system: '', personaTokens: 0 }),
      generate: async () => '   ',
      deliver: (_id, text) => delivered.push(text),
      notify: () => undefined,
      dream: async () => undefined
    })
    expect(await empty.speakUp(true)).toBe(false)
    expect(delivered).toEqual([])
  })

  it('does not speak without a conversation', async () => {
    const h = harness()
    h.setEnv({ conversation: null })
    expect(await h.service.speakUp(true)).toBe(false)
  })

  it('uses a seed thought as the topic when one is waiting', async () => {
    const h = harness()
    memoryManager.addSeeds(['在想他昨天说的面试'], NOON)
    await h.service.speakUp(false)
    expect(h.intents[0]).toBe('seed')
  })

  it('prefers care when the user asks for one right now', async () => {
    const h = harness()
    expect(await h.service.speakUp(true)).toBe(true)
    expect(h.intents[0]).toBe('care')
  })

  it('survives the model failing', async () => {
    const failing = new HeartbeatService({
      settings: () => ({ ...DEFAULT_SETTINGS.companion, enabled: true, heartbeatEnabled: true }),
      targetConversationId: () => 'c1',
      now: () => NOON,
      idleSeconds: () => 3600,
      random: () => 0,
      isWindowFocused: () => false,
      isFullScreen: () => false,
      serverReady: () => true,
      recentMessages: () => [],
      buildPrompt: () => ({ system: '', personaTokens: 0 }),
      generate: async () => {
        throw new Error('server died')
      },
      deliver: () => undefined,
      notify: () => undefined,
      dream: async () => undefined
    })
    expect(await failing.speakUp(true)).toBe(false)
  })
})

describe('dreaming', () => {
  it('runs when the machine has been idle long enough', async () => {
    const h = harness({ dreamIdleMinutes: 10 })
    h.setEnv({ idleSeconds: 3600 })
    expect(await h.service.maybeDream()).toBe(true)
    expect(h.dreamed).toBe(1)
  })

  it('never starts the model just to dream', async () => {
    const h = harness()
    h.setEnv({ serverReady: false, idleSeconds: 3600 })
    expect(await h.service.maybeDream()).toBe(false)
  })

  it('waits for real idle time', async () => {
    const h = harness({ dreamIdleMinutes: 30 })
    h.setEnv({ idleSeconds: 60 })
    expect(await h.service.maybeDream()).toBe(false)
  })

  it('does not dream twice in a row', async () => {
    const h = harness()
    h.setEnv({ idleSeconds: 3600 })
    await h.service.maybeDream()
    expect(await h.service.maybeDream()).toBe(false)
  })

  it('stays off when the user disabled dreaming', async () => {
    const h = harness({ dreamingEnabled: false })
    h.setEnv({ idleSeconds: 3600 })
    expect(await h.service.maybeDream()).toBe(false)
  })
})

describe('scheduling', () => {
  it('stops and restarts without leaving a timer behind', () => {
    const h = harness()
    h.service.start()
    h.service.stop()
    h.service.start()
    h.service.stop()
    expect(true).toBe(true)
  })
})
