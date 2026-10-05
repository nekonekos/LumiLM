import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import type { AgentSettings, AppSettings, CompanionSettings, DeepPartial } from '@shared/types'
import {
  DEFAULT_AGENT_PREAMBLE,
  DEFAULT_COMPANION_SAMPLING,
  DEFAULT_MEMORY_TEMPLATE,
  DEFAULT_PERSONA_TEMPLATE,
  DEFAULT_RECALL_COUNT,
  DEFAULT_RECALL_TOKEN_BUDGET,
  DEFAULT_SUMMARY_TOKEN_BUDGET,
  DEFAULT_PERSONA_TOKEN_LIMIT,
  SUPERSEDED_AGENT_PREAMBLES,
  SUPERSEDED_MEMORY_TEMPLATES,
  SUPERSEDED_PERSONA_TEMPLATES
} from '@shared/types'
import { readJsonSync, writeJsonAtomicSync } from '../util/atomic-json'
import { logger, toError } from '../util/logger'
import { ensureDataDirs, getPaths, setDataDirOverride } from './paths'

const SETTINGS_VERSION = 3

export const DEFAULT_SETTINGS: AppSettings = {
  version: SETTINGS_VERSION,
  general: {
    locale: 'zh-CN',
    themeMode: 'system',
    accent: '#3b82f6',
    dataDir: null,
    confirmOnDelete: true
  },
  appearance: {
    fontSize: 15,
    density: 'comfortable',
    layout: 'bubble',
    showReasoning: true,
    wideTables: true
  },
  inference: {
    backend: 'auto',
    perfPreset: 'balanced',
    gpuLayers: 'auto',
    contextSize: 'auto',
    kvCacheType: 'auto',
    threads: 'auto',
    batchSize: 'auto',
    flashAttention: 'auto',
    useMmap: true,
    useMlock: false,
    vramReserveMb: 1024,
    idleUnloadMinutes: 0,
    extraArgs: ''
  },
  models: {
    directories: [],
    activeModelId: null,
    mmprojEnabled: true
  },
  advanced: {
    logLevel: 'info',
    updateCheck: false
  },
  agent: {
    defaultMode: 'chat',
    permission: 'ask-risky',
    thinking: 'unlimited',
    maxIterations: 6,
    maxToolResultChars: 8000,
    toolSchemaTokenWarn: 1500,
    injectPrompt: true,
    preambleTemplate: DEFAULT_AGENT_PREAMBLE,
    parseTextToolCalls: true,
    fileToolsEnabled: false,
    shellToolsEnabled: false,
    workspaceRoot: null,
    allowRemoteMcp: false
  },
  mcp: {
    autoConnect: true,
    toolPermissions: {},
    callTimeoutMs: 60000
  },
  skills: {
    directories: [],
    defaultEnabledIds: []
  },
  companion: {
    enabled: false,
    characterCardId: 'builtin-lumi',
    personaTemplate: DEFAULT_PERSONA_TEMPLATE,
    memoryTemplate: DEFAULT_MEMORY_TEMPLATE,
    memoryInjectionMode: 'user-suffix',
    memoryEnabled: true,
    autoExtract: true,
    autoAcceptFacts: false,
    extractDelayMs: 600,
    recallCount: DEFAULT_RECALL_COUNT,
    recallTokenBudget: DEFAULT_RECALL_TOKEN_BUDGET,
    summaryTokenBudget: DEFAULT_SUMMARY_TOKEN_BUDGET,
    personaTokenLimit: DEFAULT_PERSONA_TOKEN_LIMIT,
    includeEpisodes: true,
    antiOocRetry: true,
    skipThinking: true,
    heartbeatEnabled: false,
    heartbeatIdleMinutes: 15,
    heartbeatProbability: 0.3,
    heartbeatMinGapMinutes: 90,
    heartbeatMaxPerDay: 3,
    quietHours: [23, 8],
    snoozeMinutes: 60,
    focusOnNotification: true,
    allowColdStart: false,
    dreamingEnabled: true,
    dreamIdleMinutes: 10,
    sampling: { ...DEFAULT_COMPANION_SAMPLING }
  } satisfies CompanionSettings,
  ui: {
    sidebarWidth: 268,
    sidebarCollapsed: false,
    inspectorCollapsed: false
  },
  window: {
    width: 1280,
    height: 820,
    x: null,
    y: null,
    maximized: false
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Recursively merges a partial patch into a base object, ignoring `undefined`. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base
  if (!isPlainObject(base)) return patch as T

  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = result[key]
    result[key] = isPlainObject(value) && isPlainObject(current) ? deepMerge(current, value) : value
  }
  return result as T
}

/** Compares prompt text without caring about the line endings of the source file. */
function sameTemplate(a: string, b: string): boolean {
  return a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n')
}

/**
 * A stored template is a verbatim copy of whatever default shipped when the
 * settings file was first written, so editing the default in source has no
 * effect on an existing install. Returns the replacement when the stored text
 * is a superseded default, and null when it is anything else — a template the
 * user edited never matches and is therefore left alone.
 */
function migratedTemplate(
  stored: unknown,
  superseded: readonly string[],
  current: string
): string | null {
  if (typeof stored !== 'string') return null
  return superseded.some((template) => sameTemplate(template, stored)) ? current : null
}

/** Fills in any missing key so an older settings file keeps working after an update. */
export function normalizeSettings(stored: unknown): { settings: AppSettings; migrated: boolean } {
  const raw = isPlainObject(stored) ? stored : {}
  const settings = deepMerge(DEFAULT_SETTINGS, stored)
  let migrated = false

  // `deepMerge` lets a stored value win, which would pin the file to whatever
  // version first wrote it. The field is the only record of which shape the
  // file was written in, so it is forced rather than merged.
  if (settings.version !== SETTINGS_VERSION) {
    settings.version = SETTINGS_VERSION
    migrated = true
  }

  const legacy = settings.agent as AgentSettings & { workspaceToolsEnabled?: boolean }
  // 0.2.0 exposed a single `workspaceToolsEnabled` switch; it now covers only
  // the file tools. Dropping the key keeps it from being written back forever.
  if (legacy.workspaceToolsEnabled !== undefined) {
    if (legacy.workspaceToolsEnabled) settings.agent.fileToolsEnabled = true
    delete legacy.workspaceToolsEnabled
    migrated = true
  }

  // Companion is not a mode a new conversation should inherit. It carries a
  // persona, memories and a lock, and it has its own entry point, so letting it
  // become the default turned every 新建对话 into a locked companion — which is
  // exactly what a user who merely previewed the mode ended up with.
  if (settings.agent.defaultMode === 'companion') {
    settings.agent.defaultMode = 'chat'
    migrated = true
  }

  const storedAgent = isPlainObject(raw.agent) ? raw.agent : {}
  const storedCompanion = isPlainObject(raw.companion) ? raw.companion : {}

  const templates: Array<{ stored: unknown; superseded: readonly string[]; current: string; apply: (text: string) => void }> = [
    {
      stored: storedAgent.preambleTemplate,
      superseded: SUPERSEDED_AGENT_PREAMBLES,
      current: DEFAULT_AGENT_PREAMBLE,
      apply: (text) => {
        settings.agent.preambleTemplate = text
      }
    },
    {
      stored: storedCompanion.personaTemplate,
      superseded: SUPERSEDED_PERSONA_TEMPLATES,
      current: DEFAULT_PERSONA_TEMPLATE,
      apply: (text) => {
        settings.companion.personaTemplate = text
      }
    },
    {
      stored: storedCompanion.memoryTemplate,
      superseded: SUPERSEDED_MEMORY_TEMPLATES,
      current: DEFAULT_MEMORY_TEMPLATE,
      apply: (text) => {
        settings.companion.memoryTemplate = text
      }
    }
  ]

  for (const entry of templates) {
    const next = migratedTemplate(entry.stored, entry.superseded, entry.current)
    if (next === null) continue
    entry.apply(next)
    migrated = true
  }

  return { settings, migrated }
}

class SettingsStore extends EventEmitter {
  private settings: AppSettings | null = null
  private writeTimer: NodeJS.Timeout | null = null

  load(): AppSettings {
    if (this.settings) return this.settings

    ensureDataDirs()
    const file = getPaths().settingsFile
    const raw = readJsonSync<unknown>(file)
    const { settings, migrated } = normalizeSettings(raw)
    this.settings = settings

    if (this.settings.general.dataDir && existsSync(this.settings.general.dataDir)) {
      setDataDirOverride(this.settings.general.dataDir)
      ensureDataDirs()
    } else if (this.settings.general.dataDir) {
      logger.warn('settings', 'configured data directory is missing, falling back to default')
      this.settings.general.dataDir = null
      setDataDirOverride(null)
    }

    // Write the migrated shape back once, so the stale keys disappear from disk
    // even if the user never changes a setting.
    if (migrated) this.save()

    return this.settings
  }

  get(): AppSettings {
    return this.load()
  }

  update(patch: DeepPartial<AppSettings>): AppSettings {
    const merged = deepMerge(this.get(), patch)
    const previousDataDir = this.settings?.general.dataDir ?? null
    this.settings = merged

    if (merged.general.dataDir !== previousDataDir) {
      setDataDirOverride(merged.general.dataDir)
      ensureDataDirs()
    }

    this.save()
    this.emit('changed', this.settings)
    return this.settings
  }

  reset(): AppSettings {
    setDataDirOverride(null)
    this.settings = { ...DEFAULT_SETTINGS }
    this.save()
    this.emit('changed', this.settings)
    return this.settings
  }

  /** Persists the settings file that belongs to the *current* data directory. */
  save(): void {
    if (!this.settings) return
    try {
      writeJsonAtomicSync(getPaths().settingsFile, this.settings)
    } catch (error) {
      logger.error('settings', `failed to persist settings: ${toError(error).message}`)
    }
  }

  /** Debounced save used for high frequency updates such as window resizing. */
  saveSoon(delayMs = 400): void {
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      this.save()
    }, delayMs)
  }
}

export const settingsStore = new SettingsStore()
