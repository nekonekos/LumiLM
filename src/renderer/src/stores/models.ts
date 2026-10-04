import { create } from 'zustand'
import type {
  BackendKind,
  HardwareInfo,
  ModelInfo,
  ModelSuggestion,
  PerfPreset,
  RecommendedParams
} from '@shared/types'
import { useUiStore } from './ui'
import { useSettingsStore } from './settings'
import { translate } from '@/i18n'
import type { MessageKey } from '@/i18n'

export function describeErrorKey(message: string): MessageKey | null {
  const known: MessageKey[] = [
    'error.NO_MODELS',
    'error.MODEL_MISSING',
    'error.BACKEND_MISSING',
    'error.SERVER_BUSY',
    'error.SERVER_NOT_READY'
  ]
  return known.find((key) => key.slice('error.'.length) === message) ?? null
}

interface ModelsState {
  models: ModelInfo[]
  hardware: HardwareInfo | null
  suggestion: ModelSuggestion | null
  loading: boolean
  hardwareLoading: boolean

  load: () => Promise<void>
  detectHardware: (force?: boolean) => Promise<void>
  addFiles: () => Promise<void>
  addFolder: () => Promise<void>
  addPaths: (paths: string[]) => Promise<void>
  remove: (id: string) => Promise<void>
  refresh: () => Promise<void>
  suggest: () => Promise<void>
  recommend: (id: string, preset?: PerfPreset, backend?: BackendKind) => Promise<RecommendedParams | null>
  activeModel: () => ModelInfo | null
}

export const useModelsStore = create<ModelsState>((set, get) => ({
  models: [],
  hardware: null,
  suggestion: null,
  loading: false,
  hardwareLoading: false,

  load: async () => {
    set({ loading: true })
    try {
      const models = await window.lumilm.models.list()
      set({ models })
    } finally {
      set({ loading: false })
    }
  },

  detectHardware: async (force) => {
    set({ hardwareLoading: true })
    try {
      const hardware = await window.lumilm.hardware.detect(force)
      set({ hardware })
    } finally {
      set({ hardwareLoading: false })
    }
  },

  addFiles: async () => {
    const paths = await window.lumilm.dialog.pickModelFiles()
    if (paths.length === 0) return
    await get().addPaths(paths)
  },

  addFolder: async () => {
    const directory = await window.lumilm.dialog.pickDirectory()
    if (!directory) return
    const models = await window.lumilm.models.addDirectory(directory)
    set({ models })
    useSettingsStore.getState().load().catch(() => undefined)
  },

  addPaths: async (paths) => {
    if (paths.length === 0) return
    const locale = useSettingsStore.getState().settings?.general.locale ?? 'zh-CN'
    const models = await window.lumilm.models.addPaths(paths)
    set({ models })
    useSettingsStore.getState().load().catch(() => undefined)
    useUiStore.getState().pushToast({
      kind: 'success',
      message: translate(locale, 'toast.modelAdded', { count: paths.length })
    })
  },

  remove: async (id) => {
    await window.lumilm.models.remove(id)
    set({ models: await window.lumilm.models.list() })
    useSettingsStore.getState().load().catch(() => undefined)
  },

  refresh: async () => {
    set({ loading: true })
    try {
      const models = await window.lumilm.models.refresh()
      set({ models })
    } finally {
      set({ loading: false })
    }
  },

  suggest: async () => {
    const suggestion = await window.lumilm.models.suggest()
    set({ suggestion })
  },

  recommend: async (id, preset, backend) => window.lumilm.models.recommend(id, preset, backend),

  activeModel: () => {
    const activeId = useSettingsStore.getState().settings?.models.activeModelId
    if (!activeId) return null
    return get().models.find((model) => model.id === activeId) ?? null
  }
}))
