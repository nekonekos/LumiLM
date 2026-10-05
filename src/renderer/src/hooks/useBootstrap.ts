import { useEffect, useState } from 'react'
import { useAgentSession } from '@/stores/agent-session'
import { useChatStore } from '@/stores/chat'
import { useCompanionStore } from '@/stores/companion'
import { useMcpStore } from '@/stores/mcp'
import { useModelsStore } from '@/stores/models'
import { useSettingsStore } from '@/stores/settings'
import { useSkillsStore } from '@/stores/skills'
import { useUiStore } from '@/stores/ui'

export interface BootstrapState {
  /** true until settings, models and the initial server state have been read */
  loading: boolean
  /** set when the very first IPC round trip failed */
  error: string | null
}

/**
 * Loads everything the UI needs on start-up and keeps the renderer in sync with
 * main-process events. Runs exactly once, even under React StrictMode.
 */
export function useBootstrap(): BootstrapState {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const settings = useSettingsStore.getState()
    const models = useModelsStore.getState()
    const chat = useChatStore.getState()
    const ui = useUiStore.getState()

    const unsubscribe = [
      window.lumilm.events.onServerState((state) => chat.setServerState(state)),
      window.lumilm.events.onChatStream((event) => chat.handleStreamEvent(event)),
      window.lumilm.events.onAgentStream((event) =>
        useAgentSession.getState().handleEvent(event)
      ),
        // A companion turn streams on its own channel but lands in the same
        // transcript, so it shares the chat store's event handler.
        window.lumilm.events.onCompanionStream((event) => chat.handleStreamEvent(event)),
        window.lumilm.events.onMemoryChanged((overview) =>
          useCompanionStore.getState().apply(overview)
        ),
        window.lumilm.events.onHeartbeat((event) => useCompanionStore.getState().onHeartbeat(event)),
        window.lumilm.events.onSettingsChanged((next) => settings.applyFromEvent(next)),
      window.lumilm.events.onMcpStatus((servers) => {
        useMcpStore.getState().setServers(servers)
        // Tool availability changes with the connections, so re-read them.
        void useMcpStore.getState().refreshCapabilities()
      }),
      window.lumilm.events.onToast((toast) => ui.pushToast(toast)),
      window.lumilm.events.onServerLog((line) => {
        useUiStore.getState().appendLog(line)
      })
    ]

    let cancelled = false
    void (async () => {
      try {
        await settings.load()
        await Promise.all([
          models.load(),
          models.detectHardware(),
          chat.loadMetas(),
          chat.loadServerState(),
          useMcpStore.getState().refresh(),
          useSkillsStore.getState().refresh(),
          useCompanionStore.getState().load()
        ])
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      for (const off of unsubscribe) off()
    }
  }, [])

  return { loading, error }
}
