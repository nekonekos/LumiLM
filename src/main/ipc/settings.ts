import { randomUUID } from 'node:crypto'
import { CH } from '@shared/channels'
import type { AppSettings, DeepPartial, PromptPreset } from '@shared/types'
import { settingsStore } from '../store/settings'
import { presetStore } from '../store/presets'
import { modelLibrary } from '../gguf/scanner'
import { applyThemeSource } from '../window'
import { logger } from '../util/logger'
import { registerHandler } from './register'

function afterSettingsChange(previous: AppSettings, next: AppSettings): void {
  if (previous.general.themeMode !== next.general.themeMode) {
    applyThemeSource(next.general.themeMode)
  }
  if (previous.advanced.logLevel !== next.advanced.logLevel) {
    logger.setLevel(next.advanced.logLevel)
  }
  if (previous.models.mmprojEnabled !== next.models.mmprojEnabled) {
    modelLibrary.invalidate()
  }
  if (
    previous.inference.backend !== next.inference.backend ||
    previous.inference.perfPreset !== next.inference.perfPreset ||
    previous.inference.vramReserveMb !== next.inference.vramReserveMb ||
    previous.general.dataDir !== next.general.dataDir
  ) {
    modelLibrary.invalidate()
  }
}

export function registerSettingsHandlers(): void {
  registerHandler(CH.settings.get, (): AppSettings => settingsStore.get())

  registerHandler(CH.settings.update, (_event, patch: DeepPartial<AppSettings>): AppSettings => {
    if (typeof patch !== 'object' || patch === null) return settingsStore.get()
    const previous = settingsStore.get()
    const next = settingsStore.update(patch)
    afterSettingsChange(previous, next)
    return next
  })

  registerHandler(CH.settings.reset, (): AppSettings => {
    const previous = settingsStore.get()
    const next = settingsStore.reset()
    afterSettingsChange(previous, next)
    applyThemeSource(next.general.themeMode)
    return next
  })

  registerHandler(CH.presets.list, (): PromptPreset[] => presetStore.list())

  registerHandler(CH.presets.save, (_event, preset: PromptPreset): PromptPreset[] => {
    const normalized: PromptPreset = {
      id: typeof preset?.id === 'string' && preset.id.length > 0 ? preset.id : randomUUID(),
      name: typeof preset?.name === 'string' ? preset.name : 'Preset',
      description: typeof preset?.description === 'string' ? preset.description : '',
      systemPrompt: typeof preset?.systemPrompt === 'string' ? preset.systemPrompt : '',
      sampling: preset?.sampling ?? null,
      createdAt: typeof preset?.createdAt === 'number' ? preset.createdAt : Date.now(),
      updatedAt: Date.now()
    }
    return presetStore.save(normalized)
  })

  registerHandler(CH.presets.remove, (_event, id: string): PromptPreset[] => {
    if (typeof id !== 'string') return presetStore.list()
    return presetStore.remove(id)
  })
}
