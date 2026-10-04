import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { shell } from 'electron'
import type {
  BackendKind,
  GgufMetadata,
  ModelInfo,
  ModelSuggestion,
  PerfPreset,
  RecommendedParams,
  SamplingParams
} from '@shared/types'
import { readJsonSync, writeJsonAtomicSync } from '../util/atomic-json'
import { logger } from '../util/logger'
import { getPaths } from '../store/paths'
import { settingsStore } from '../store/settings'
import { computeRecommendation } from '../llama/auto-tune'
import { detectHardware } from '../llama/hardware'
import { readGgufMetadata } from './reader'

const PROJECTOR_PATTERN = /mmproj|projector|vision_encoder/i
const MAX_SCAN_DEPTH = 4
const MAX_SCAN_ENTRIES = 4000

interface RegistryEntry {
  path: string
  addedAt: number
  lastUsedAt: number | null
  sizeBytes: number
  metadata: GgufMetadata | null
  metadataError: string | null
  defaultSampling: SamplingParams | null
  backendOverride: BackendKind | null
}

interface RegistryFile {
  version: number
  entries: RegistryEntry[]
}

export function modelIdFor(filePath: string): string {
  const normalized = process.platform === 'win32' ? resolve(filePath).toLowerCase() : resolve(filePath)
  return createHash('sha1').update(normalized).digest('hex').slice(0, 16)
}

export function isProjectorFile(fileName: string): boolean {
  return PROJECTOR_PATTERN.test(fileName)
}

function isGguf(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.gguf')
}

function listGgufFiles(dir: string, depth = 0, acc: string[] = []): string[] {
  if (depth > MAX_SCAN_DEPTH || acc.length >= MAX_SCAN_ENTRIES) return acc
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }

  for (const entry of entries) {
    if (acc.length >= MAX_SCAN_ENTRIES) break
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      listGgufFiles(full, depth + 1, acc)
    } else if (entry.isFile() && isGguf(entry.name)) {
      acc.push(full)
    }
  }
  return acc
}

/** Pairs a model with the most plausible projector file in the same folder. */
function pairProjector(modelPath: string, candidates: string[]): string | null {
  const dir = dirname(modelPath)
  const siblings = candidates.filter((file) => dirname(file) === dir)
  if (siblings.length === 0) return null
  if (siblings.length === 1) return siblings[0] ?? null

  const tokens = basename(modelPath)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 3)

  let best: { path: string; score: number } | null = null
  for (const sibling of siblings) {
    const name = basename(sibling).toLowerCase()
    const score = tokens.reduce((total, token) => (name.includes(token) ? total + 1 : total), 0)
    if (!best || score > best.score) best = { path: sibling, score }
  }
  return best?.path ?? null
}

class ModelLibrary {
  private entries: RegistryEntry[] | null = null
  private cache: ModelInfo[] | null = null

  private registryPath(): string {
    return join(getPaths().dataDir, 'models.json')
  }

  private load(): RegistryEntry[] {
    if (this.entries) return this.entries
    const raw = readJsonSync<RegistryFile>(this.registryPath())
    const entries = Array.isArray(raw?.entries) ? raw.entries : []
    this.entries = entries.filter((entry) => entry && typeof entry.path === 'string')
    return this.entries
  }

  private persist(): void {
    const payload: RegistryFile = { version: 1, entries: this.load() }
    writeJsonAtomicSync(this.registryPath(), payload)
  }

  private inspect(path: string, existing?: RegistryEntry): RegistryEntry {
    const fileName = basename(path)
    let sizeBytes: number
    try {
      sizeBytes = statSync(path).size
    } catch {
      sizeBytes = 0
    }

    if (existing && existing.sizeBytes === sizeBytes && existing.metadata) {
      return existing
    }

    let metadata: GgufMetadata | null = null
    let metadataError: string | null = null
    try {
      metadata = readGgufMetadata(path, fileName)
    } catch (error) {
      metadataError = error instanceof Error ? error.message : String(error)
      logger.warn('models', `failed to read GGUF header for ${fileName}: ${metadataError}`)
    }

    return {
      path,
      addedAt: existing?.addedAt ?? Date.now(),
      lastUsedAt: existing?.lastUsedAt ?? null,
      sizeBytes,
      metadata,
      metadataError,
      defaultSampling: existing?.defaultSampling ?? null,
      backendOverride: existing?.backendOverride ?? null
    }
  }

  private async build(forceHardware = false): Promise<ModelInfo[]> {
    const entries = this.load().filter((entry) => existsSync(entry.path))
    const allGguf = entries.flatMap((entry) => {
      const dir = dirname(entry.path)
      return listGgufFiles(dir).filter(
        (file) => dirname(file) === dir && isProjectorFile(basename(file))
      )
    })

    const uniqueProjectors = Array.from(new Set(allGguf))
    const settings = settingsStore.get()
    const hardware = await detectHardware(forceHardware)

    const models: ModelInfo[] = []
    for (const entry of entries) {
      const isProjector = isProjectorFile(basename(entry.path))
      if (isProjector) continue

      const mmprojPath = pairProjector(entry.path, uniqueProjectors)

      let recommended: RecommendedParams | null = null
      try {
        const backend = settings.inference.backend
        const resolved = entry.backendOverride && entry.backendOverride !== 'auto' ? entry.backendOverride : backend
        const effective =
          resolved === 'auto' ? (hardware.selectedBackend ?? 'cpu') : (resolved as 'cpu' | 'vulkan' | 'cuda')

        let mmprojBytes = 0
        if (settings.models.mmprojEnabled && mmprojPath) {
          try {
            mmprojBytes = statSync(mmprojPath).size
          } catch {
            mmprojBytes = 0
          }
        }

        recommended = computeRecommendation({
          model: toModelInfo(entry, mmprojPath),
          hardware,
          preset: settings.inference.perfPreset,
          backend: effective,
          vramReserveMb: settings.inference.vramReserveMb,
          mmprojEnabled: settings.models.mmprojEnabled,
          mmprojBytes
        })
      } catch (error) {
        logger.warn('models', `recommendation failed for ${basename(entry.path)}: ${String(error)}`)
      }

      models.push(toModelInfo(entry, mmprojPath, recommended))
    }

    models.sort((a, b) => (b.lastUsedAt ?? b.addedAt) - (a.lastUsedAt ?? a.addedAt))
    return models
  }

  async list(force = false): Promise<ModelInfo[]> {
    if (!force && this.cache) return this.cache
    this.cache = await this.build(force)
    return this.cache
  }

  async get(id: string): Promise<ModelInfo | null> {
    const models = await this.list()
    return models.find((model) => model.id === id) ?? null
  }

  async addPaths(paths: string[]): Promise<ModelInfo[]> {
    const entries = this.load()
    let added = 0

    for (const raw of paths) {
      const path = resolve(raw)
      if (!existsSync(path) || !isGguf(path)) continue

      const index = entries.findIndex((entry) => entry.path === path)
      const existing = index >= 0 ? entries[index] : undefined
      const inspected = this.inspect(path, existing)

      if (index >= 0) entries[index] = inspected
      else {
        entries.push(inspected)
        added += 1
      }
    }

    if (added > 0) {
      this.persist()
      this.invalidate()
      const settings = settingsStore.get()
      const models = await this.list(true)
      if (!settings.models.activeModelId && models[0]) {
        settingsStore.update({ models: { activeModelId: models[0].id } })
      }
    }

    return this.list()
  }

  async addDirectory(dir: string): Promise<ModelInfo[]> {
    const found = listGgufFiles(resolve(dir)).filter((file) => !isProjectorFile(basename(file)))
    if (found.length === 0) return this.list()

    const settings = settingsStore.get()
    const directories = Array.from(new Set([...settings.models.directories, resolve(dir)]))
    settingsStore.update({ models: { directories } })

    return this.addPaths(found)
  }

  async refresh(id?: string): Promise<ModelInfo[]> {
    const entries = this.load()
    if (id) {
      const index = entries.findIndex((entry) => modelIdFor(entry.path) === id)
      if (index >= 0 && entries[index]) entries[index] = this.inspect(entries[index]!.path)
    } else {
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i]
        if (entry) entries[i] = this.inspect(entry.path, undefined)
      }
    }
    this.persist()
    this.invalidate()
    return this.list(true)
  }

  remove(id: string, deleteFile = false): void {
    const entries = this.load()
    const target = entries.find((entry) => modelIdFor(entry.path) === id)
    this.entries = entries.filter((entry) => modelIdFor(entry.path) !== id)
    this.persist()
    this.invalidate()

    const settings = settingsStore.get()
    if (settings.models.activeModelId === id) {
      settingsStore.update({ models: { activeModelId: null } })
    }

    if (deleteFile && target && existsSync(target.path)) {
      void shell.trashItem(target.path).catch(() => undefined)
    }
  }

  async update(
    id: string,
    patch: { defaultSampling?: SamplingParams | null; backendOverride?: BackendKind | null }
  ): Promise<ModelInfo | null> {
    const entries = this.load()
    const entry = entries.find((item) => modelIdFor(item.path) === id)
    if (!entry) return null
    if (patch.defaultSampling !== undefined) entry.defaultSampling = patch.defaultSampling
    if (patch.backendOverride !== undefined) entry.backendOverride = patch.backendOverride
    this.persist()
    this.invalidate()
    return this.get(id)
  }

  markUsed(id: string): void {
    const entries = this.load()
    const entry = entries.find((item) => modelIdFor(item.path) === id)
    if (!entry) return
    entry.lastUsedAt = Date.now()
    const settings = settingsStore.get()
    this.persist()
    this.invalidate()
    if (settings.models.activeModelId !== id) {
      settingsStore.update({ models: { activeModelId: id } })
    }
  }

  /** Directories that are searched for models on first run. */
  searchDirectories(): string[] {
    const home = homedir()
    const candidates = [
      join(home, 'Downloads'),
      join(home, 'Desktop'),
      join(home, 'Documents'),
      getPaths().modelsDir,
      getPaths().dataDir,
      ...settingsStore.get().models.directories
    ]
    return Array.from(new Set(candidates.filter((dir) => existsSync(dir))))
  }

  suggest(): ModelSuggestion {
    const registered = new Set(this.load().map((entry) => resolve(entry.path)))
    const searchedDirs = this.searchDirectories()
    const found: string[] = []

    for (const dir of searchedDirs) {
      for (const file of listGgufFiles(dir, 0, [])) {
        if (found.length >= 60) break
        if (!registered.has(resolve(file))) found.push(resolve(file))
      }
    }

    const projectors = found.filter((file) => isProjectorFile(basename(file)))
    const candidates = found
      .filter((file) => !isProjectorFile(basename(file)))
      .map((modelPath) => {
        const mmproj = pairProjector(modelPath, projectors)
        let sizeBytes: number
        try {
          sizeBytes = statSync(modelPath).size
        } catch {
          sizeBytes = 0
        }
        return { modelPath, mmprojPath: mmproj, sizeBytes }
      })
      .sort((a, b) => b.sizeBytes - a.sizeBytes)

    return { candidates, searchedDirs }
  }

  async recommend(
    id: string,
    preset?: PerfPreset,
    backend?: BackendKind,
    forceHardware = false
  ): Promise<RecommendedParams | null> {
    const entry = this.load().find((item) => modelIdFor(item.path) === id)
    if (!entry) return null

    const settings = settingsStore.get()
    const hardware = await detectHardware(forceHardware)
    const preferred = backend ?? entry.backendOverride ?? settings.inference.backend
    const effective =
      preferred === 'auto'
        ? (hardware.selectedBackend ?? 'cpu')
        : (preferred as 'cpu' | 'vulkan' | 'cuda')

    const projectors = listGgufFiles(dirname(entry.path)).filter(
      (file) => dirname(file) === dirname(entry.path) && isProjectorFile(basename(file))
    )
    const mmprojPath = pairProjector(entry.path, projectors)
    let mmprojBytes = 0
    if (settings.models.mmprojEnabled && mmprojPath) {
      try {
        mmprojBytes = statSync(mmprojPath).size
      } catch {
        mmprojBytes = 0
      }
    }

    return computeRecommendation({
      model: toModelInfo(entry, mmprojPath),
      hardware,
      preset: preset ?? settings.inference.perfPreset,
      backend: effective,
      vramReserveMb: settings.inference.vramReserveMb,
      mmprojEnabled: settings.models.mmprojEnabled,
      mmprojBytes
    })
  }

  invalidate(): void {
    this.cache = null
  }
}

function toModelInfo(
  entry: RegistryEntry,
  mmprojPath: string | null,
  recommended?: RecommendedParams | null
): ModelInfo {
  return {
    id: modelIdFor(entry.path),
    path: entry.path,
    fileName: basename(entry.path),
    sizeBytes: entry.sizeBytes,
    addedAt: entry.addedAt,
    lastUsedAt: entry.lastUsedAt,
    metadata: entry.metadata,
    metadataError: entry.metadataError,
    mmprojPath,
    mmprojMissing: mmprojPath === null,
    recommended: recommended ?? null,
    defaultSampling: entry.defaultSampling,
    backendOverride: entry.backendOverride
  }
}

export const modelLibrary = new ModelLibrary()
