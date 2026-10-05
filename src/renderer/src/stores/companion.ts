import { create } from 'zustand'
import type {
  CompanionOverview,
  CompanionStatus,
  HeartbeatEvent,
  MemoryStats,
  PersonaCard,
  RelationshipState
} from '@shared/types'
import { translate } from '@/i18n'
import { useChatStore } from './chat'
import { useSettingsStore } from './settings'
import { useUiStore } from './ui'

interface CompanionState {
  status: CompanionStatus | null
  stats: MemoryStats | null
  cards: PersonaCard[]
  /** when the overview was last read, so relative times stay stable in render */
  loadedAt: number
  loading: boolean
  /** true while a heartbeat greeting is being generated */
  speaking: boolean
  /** the newest greeting the renderer has not shown yet */
  latest: HeartbeatEvent | null

  load: () => Promise<void>
  apply: (overview: CompanionOverview) => void
  updateRelationship: (patch: Partial<RelationshipState>) => Promise<void>
  setHeartbeatEnabled: (enabled: boolean) => Promise<void>
  snooze: (minutes: number) => Promise<void>
  speakNow: () => Promise<boolean>
  dreamNow: () => Promise<void>
  saveCard: (card: PersonaCard) => Promise<void>
  removeCard: (id: string) => Promise<void>
  importCard: () => Promise<PersonaCard | null>
  exportCard: (id: string) => Promise<void>
  restoreBuiltin: () => Promise<void>
  selectCard: (id: string) => Promise<void>
  onHeartbeat: (event: HeartbeatEvent) => void
  dismissLatest: () => void
  /** Opens the companion conversation, creating one the first time. */
  openConversation: () => Promise<void>
}

/**
 * Everything about the companion that is not the transcript: the resolved card,
 * the relationship, the heartbeat state and the persona cards.
 *
 * The conversation itself lives in the chat store, because a companion turn is
 * still a user/assistant pair with the same persistence and streaming rules.
 */
export const useCompanionStore = create<CompanionState>((set, get) => ({
  status: null,
  stats: null,
  cards: [],
  loadedAt: 0,
  loading: false,
  speaking: false,
  latest: null,

  load: async () => {
    set({ loading: true })
    try {
      const overview = await window.lumilm.companion.overview()
      get().apply(overview)
    } finally {
      set({ loading: false })
    }
  },

  apply: (overview) =>
    set({ status: overview.status, stats: overview.stats, cards: overview.cards, loadedAt: Date.now() }),

  updateRelationship: async (patch) => {
    get().apply(await window.lumilm.companion.updateRelationship(patch))
  },

  setHeartbeatEnabled: async (enabled) => {
    get().apply(await window.lumilm.companion.setHeartbeat({ enabled }))
  },

  snooze: async (minutes) => {
    get().apply(await window.lumilm.companion.setHeartbeat({ snoozeMinutes: minutes }))
  },

  speakNow: async () => {
    set({ speaking: true })
    try {
      return await window.lumilm.companion.heartbeatTest()
    } catch {
      return false
    } finally {
      set({ speaking: false })
    }
  },

  dreamNow: async () => {
    set({ speaking: true })
    try {
      get().apply(await window.lumilm.companion.dreamNow())
    } finally {
      set({ speaking: false })
    }
  },

  saveCard: async (card) => {
    const cards = await window.lumilm.personas.save(card)
    set({ cards })
    useUiStore.getState().pushToast({ kind: 'success', message: '角色卡已保存' })
  },

  removeCard: async (id) => {
    set({ cards: await window.lumilm.personas.remove(id) })
  },

  importCard: async () => {
    const card = await window.lumilm.personas.importFromFile()
    if (card) set({ cards: await window.lumilm.personas.list() })
    return card
  },

  exportCard: async (id) => {
    await window.lumilm.personas.exportToFile(id)
  },

  restoreBuiltin: async () => {
    set({ cards: await window.lumilm.personas.restoreBuiltin() })
  },

  selectCard: async (id) => {
    await useSettingsStore.getState().update({ companion: { characterCardId: id } })
    await get().load()
  },

  onHeartbeat: (event) => {
    set({ latest: event })
    void useChatStore.getState().loadMetas()
    // Pull the greeting into the open conversation so it appears without a reload.
    const current = useChatStore.getState().conversation
    if (current?.id === event.conversationId) {
      void useChatStore.getState().open(event.conversationId)
    }
  },

  dismissLatest: () => set({ latest: null }),

  openConversation: async () => {
    const chat = useChatStore.getState()
    const metas = chat.metas
    const existing = metas.find((meta) => meta.mode === 'companion' && !meta.archived)
    if (existing) {
      await chat.open(existing.id)
      return
    }
    useUiStore.getState().pushToast({
      kind: 'info',
      message: translate(
        useSettingsStore.getState().settings?.general.locale ?? 'zh-CN',
        'companion.lockNotice'
      )
    })
    await chat.createCompanion()
  }
}))
