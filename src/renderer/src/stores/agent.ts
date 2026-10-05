import { create } from 'zustand'
import type { AgentPermission, ApprovalDecision, ChatMode, ToolCall, ToolRisk } from '@shared/types'
import { useChatStore } from './chat'
import { useSettingsStore } from './settings'

export interface PendingApproval {
  callId: string
  call: ToolCall
  risk: ToolRisk
  reason: string
}

interface AgentState {
  /** the approval the dialog is currently showing, if any */
  approval: PendingApproval | null
  /** approvals decided this turn, keyed by call id, so cards can show the outcome */
  decisions: Record<string, ApprovalDecision>

  requestApproval: (approval: PendingApproval) => void
  resolveApproval: (callId: string, decision: ApprovalDecision) => void
  decide: (decision: ApprovalDecision) => Promise<void>

  mode: () => ChatMode
  permission: () => AgentPermission
  setMode: (mode: ChatMode) => Promise<void>
  setPermission: (permission: AgentPermission) => Promise<void>
  setEnabledSkillIds: (ids: string[]) => Promise<void>
  toggleSkill: (id: string) => Promise<void>
  setInjectPrompt: (enabled: boolean) => Promise<void>
}

export const useAgentStore = create<AgentState>((set, get) => ({
  approval: null,
  decisions: {},

  requestApproval: (approval) => set({ approval }),

  resolveApproval: (callId, decision) =>
    set((state) => ({
      approval: state.approval?.callId === callId ? null : state.approval,
      decisions: { ...state.decisions, [callId]: decision }
    })),

  decide: async (decision) => {
    const approval = get().approval
    const stream = useChatStore.getState().stream
    if (!approval || !stream) return

    set((state) => ({
      approval: null,
      decisions: { ...state.decisions, [approval.callId]: decision }
    }))
    await window.lumilm.chat.approveToolCall(stream.streamId, approval.callId, decision)
  },

  mode: () => useChatStore.getState().conversation?.mode ?? 'chat',

  permission: () =>
    useChatStore.getState().conversation?.agent.permission ??
    useSettingsStore.getState().settings?.agent.permission ??
    'ask-risky',

  setMode: async (mode) => {
    const chat = useChatStore.getState()
    const conversation = chat.conversation
    if (!conversation) return
    await chat.saveCurrent({ mode })
    if (mode === 'chat') set({ approval: null, decisions: {} })
  },

  setPermission: async (permission) => {
    const chat = useChatStore.getState()
    const conversation = chat.conversation
    if (!conversation) return
    await chat.saveCurrent({ agent: { ...conversation.agent, permission } })
  },

  setEnabledSkillIds: async (ids) => {
    const chat = useChatStore.getState()
    const conversation = chat.conversation
    if (!conversation) return
    await chat.saveCurrent({ agent: { ...conversation.agent, enabledSkillIds: ids } })
  },

  toggleSkill: async (id) => {
    const chat = useChatStore.getState()
    const conversation = chat.conversation
    if (!conversation) return
    const current = conversation.agent.enabledSkillIds ?? []
    const next = current.includes(id)
      ? current.filter((entry) => entry !== id)
      : [...current, id]
    await chat.saveCurrent({ agent: { ...conversation.agent, enabledSkillIds: next } })
  },

  setInjectPrompt: async (enabled) => {
    const chat = useChatStore.getState()
    const conversation = chat.conversation
    if (!conversation) return
    await chat.saveCurrent({ agent: { ...conversation.agent, injectPrompt: enabled } })
  }
}))
