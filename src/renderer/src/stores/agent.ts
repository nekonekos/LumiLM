import { create } from 'zustand'
import type { AgentPermission, AgentThinking, ChatMode } from '@shared/types'
import { useChatStore } from './chat'
import { useSettingsStore } from './settings'

interface AgentState {
  /** Falls back to the configured default when no conversation is open. */
  mode: () => ChatMode
  permission: () => AgentPermission
  thinking: () => AgentThinking

  setMode: (mode: ChatMode) => Promise<void>
  setPermission: (permission: AgentPermission) => Promise<void>
  setThinking: (thinking: AgentThinking) => Promise<void>
  setEnabledSkillIds: (ids: string[]) => Promise<void>
  toggleSkill: (id: string) => Promise<void>
  setInjectPrompt: (enabled: boolean) => Promise<void>
}

/**
 * Mode, permission and thinking level for the open conversation. The live turn
 * itself lives in `agent-session`; keeping the two apart means changing a
 * setting never has to touch in-flight turn state.
 */
export const useAgentStore = create<AgentState>(() => ({
  mode: () =>
    useChatStore.getState().conversation?.mode ??
    useSettingsStore.getState().settings?.agent.defaultMode ??
    'chat',

  permission: () =>
    useChatStore.getState().conversation?.agent.permission ??
    useSettingsStore.getState().settings?.agent.permission ??
    'ask-risky',

  thinking: () =>
    useChatStore.getState().conversation?.agent.thinking ??
    useSettingsStore.getState().settings?.agent.thinking ??
    'unlimited',

  setMode: async (mode) => {
    const chat = useChatStore.getState()
    if (!chat.conversation) {
      // With nothing open the choice becomes the default for the next chat.
      await useSettingsStore.getState().update({ agent: { defaultMode: mode } })
      return
    }
    await chat.saveCurrent({ mode })
  },

  setPermission: async (permission) => {
    const chat = useChatStore.getState()
    if (!chat.conversation) {
      await useSettingsStore.getState().update({ agent: { permission } })
      return
    }
    await chat.saveCurrent({ agent: { ...chat.conversation.agent, permission } })
  },

  setThinking: async (thinking) => {
    const chat = useChatStore.getState()
    if (!chat.conversation) {
      await useSettingsStore.getState().update({ agent: { thinking } })
      return
    }
    await chat.saveCurrent({ agent: { ...chat.conversation.agent, thinking } })
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
    const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
    await chat.saveCurrent({ agent: { ...conversation.agent, enabledSkillIds: next } })
  },

  setInjectPrompt: async (enabled) => {
    const chat = useChatStore.getState()
    const conversation = chat.conversation
    if (!conversation) return
    await chat.saveCurrent({ agent: { ...conversation.agent, injectPrompt: enabled } })
  }
}))
