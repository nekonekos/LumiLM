import type { PromptPreset } from '@shared/types'
import { readJsonSync, writeJsonAtomicSync } from '../util/atomic-json'
import { ensureDataDirs, getPaths } from './paths'

/**
 * User authored prompt presets. LumiLM deliberately ships an empty list: the
 * application never provides built in prompts or personas.
 */
class PresetStore {
  private cache: PromptPreset[] | null = null

  private file(): string {
    return getPaths().presetsFile
  }

  list(): PromptPreset[] {
    if (this.cache) return this.cache
    ensureDataDirs()
    const raw = readJsonSync<PromptPreset[]>(this.file())
    this.cache = Array.isArray(raw) ? raw.filter((p) => p && typeof p.id === 'string') : []
    return this.cache
  }

  save(preset: PromptPreset): PromptPreset[] {
    const presets = this.list()
    const index = presets.findIndex((p) => p.id === preset.id)
    const next = { ...preset, updatedAt: Date.now() }
    if (index >= 0) presets[index] = next
    else presets.push(next)
    this.cache = presets
    this.persist()
    return this.list()
  }

  remove(id: string): PromptPreset[] {
    this.cache = this.list().filter((p) => p.id !== id)
    this.persist()
    return this.list()
  }

  private persist(): void {
    ensureDataDirs()
    writeJsonAtomicSync(this.file(), this.cache ?? [])
  }
}

export const presetStore = new PresetStore()
