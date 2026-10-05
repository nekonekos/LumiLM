import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import type { AppSettings, DeepPartial } from '@shared/types'
import { DEFAULT_AGENT_PREAMBLE } from '@shared/types'
import { readJsonSync, writeJsonAtomicSync } from '../util/atomic-json'
import { logger, toError } from '../util/logger'
import { ensureDataDirs, getPaths, setDataDirOverride } from './paths'

const SETTINGS_VERSION = 2

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
    maxIterations: 6,
    maxToolResultChars: 8000,
    toolSchemaTokenWarn: 1500,
    injectPrompt: true,
    preambleTemplate: DEFAULT_AGENT_PREAMBLE,
    parseTextToolCalls: true,
    workspaceToolsEnabled: false,
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

/** Fills in any missing key so an older settings file keeps working after an update. */
function normalize(stored: unknown): AppSettings {
  return deepMerge(DEFAULT_SETTINGS, stored)
}

class SettingsStore extends EventEmitter {
  private settings: AppSettings | null = null
  private writeTimer: NodeJS.Timeout | null = null

  load(): AppSettings {
    if (this.settings) return this.settings

    ensureDataDirs()
    const file = getPaths().settingsFile
    const raw = readJsonSync<unknown>(file)
    this.settings = normalize(raw)

    if (this.settings.general.dataDir && existsSync(this.settings.general.dataDir)) {
      setDataDirOverride(this.settings.general.dataDir)
      ensureDataDirs()
    } else if (this.settings.general.dataDir) {
      logger.warn('settings', 'configured data directory is missing, falling back to default')
      this.settings.general.dataDir = null
      setDataDirOverride(null)
    }

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
