import { create } from 'zustand'
import type { MemoryEpisode, MemoryFact, MemoryHit, MemoryQuery, MemoryStats } from '@shared/types'
import { useUiStore } from './ui'

interface MemoryState {
  facts: MemoryFact[]
  episodes: MemoryEpisode[]
  stats: MemoryStats | null
  /** when the lists were last read, so "just learned" is stable during a render */
  loadedAt: number
  /** the recall the next turn would inject, shown in the inspector */
  preview: MemoryHit[]
  previewQuery: string
  query: MemoryQuery
  selectedId: string | null
  loading: boolean

  load: () => Promise<void>
  refreshStats: () => Promise<void>
  setQuery: (patch: Partial<MemoryQuery>) => Promise<void>
  select: (id: string | null) => void
  update: (id: string, patch: Partial<MemoryFact>) => Promise<void>
  remove: (id: string) => Promise<void>
  removeMany: (ids: string[]) => Promise<void>
  approve: (ids: string[], accept: boolean) => Promise<void>
  forgetAll: () => Promise<void>
  exportToFile: () => Promise<void>
  importFromFile: () => Promise<void>
  runPreview: (text: string) => Promise<void>
}

/**
 * The memory library's data.
 *
 * Every mutation goes through the main process and comes back as the full list,
 * so what the user sees is always exactly what the extractor will recall — there
 * is no second, renderer-side copy that could drift.
 */
export const useMemoryStore = create<MemoryState>((set, get) => ({
  facts: [],
  episodes: [],
  stats: null,
  loadedAt: 0,
  preview: [],
  previewQuery: '',
  query: { includeArchived: false, includePending: true, sort: 'recent' },
  selectedId: null,
  loading: false,

  load: async () => {
    set({ loading: true })
    try {
      const query = get().query
      const [facts, episodes, stats] = await Promise.all([
        window.lumilm.memory.list({ ...query, includeArchived: true, includePending: true }),
        window.lumilm.memory.episodes(),
        window.lumilm.memory.stats()
      ])
      set({ facts, episodes, stats, loadedAt: Date.now() })
    } finally {
      set({ loading: false })
    }
  },

  refreshStats: async () => {
    set({ stats: await window.lumilm.memory.stats() })
  },

  setQuery: async (patch) => {
    set({ query: { ...get().query, ...patch } })
    await get().load()
  },

  select: (selectedId) => set({ selectedId }),

  update: async (id, patch) => {
    set({ facts: await window.lumilm.memory.update(id, patch) })
  },

  remove: async (id) => {
    set({ facts: await window.lumilm.memory.remove(id) })
    if (get().selectedId === id) set({ selectedId: null })
  },

  removeMany: async (ids) => {
    set({ facts: await window.lumilm.memory.removeMany(ids) })
    if (get().selectedId && ids.includes(get().selectedId as string)) set({ selectedId: null })
  },

  approve: async (ids, accept) => {
    set({ facts: await window.lumilm.memory.approve(ids, accept) })
  },

  forgetAll: async () => {
    await window.lumilm.memory.forgetAll()
    set({ facts: [], episodes: [], preview: [], selectedId: null })
    await get().refreshStats()
    useUiStore.getState().pushToast({ kind: 'success', message: '记忆已全部清空' })
  },

  exportToFile: async () => {
    const path = await window.lumilm.memory.exportToFile()
    if (path) useUiStore.getState().pushToast({ kind: 'success', message: `已导出到 ${path}` })
  },

  importFromFile: async () => {
    const facts = await window.lumilm.memory.importFromFile()
    if (!facts) return
    set({ facts })
    await get().refreshStats()
    useUiStore.getState().pushToast({ kind: 'success', message: '记忆已导入' })
  },

  runPreview: async (text) => {
    set({ previewQuery: text })
    set({ preview: await window.lumilm.memory.recall(text, 8) })
  }
}))

/** Visible facts after the library's filters, for the list view. */
export function visibleFacts(facts: MemoryFact[], query: MemoryQuery): MemoryFact[] {
  const needle = query.text?.trim().toLowerCase() ?? ''
  const filtered = facts.filter((fact) => {
    if (!query.includeArchived && fact.archived) return false
    if (query.includePending === false && fact.pending) return false
    if (query.pinnedOnly && !fact.pinned) return false
    if (query.minImportance !== undefined && fact.importance < query.minImportance) return false
    if (query.kinds && query.kinds.length > 0 && !query.kinds.includes(fact.kind)) return false
    if (query.subject && query.subject !== 'all' && fact.subject !== query.subject) return false
    if (needle.length > 0 && !fact.text.toLowerCase().includes(needle)) return false
    return true
  })

  const sort = query.sort ?? 'recent'
  return [...filtered].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (sort === 'importance') return b.importance - a.importance || b.updatedAt - a.updatedAt
    if (sort === 'used') return b.useCount - a.useCount || b.updatedAt - a.updatedAt
    return b.updatedAt - a.updatedAt
  })
}
