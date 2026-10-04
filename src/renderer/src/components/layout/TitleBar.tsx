import type { ReactNode } from 'react'
import { Moon, PanelLeft, PanelRight, ScrollText, Settings as SettingsIcon, Sun } from 'lucide-react'
import { IconButton, Spinner } from '@/components/ui'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { formatSpeed } from '@/lib/format'
import { useResolvedTheme } from '@/hooks/useResolvedTheme'
import { useChatStore } from '@/stores/chat'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

function StatusPill({
  label,
  value,
  tone
}: {
  label: string
  value: string
  tone?: 'brand' | 'success' | 'warning' | 'danger'
}): ReactNode {
  const tones = {
    brand: 'text-brand border-transparent bg-brand-soft',
    success: 'text-success border-border bg-surface-3',
    warning: 'text-warning border-border bg-surface-3',
    danger: 'text-danger border-border bg-surface-3'
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[11px] whitespace-nowrap',
        tone ? tones[tone] : 'border-border bg-surface-3 text-fg-muted'
      )}
    >
      <span className="opacity-70">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </span>
  )
}

export function TitleBar(): ReactNode {
  const t = useT()
  const update = useSettingsStore((state) => state.update)
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed)
  const inspectorCollapsed = useUiStore((state) => state.inspectorCollapsed)
  const toggleSidebar = useUiStore((state) => state.toggleSidebar)
  const toggleInspector = useUiStore((state) => state.toggleInspector)
  const openSettings = useUiStore((state) => state.openSettings)
  const setLogsOpen = useUiStore((state) => state.setLogsOpen)
  const serverState = useChatStore((state) => state.serverState)
  const resolvedTheme = useResolvedTheme()

  const toggleTheme = (): void => {
    void update({ general: { themeMode: resolvedTheme === 'dark' ? 'light' : 'dark' } })
  }

  const busy = serverState.status === 'loading' || serverState.status === 'starting'

  const statusLabel = busy
    ? `${t('status.loading')}${serverState.progress ? ` ${Math.round(serverState.progress * 100)}%` : ''}`
    : serverState.status === 'error'
      ? t('status.error')
      : serverState.status === 'stopping'
        ? t('status.stopping')
        : t('status.idle')

  return (
    <header className="lm-titlebar lm-drag flex shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
      <IconButton
        label={t('titlebar.toggleSidebar')}
        onClick={toggleSidebar}
        active={!sidebarCollapsed}
        className="lm-no-drag"
      >
        <PanelLeft className="size-4" />
      </IconButton>

      <div className="flex shrink-0 items-center gap-2 pl-1">
        <span className="grid size-6 place-items-center rounded-[8px] bg-linear-to-br from-[#8fd0ff] to-[#2b6ce8] text-[11px] font-bold text-white">
          L
        </span>
        <span className="text-[13px] font-semibold tracking-tight text-fg">LumiLM</span>
      </div>

      <div className="ml-2 flex min-w-0 items-center gap-1.5 overflow-hidden">
        {serverState.status === 'ready' ? (
          <>
            <StatusPill
              label={t('status.backend')}
              value={serverState.backend?.toUpperCase() ?? '—'}
              tone="brand"
            />
            <StatusPill
              label={t('status.layers')}
              value={`${serverState.gpuLayers ?? 0}/${serverState.totalLayers ?? 0}`}
            />
            <StatusPill label={t('status.context')} value={String(serverState.contextSize ?? '—')} />
            <StatusPill
              label={t('status.speed')}
              value={formatSpeed(serverState.metrics?.tokensPerSecond ?? null)}
              tone="success"
            />
          </>
        ) : (
          <span className="flex items-center gap-1.5 text-[11px] text-fg-muted">
            {busy ? <Spinner className="size-3" /> : null}
            <span className={cn(serverState.status === 'error' && 'text-danger')}>{statusLabel}</span>
          </span>
        )}
      </div>

      <div className="flex-1" />

      <div className="lm-no-drag flex shrink-0 items-center gap-1">
        <IconButton label={t('titlebar.logs')} onClick={() => setLogsOpen(true)}>
          <ScrollText className="size-4" />
        </IconButton>
        <IconButton label={t('titlebar.theme')} onClick={toggleTheme}>
          {resolvedTheme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </IconButton>
        <IconButton
          label={t('titlebar.toggleInspector')}
          onClick={toggleInspector}
          active={!inspectorCollapsed}
        >
          <PanelRight className="size-4" />
        </IconButton>
        <IconButton label={t('titlebar.settings')} onClick={() => openSettings()}>
          <SettingsIcon className="size-4" />
        </IconButton>
      </div>

      {/* Space reserved for the native window-control overlay on Windows. */}
      <div className="w-[132px] shrink-0" aria-hidden />
    </header>
  )
}
