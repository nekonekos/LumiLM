import { create } from 'zustand'
import type { AppSettings, DeepPartial } from '@shared/types'
import { applyTheme } from '@/lib/theme'

interface SettingsState {
  settings: AppSettings | null
  ready: boolean
  error: string | null
  load: () => Promise<void>
  update: (patch: DeepPartial<AppSettings>) => Promise<void>
  reset: () => Promise<void>
  applyFromEvent: (settings: AppSettings) => void
}

function syncSideEffects(settings: AppSettings): void {
  applyTheme(settings.general.themeMode, settings.general.accent)
  document.documentElement.style.setProperty('--lm-font-size', `${settings.appearance.fontSize}px`)
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  ready: false,
  error: null,

  load: async () => {
    try {
      const settings = await window.lumilm.settings.get()
      syncSideEffects(settings)
      set({ settings, ready: true, error: null })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), ready: true })
    }
  },

  update: async (patch) => {
    const settings = await window.lumilm.settings.update(patch)
    syncSideEffects(settings)
    set({ settings })
  },

  reset: async () => {
    const settings = await window.lumilm.settings.reset()
    syncSideEffects(settings)
    set({ settings })
  },

  applyFromEvent: (settings) => {
    syncSideEffects(settings)
    set({ settings })
  }
}))
