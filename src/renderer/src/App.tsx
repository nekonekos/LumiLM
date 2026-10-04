import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChatView } from '@/components/chat/ChatView'
import { Inspector } from '@/components/inspector/Inspector'
import { LogViewer } from '@/components/logs/LogViewer'
import { Onboarding } from '@/components/onboarding/Onboarding'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { Sidebar } from '@/components/layout/Sidebar'
import { StatusBar } from '@/components/layout/StatusBar'
import { TitleBar } from '@/components/layout/TitleBar'
import { ToastHost } from '@/components/layout/ToastHost'
import { Spinner } from '@/components/ui'
import { useBootstrap } from '@/hooks/useBootstrap'
import { useT } from '@/i18n'
import { useChatStore } from '@/stores/chat'
import { useModelsStore } from '@/stores/models'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

const ONBOARDED_KEY = 'lumilm.onboarded'

function readOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === '1'
  } catch {
    return false
  }
}

export function App(): ReactNode {
  const t = useT()
  const { loading, error } = useBootstrap()

  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed)
  const inspectorCollapsed = useUiStore((state) => state.inspectorCollapsed)
  const toggleSidebar = useUiStore((state) => state.toggleSidebar)
  const toggleInspector = useUiStore((state) => state.toggleInspector)
  const openSettings = useUiStore((state) => state.openSettings)
  const setLogsOpen = useUiStore((state) => state.setLogsOpen)

  const sidebarWidth = useSettingsStore((state) => state.settings?.ui.sidebarWidth ?? 268)
  const settingsReady = useSettingsStore((state) => state.settings !== null)

  const models = useModelsStore((state) => state.models)
  const modelCount = models.length

  const [onboarded, setOnboarded] = useState(readOnboarded)

  const showOnboarding = useMemo(
    () => !loading && !onboarded && modelCount === 0,
    [loading, onboarded, modelCount]
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      const key = event.key.toLowerCase()

      if (key === 'n') {
        event.preventDefault()
        void useChatStore.getState().create()
      } else if (key === 'b') {
        event.preventDefault()
        toggleSidebar()
      } else if (key === 'j') {
        event.preventDefault()
        toggleInspector()
      } else if (key === 'l') {
        event.preventDefault()
        setLogsOpen(true)
      } else if (key === ',') {
        event.preventDefault()
        openSettings()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [openSettings, setLogsOpen, toggleInspector, toggleSidebar])

  const dismissOnboarding = (): void => {
    try {
      localStorage.setItem(ONBOARDED_KEY, '1')
    } catch {
      /* ignore unavailable storage */
    }
    setOnboarded(true)
  }

  if (loading || !settingsReady) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg text-fg-muted">
        <span className="grid size-11 place-items-center rounded-[14px] bg-linear-to-br from-[#8fd0ff] to-[#2b6ce8] text-lg font-bold text-white">
          L
        </span>
        <span className="flex items-center gap-2 text-sm">
          <Spinner className="size-4" />
          {t('status.starting')}
        </span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-bg text-center">
        <p className="text-sm font-medium text-danger">{t('common.error')}</p>
        <p className="max-w-md text-xs text-fg-muted">{error}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <TitleBar />

      <div className="flex min-h-0 flex-1">
        {sidebarCollapsed ? null : (
          <div className="shrink-0" style={{ width: sidebarWidth }}>
            <Sidebar />
          </div>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          <ChatView />
        </main>

        {inspectorCollapsed ? null : <Inspector />}
      </div>

      <StatusBar />

      <ToastHost />
      <SettingsDialog />
      <LogViewer />
      {showOnboarding ? <Onboarding onDone={dismissOnboarding} /> : null}
    </div>
  )
}
