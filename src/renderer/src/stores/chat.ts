import { create } from 'zustand'
import type {
  Attachment,
  ChatMessage,
  ChatRequest,
  ChatRequestMessage,
  ChatStreamEvent,
  Conversation,
  ConversationMeta,
  MessageStats,
  ServerState
} from '@shared/types'
import { createInitialServerState } from '@/lib/server-state'
import { translate, type MessageKey } from '@/i18n'
import { useModelsStore } from './models'
import { useSettingsStore } from './settings'
import { useUiStore } from './ui'

export interface StreamState {
  streamId: string
  messageId: string
  content: string
  reasoning: string
  startedAt: number
  ttftMs: number | null
}

interface ChatState {
  metas: ConversationMeta[]
  conversation: Conversation | null
  stream: StreamState | null
  serverState: ServerState
  loading: boolean
  lastTrimmed: number

  loadMetas: () => Promise<void>
  loadServerState: () => Promise<void>
  setServerState: (state: ServerState) => void
  open: (id: string) => Promise<void>
  create: () => Promise<Conversation>
  remove: (id: string) => Promise<void>
  duplicate: (id: string) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  togglePin: (id: string) => Promise<void>
  exportConversation: (id: string, format: 'md' | 'json') => Promise<void>
  importConversation: () => Promise<void>
  saveCurrent: (patch?: Partial<Conversation>) => Promise<void>
  send: (text: string, attachments: Attachment[]) => Promise<void>
  editMessage: (messageId: string, content: string) => Promise<void>
  deleteMessage: (messageId: string) => Promise<void>
  regenerate: (messageId: string) => Promise<void>
  abort: () => Promise<void>
  handleStreamEvent: (event: ChatStreamEvent) => void
  ensureLoaded: () => Promise<{ ok: boolean; message?: string }>
}

const ERROR_CODES: MessageKey[] = [
  'error.NO_MODELS',
  'error.MODEL_MISSING',
  'error.BACKEND_MISSING',
  'error.SERVER_BUSY',
  'error.SERVER_NOT_READY'
]

function translateErrorCode(locale: 'zh-CN' | 'en-US', message: string): string {
  const key = ERROR_CODES.find((candidate) => candidate.slice('error.'.length) === message)
  return key ? translate(locale, key) : message
}

let counter = 0
function nextId(prefix: string): string {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter}`
}

/** Rough token estimate: CJK glyphs count as one token, latin as about 1/3.6. */
export function estimateTokens(text: string): number {
  let wide = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code !== undefined && code > 0x2e80) wide += 1
  }
  return Math.ceil(wide + (text.length - wide) / 3.6)
}

/**
 * Keeps the newest messages that fit inside the context window, leaving
 * headroom for the response. Always keeps at least the latest message.
 */
export function trimMessages(
  messages: ChatMessage[],
  systemPrompt: string,
  contextSize: number | null
): { kept: ChatMessage[]; trimmed: number } {
  if (!contextSize || contextSize <= 512) return { kept: messages, trimmed: 0 }

  const budget = Math.floor(contextSize * 0.82)
  let used = estimateTokens(systemPrompt) + 64
  const kept: ChatMessage[] = []

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) continue
    const cost = estimateTokens(message.content) + 8
    if (used + cost > budget && kept.length > 0) break
    used += cost
    kept.unshift(message)
  }

  return { kept, trimmed: messages.length - kept.length }
}

function buildRequestMessages(
  conversation: Conversation,
  contextSize: number | null
): { messages: ChatRequestMessage[]; trimmed: number; imageCount: number } {
  const { kept, trimmed } = trimMessages(conversation.messages, conversation.systemPrompt, contextSize)
  let imageCount = 0

  const messages: ChatRequestMessage[] = kept
    .filter((message) => message.role !== 'system')
    .map((message) => {
      const images = (message.attachments ?? [])
        .filter((attachment) => attachment.kind === 'image')
        .map((attachment) => attachment.path)
      imageCount += images.length
      return {
        role: message.role,
        content: message.content,
        ...(images.length > 0 ? { images } : {})
      }
    })

  return { messages, trimmed, imageCount }
}

let pendingContent = ''
let pendingReasoning = ''
let flushTimer: number | null = null

export const useChatStore = create<ChatState>((set, get) => {
  function flush(): void {
    flushTimer = null
    const content = pendingContent
    const reasoning = pendingReasoning
    pendingContent = ''
    pendingReasoning = ''
    if (!content && !reasoning) return

    set((state) => {
      if (!state.stream) return state
      return {
        stream: {
          ...state.stream,
          content: state.stream.content + content,
          reasoning: state.stream.reasoning + reasoning
        }
      }
    })
  }

  function scheduleFlush(): void {
    if (flushTimer !== null) return
    flushTimer = window.setTimeout(flush, 50)
  }

  function resetPending(): void {
    if (flushTimer !== null) {
      window.clearTimeout(flushTimer)
      flushTimer = null
    }
    pendingContent = ''
    pendingReasoning = ''
  }

  async function persist(conversation: Conversation): Promise<void> {
    await window.lumilm.conversations.save(conversation)
    set({ metas: await window.lumilm.conversations.list() })
  }

  /** Drops the empty assistant placeholder used when generation never started. */
  async function discardPlaceholder(messageId: string): Promise<void> {
    resetPending()
    const conversation = get().conversation
    if (!conversation) {
      set({ stream: null })
      return
    }
    const next: Conversation = {
      ...conversation,
      messages: conversation.messages.filter((message) => message.id !== messageId)
    }
    set({ conversation: next, stream: null })
    await persist(next)
  }

  async function finalize(
    stats: MessageStats | undefined,
    stopped: boolean,
    errorMessage?: string
  ): Promise<void> {
    flush()

    const { stream, conversation } = get()
    if (!stream || !conversation) {
      set({ stream: null })
      return
    }

    const messages = conversation.messages.map((message) =>
      message.id === stream.messageId
        ? {
            ...message,
            content: stream.content,
            reasoning: stream.reasoning.length > 0 ? stream.reasoning : undefined,
            stats,
            stopped: stopped || undefined,
            error: errorMessage ?? null,
            updatedAt: Date.now()
          }
        : message
    )

    const next: Conversation = { ...conversation, messages }
    set({ conversation: next, stream: null })
    await persist(next)
  }

  async function startStream(conversation: Conversation, assistantId: string): Promise<void> {
    const locale = useSettingsStore.getState().settings?.general.locale ?? 'zh-CN'

    const readiness = await get().ensureLoaded()
    if (!readiness.ok) {
      useUiStore.getState().pushToast({
        kind: 'warning',
        message: readiness.message ?? translate(locale, 'toast.noModelSelected')
      })
      await discardPlaceholder(assistantId)
      return
    }

    const model = useModelsStore.getState().activeModel()
    const contextSize = get().serverState.contextSize
    const { messages, trimmed, imageCount } = buildRequestMessages(conversation, contextSize)

    if (imageCount > 0 && model && !model.mmprojPath) {
      useUiStore.getState().pushToast({
        kind: 'warning',
        message: translate(locale, 'chat.imageUnsupported')
      })
    }

    const streamId = nextId('stream')
    set({ lastTrimmed: trimmed })
    resetPending()
    set({
      stream: {
        streamId,
        messageId: assistantId,
        content: '',
        reasoning: '',
        startedAt: Date.now(),
        ttftMs: null
      }
    })

    const request: ChatRequest = {
      streamId,
      conversationId: conversation.id,
      modelId: conversation.modelId,
      systemPrompt: conversation.systemPrompt,
      messages,
      sampling: conversation.sampling
    }

    try {
      await window.lumilm.chat.send(request)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void finalize(undefined, false, translateErrorCode(locale, message))
    }
  }

  return {
    metas: [],
    conversation: null,
    stream: null,
    serverState: createInitialServerState(),
    loading: false,
    lastTrimmed: 0,

    loadMetas: async () => {
      set({ metas: await window.lumilm.conversations.list() })
    },

    loadServerState: async () => {
      set({ serverState: await window.lumilm.server.state() })
    },

    setServerState: (serverState) => set({ serverState }),

    open: async (id) => {
      set({ loading: true })
      try {
        const conversation = await window.lumilm.conversations.get(id)
        set({ conversation, stream: null, lastTrimmed: 0 })
      } finally {
        set({ loading: false })
      }
    },

    create: async () => {
      const model = useModelsStore.getState().activeModel()
      const conversation = await window.lumilm.conversations.create({ modelId: model?.id ?? null })
      set({ conversation, metas: await window.lumilm.conversations.list(), stream: null })
      return conversation
    },

    remove: async (id) => {
      await window.lumilm.conversations.remove(id)
      const metas = await window.lumilm.conversations.list()
      const current = get().conversation
      set({ metas, conversation: current?.id === id ? null : current })
    },

    duplicate: async (id) => {
      const copy = await window.lumilm.conversations.duplicate(id)
      await get().loadMetas()
      if (copy) set({ conversation: copy })
    },

    rename: async (id, title) => {
      const conversation = await window.lumilm.conversations.get(id)
      if (!conversation) return
      await window.lumilm.conversations.save({ ...conversation, title, updatedAt: Date.now() })
      const current = get().conversation
      if (current?.id === id) set({ conversation: { ...current, title } })
      await get().loadMetas()
    },

    togglePin: async (id) => {
      const conversation = await window.lumilm.conversations.get(id)
      if (!conversation) return
      await window.lumilm.conversations.save({
        ...conversation,
        pinned: !conversation.pinned,
        updatedAt: Date.now()
      })
      const current = get().conversation
      if (current?.id === id) set({ conversation: { ...current, pinned: !current.pinned } })
      await get().loadMetas()
    },

    exportConversation: async (id, format) => {
      const locale = useSettingsStore.getState().settings?.general.locale ?? 'zh-CN'
      const path = await window.lumilm.conversations.exportToFile(id, format)
      if (path) {
        useUiStore.getState().pushToast({
          kind: 'success',
          message: translate(locale, 'toast.exported', { path })
        })
      }
    },

    importConversation: async () => {
      const locale = useSettingsStore.getState().settings?.general.locale ?? 'zh-CN'
      const imported = await window.lumilm.conversations.importFromFile()
      if (!imported) return
      set({ metas: await window.lumilm.conversations.list(), conversation: imported })
      useUiStore.getState().pushToast({ kind: 'success', message: translate(locale, 'toast.imported') })
    },

    saveCurrent: async (patch) => {
      const conversation = get().conversation
      if (!conversation) return
      const next: Conversation = { ...conversation, ...(patch ?? {}) }
      set({ conversation: next })
      await persist(next)
    },

    send: async (text, attachments) => {
      if (get().stream) return
      const trimmedText = text.trim()
      if (trimmedText.length === 0 && attachments.length === 0) return

      let conversation = get().conversation
      if (!conversation) conversation = await get().create()

      const model = useModelsStore.getState().activeModel()
      const userMessage: ChatMessage = {
        id: nextId('user'),
        role: 'user',
        content: trimmedText,
        createdAt: Date.now(),
        ...(attachments.length > 0 ? { attachments } : {})
      }
      const assistantMessage: ChatMessage = {
        id: nextId('assistant'),
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        modelId: model?.id ?? undefined
      }

      const next: Conversation = {
        ...conversation,
        modelId: model?.id ?? conversation.modelId,
        messages: [...conversation.messages, userMessage, assistantMessage]
      }

      set({ conversation: next })
      await persist(next)
      await startStream(next, assistantMessage.id)
    },

    editMessage: async (messageId, content) => {
      if (get().stream) return
      const conversation = get().conversation
      if (!conversation) return

      const index = conversation.messages.findIndex((message) => message.id === messageId)
      const target = index >= 0 ? conversation.messages[index] : undefined
      if (!target) return

      const assistantMessage: ChatMessage = {
        id: nextId('assistant'),
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        modelId: conversation.modelId ?? undefined
      }

      const next: Conversation = {
        ...conversation,
        messages: [
          ...conversation.messages.slice(0, index),
          { ...target, content, updatedAt: Date.now() },
          assistantMessage
        ]
      }

      set({ conversation: next })
      await persist(next)
      await startStream(next, assistantMessage.id)
    },

    deleteMessage: async (messageId) => {
      const conversation = get().conversation
      if (!conversation) return
      const next: Conversation = {
        ...conversation,
        messages: conversation.messages.filter((message) => message.id !== messageId)
      }
      set({ conversation: next })
      await persist(next)
    },

    regenerate: async (messageId) => {
      if (get().stream) return
      const conversation = get().conversation
      if (!conversation) return

      const index = conversation.messages.findIndex((message) => message.id === messageId)
      if (index < 0) return

      const assistantMessage: ChatMessage = {
        id: nextId('assistant'),
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        modelId: conversation.modelId ?? undefined
      }

      const next: Conversation = {
        ...conversation,
        messages: [...conversation.messages.slice(0, index), assistantMessage]
      }

      set({ conversation: next })
      await persist(next)
      await startStream(next, assistantMessage.id)
    },

    abort: async () => {
      const stream = get().stream
      if (!stream) return
      await window.lumilm.chat.abort(stream.streamId)
    },

    handleStreamEvent: (event) => {
      const stream = get().stream
      if (!stream || stream.streamId !== event.streamId) return

      switch (event.type) {
        case 'delta':
          if (event.content) pendingContent += event.content
          if (event.reasoning) pendingReasoning += event.reasoning
          if (pendingContent || pendingReasoning) scheduleFlush()
          break

        case 'metrics':
          if (typeof event.metrics.ttftMs === 'number') {
            set({ stream: { ...stream, ttftMs: event.metrics.ttftMs } })
          }
          break

        case 'done':
          void finalize(event.stats, false)
          break

        case 'aborted':
          void finalize(undefined, true)
          break

        case 'error': {
          const locale = useSettingsStore.getState().settings?.general.locale ?? 'zh-CN'
          void finalize(undefined, false, translateErrorCode(locale, event.message))
          break
        }

        case 'start':
        default:
          break
      }
    },

    ensureLoaded: async () => {
      const model = useModelsStore.getState().activeModel()
      if (!model) return { ok: false }

      const server = get().serverState
      if (server.status === 'ready' && server.modelId === model.id) return { ok: true }

      try {
        await window.lumilm.server.load({ modelId: model.id })
        return { ok: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const locale = useSettingsStore.getState().settings?.general.locale ?? 'zh-CN'
        return { ok: false, message: translateErrorCode(locale, message) }
      }
    }
  }
})
