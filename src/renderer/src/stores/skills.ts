import { create } from 'zustand'
import type { SkillInfo } from '@shared/types'

interface SkillsState {
  skills: SkillInfo[]
  directories: string[]
  loading: boolean

  refresh: () => Promise<void>
  refreshDirectories: () => Promise<void>
  addDirectory: () => Promise<string | null>
  removeDirectory: (directory: string) => Promise<void>
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  skills: [],
  directories: [],
  loading: false,

  refresh: async () => {
    set({ loading: true })
    try {
      set({ skills: await window.lumilm.skills.refresh() })
    } finally {
      set({ loading: false })
    }
  },

  refreshDirectories: async () => {
    const settings = await window.lumilm.settings.get()
    set({ directories: settings.skills.directories })
  },

  addDirectory: async () => {
    const directory = await window.lumilm.skills.addDirectory()
    if (directory) await Promise.all([get().refresh(), get().refreshDirectories()])
    return directory
  },

  removeDirectory: async (directory) => {
    await window.lumilm.skills.removeDirectory(directory)
    await Promise.all([get().refresh(), get().refreshDirectories()])
  }
}))
