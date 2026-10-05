import { create } from 'zustand'
import type {
  AgentNoticeCode,
  ApprovalDecision,
  Attachment,
  ChatMessage,
  ChatRequest,
  ChatStreamEvent,
  MessageStats,
  ToolCall,
  ToolCallResult,
  ToolRisk
} from '@shared/types'
import { stripBudgetMessage } from '@/lib/agent-blocks'
import { translate, type MessageKey } from '@/i18n'
import { useChatStore, buildRequestMessages } from './chat'
import { useModelsStore } from './models'
import { useSettingsStore } from './settings'
import { useUiStore } from './ui'

export interface AgentStreamState {
  streamId: string
  /** id of the assistant message this block is being written into */
  blockId: string
  iteration: number
  content: string
  reasoning: string
  toolCalls: ToolCall[]
  startedAt: number
  ttftMs: number | null
}

export interface PendingApproval {
  callId: string
  call: ToolCall
  risk: ToolRisk
  reason: string
}

interface AgentSessionState {
  stream: AgentStreamState | null
  /** true while waiting for the model to finish loading */
  preparing: boolean
  /** tool results of the in-flight block, keyed by call id */
  results: Record<string, ToolCallResult>
  approvals: Record<string, PendingApproval>
  decisions: Record<string, ApprovalDecision>
  lastTrimmed: number

  send: (text: string, attachments: Attachment[]) => Promise<void>
  abort: () => Promise<void>
  approve: (callId: string, decision: ApprovalDecision) => Promise<void>
  handleEvent: (event: ChatStreamEvent) => void
  reset: () => void
}

const ERROR_CODES: MessageKey[] = [
  'error.NO_MODELS',
  'error.MODEL_MISSING',
  'error.BACKEND_MISSING',
  'error.SERVER_BUSY',
  'error.SERVER_NOT_READY'
]

const NOTICE_KEYS: Record<AgentNoticeCode, MessageKey> = {
  MAX_ITERATIONS: 'agent.noticeMaxIterations',
  CONTEXT_EXHAUSTED: 'agent.noticeContextExhausted',
  CONTEXT_TRIMMED: 'agent.noticeContextTrimmed',
  TOOLS_UNSUPPORTED: 'agent.noticeToolsUnsupported',
  TOOL_NOT_FOUND: 'agent.noticeToolNotFound'
}

function translateErrorCode(message: string): string {
  const locale = useSettingsStore.getState().settings?.general.locale ?? 'zh-CN'
  const key = ERROR_CODES.find((candidate) => candidate.slice('error.'.length) === message)
  return key ? translate(locale, key) : message
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let counter = 0
function nextId(prefix: string): string {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter}`
}

/**
 * Owns one agent turn: which iteration is running, what it asked the tools for,
 * and which approval is waiting on the user. Chat streaming is a different
 * shape (a single answer with no steps), so it has its own store.
 */
export const useAgentSession = create<AgentSessionState>((set, get) => {
  let pendingContent = ''
  let pendingReasoning = ''
  let flushTimer: number | null = null

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

  async function commit(messages: ChatMessage[]): Promise<void> {
    await useChatStore.getState().saveCurrent({ messages })
  }

  /** Writes the finished assistant block back into the transcript. */
  async function seal(
    blockId: string,
    data: Partial<ChatMessage>,
    stats?: MessageStats
  ): Promise<ChatMessage[] | null> {
    const conversation = useChatStore.getState().conversation
    if (!conversation) return null
    const cleaned: Partial<ChatMessage> = { ...data }
    if (typeof cleaned.reasoning === 'string') {
      const stripped = stripBudgetMessage(cleaned.reasoning)
      cleaned.reasoning = stripped.length > 0 ? stripped : undefined
    }
    const messages = conversation.messages.map((entry) =>
      entry.id === blockId
        ? { ...entry, ...cleaned, stats: stats ?? entry.stats, updatedAt: Date.now() }
        : entry
    )
    await commit(messages)
    return messages
  }

  async function finish(
    stats: MessageStats | undefined,
    stopped: boolean,
    errorMessage?: string
  ): Promise<void> {
    flush()
    const { stream } = get()
    if (!stream) return
    await seal(
      stream.blockId,
      {
        content: stream.content,
        reasoning: stream.reasoning.length > 0 ? stream.reasoning : undefined,
        toolCalls: stream.toolCalls.length > 0 ? stream.toolCalls : undefined,
        stopped: stopped || undefined,
        error: errorMessage ?? null
      },
      stats
    )
    resetPending()
    set({ stream: null, approvals: {} })
  }

  return {
    stream: null,
    preparing: false,
    results: {},
    approvals: {},
    decisions: {},
    lastTrimmed: 0,

    reset: () =>
      set({ stream: null, results: {}, approvals: {}, decisions: {}, lastTrimmed: 0 }),

    send: async (text, attachments) => {
      if (get().stream || get().preparing) return
      const prompt = text.trim()
      if (prompt.length === 0 && attachments.length === 0) return

      let conversation = useChatStore.getState().conversation
      if (!conversation) conversation = await useChatStore.getState().create()

      const model = useModelsStore.getState().activeModel()
      const userMessage: ChatMessage = {
        id: nextId('user'),
        role: 'user',
        content: prompt,
        createdAt: Date.now(),
        ...(attachments.length > 0 ? { attachments } : {})
      }
      const blockId = nextId('agent')
      const placeholder: ChatMessage = {
        id: blockId,
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        modelId: model?.id ?? undefined
      }

      const messages = [...conversation.messages, userMessage, placeholder]
      await useChatStore.getState().saveCurrent({
        messages,
        modelId: model?.id ?? conversation.modelId
      })

      set({ preparing: true })
      let readiness: { ok: boolean; message?: string }
      try {
        readiness = await useChatStore.getState().ensureLoaded(conversation.agent.thinking)
      } finally {
        set({ preparing: false })
      }

      if (!readiness.ok) {
        useUiStore.getState().pushToast({
          kind: 'warning',
          message:
            readiness.message ??
            translate(useSettingsStore.getState().settings?.general.locale ?? 'zh-CN', 'toast.noModelSelected')
        })
        await commit(messages.filter((entry) => entry.id !== blockId))
        return
      }

      resetPending()
      const streamId = nextId('agent-stream')
      set({
        results: {},
        approvals: {},
        decisions: {},
        stream: {
          streamId,
          blockId,
          iteration: 0,
          content: '',
          reasoning: '',
          toolCalls: [],
          startedAt: Date.now(),
          ttftMs: null
        }
      })

      const request: ChatRequest = {
        streamId,
        conversationId: conversation.id,
        modelId: conversation.modelId,
        systemPrompt: conversation.systemPrompt,
        // The whole history goes over untouched; the main process owns the real
        // budget and is the only side that can trim tool rounds without
        // breaking their call/result pairing.
        messages: buildRequestMessages(useChatStore.getState().conversation ?? conversation, null)
          .messages,
        sampling: conversation.sampling,
        mode: 'agent',
        agent: conversation.agent
      }

      try {
        await window.lumilm.agent.send(request)
      } catch (error) {
        void finish(undefined, false, translateErrorCode(message(error)))
      }
    },

    abort: async () => {
      const stream = get().stream
      if (!stream) return
      await window.lumilm.agent.abort(stream.streamId)
    },

    approve: async (callId, decision) => {
      const stream = get().stream
      const approval = get().approvals[callId]
      if (!stream || !approval) return
      set((state) => {
        const approvals = { ...state.approvals }
        delete approvals[callId]
        return { approvals, decisions: { ...state.decisions, [callId]: decision } }
      })
      await window.lumilm.agent.approveToolCall(stream.streamId, callId, decision)
    },

    handleEvent: (event) => {
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

        case 'iteration': {
          if (event.index === 0) break
          flush()
          const current = get().stream
          if (!current) break

          // Seal the finished block, then open a new one for the next step.
          void seal(current.blockId, {
            content: current.content,
            reasoning: current.reasoning.length > 0 ? current.reasoning : undefined,
            toolCalls: current.toolCalls.length > 0 ? current.toolCalls : undefined
          }).then((messages) => {
            if (!messages) return
            const nextBlock: ChatMessage = {
              id: nextId('agent'),
              role: 'assistant',
              content: '',
              createdAt: Date.now(),
              modelId: useModelsStore.getState().activeModel()?.id ?? undefined
            }
            void commit([...messages, nextBlock])
            resetPending()
            set({
              stream: {
                ...current,
                blockId: nextBlock.id,
                iteration: event.index,
                content: '',
                reasoning: '',
                toolCalls: []
              }
            })
          })
          break
        }

        case 'tool-call': {
          const current = get().stream
          if (!current) break
          set({ stream: { ...current, toolCalls: [...current.toolCalls, event.call] } })
          break
        }

        case 'content-reset': {
          // The model wrote an invented result after its tool call; drop it from
          // the block so the transcript only ever holds real output.
          pendingContent = ''
          const current = get().stream
          if (!current) break
          set({ stream: { ...current, content: event.content } })
          break
        }

        case 'tool-result': {
          set((state) => ({ results: { ...state.results, [event.callId]: event.result } }))
          const conversation = useChatStore.getState().conversation
          if (!conversation) break
          const toolMessage: ChatMessage = {
            id: nextId('tool'),
            role: 'tool',
            content: event.result.content,
            toolCallId: event.callId,
            createdAt: Date.now(),
            toolResult: event.result
          }
          // The tool message has to sit in the transcript as it happens, so the
          // call/result pairing survives a reload in the middle of a turn.
          void commit([...conversation.messages, toolMessage])
          break
        }

        case 'approval-request':
          set((state) => ({
            approvals: {
              ...state.approvals,
              [event.call.id]: {
                callId: event.call.id,
                call: event.call,
                risk: event.risk,
                reason: event.reason
              }
            }
          }))
          break

        case 'approval-resolved':
          set((state) => {
            const approvals = { ...state.approvals }
            delete approvals[event.callId]
            return { approvals, decisions: { ...state.decisions, [event.callId]: event.decision } }
          })
          break

        case 'notice': {
          const locale = useSettingsStore.getState().settings?.general.locale ?? 'zh-CN'
          useUiStore.getState().pushToast({
            kind: event.code === 'CONTEXT_EXHAUSTED' ? 'warning' : 'info',
            message: translate(locale, NOTICE_KEYS[event.code])
          })
          break
        }

        case 'done':
          void finish(event.stats, false)
          break

        case 'aborted':
          void finish(undefined, true)
          break

        case 'error':
          void finish(undefined, false, translateErrorCode(event.message))
          break

        case 'start':
          break
      }
    }
  }
})
