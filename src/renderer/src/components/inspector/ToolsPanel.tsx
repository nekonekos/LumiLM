import { useEffect, type ReactNode } from 'react'
import { Plug, RefreshCw, RotateCw, Unplug } from 'lucide-react'
import type { McpServerState, ToolPermission } from '@shared/types'
import { Badge, Button, EmptyHint, IconButton } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useT, type MessageKey } from '@/i18n'
import { useMcpStore } from '@/stores/mcp'
import { useSettingsStore } from '@/stores/settings'

const STATUS_LABEL: Record<McpServerState['status'], MessageKey> = {
  disconnected: 'mcp.statusDisconnected',
  connecting: 'mcp.statusConnecting',
  ready: 'mcp.statusReady',
  error: 'mcp.statusError'
}

const STATUS_TONE: Record<McpServerState['status'], 'neutral' | 'brand' | 'success' | 'danger'> = {
  disconnected: 'neutral',
  connecting: 'brand',
  ready: 'success',
  error: 'danger'
}

/** Connected MCP servers plus the tools they expose. */
export function ToolsPanel(): ReactNode {
  const t = useT()
  const { servers, tools, runtime, refresh, connect, disconnect, restart } = useMcpStore()
  const settings = useSettingsStore((state) => state.settings)
  const permissions = settings?.mcp.toolPermissions ?? {}

  useEffect(() => {
    void refresh()
  }, [refresh])

  const setToolPermission = async (
    serverId: string,
    toolName: string,
    value: ToolPermission
  ): Promise<void> => {
    await window.lumilm.settings.update({
      mcp: { toolPermissions: { [`${serverId}::${toolName}`]: value } }
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5">
        <span className="flex-1 text-[10px] text-fg-subtle">
          {t('mcp.runtime')}: {runtime?.nodeVersion ?? '—'}
          {runtime?.npxPath ? '' : ` · ${t('mcp.runtimeNpxMissing')}`}
        </span>
        <IconButton label={t('common.refresh')} className="size-6" onClick={() => void refresh()}>
          <RefreshCw className="size-3" />
        </IconButton>
      </div>

      {servers.length === 0 ? (
        <EmptyHint>{t('mcp.empty')}</EmptyHint>
      ) : (
        <div className="flex flex-col gap-2">
          {servers.map((server) => {
            const serverTools = tools.filter((tool) => tool.serverId === server.id)
            return (
              <div key={server.id} className="overflow-hidden rounded-[9px] border border-border">
                <div className="flex items-center gap-2 bg-surface-2 px-2.5 py-1.5">
                  <span
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      server.status === 'ready'
                        ? 'bg-success'
                        : server.status === 'error'
                          ? 'bg-danger'
                          : 'bg-fg-subtle'
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-fg">
                    {server.serverName ?? server.id}
                  </span>
                  <Badge tone={STATUS_TONE[server.status]}>{t(STATUS_LABEL[server.status])}</Badge>
                  {server.status === 'ready' ? (
                    <IconButton
                      label={t('mcp.disconnect')}
                      className="size-6"
                      onClick={() => void disconnect(server.id)}
                    >
                      <Unplug className="size-3" />
                    </IconButton>
                  ) : (
                    <IconButton
                      label={t('mcp.connect')}
                      className="size-6"
                      onClick={() => void connect(server.id)}
                    >
                      <Plug className="size-3" />
                    </IconButton>
                  )}
                  <IconButton
                    label={t('mcp.restart')}
                    className="size-6"
                    onClick={() => void restart(server.id)}
                  >
                    <RotateCw className="size-3" />
                  </IconButton>
                </div>

                {server.error ? (
                  <p className="border-t border-border px-2.5 py-1.5 text-[10px] leading-snug text-danger">
                    {server.errorCode === 'RUNTIME_MISSING'
                      ? t('mcp.errorRuntimeMissing')
                      : server.errorCode === 'REMOTE_DISABLED'
                        ? t('mcp.errorRemoteDisabled')
                        : server.error}
                  </p>
                ) : null}

                {serverTools.length === 0 ? (
                  <p className="border-t border-border px-2.5 py-1.5 text-[10px] text-fg-subtle">
                    {t('mcp.noTools')}
                  </p>
                ) : (
                  <div className="max-h-64 overflow-y-auto border-t border-border">
                    {serverTools.map((tool) => {
                      const current = permissions[`${server.id}::${tool.toolName}`] ?? null
                      return (
                        <div
                          key={tool.toolName}
                          className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-1 last:border-b-0"
                        >
                          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-fg-muted">
                            {tool.toolName}
                          </span>
                          <span
                            className={
                              tool.risk === 'destructive'
                                ? 'shrink-0 text-[9px] text-warning'
                                : 'shrink-0 text-[9px] text-fg-subtle'
                            }
                          >
                            {t(tool.risk === 'destructive' ? 'agent.riskDestructive' : 'agent.riskReadOnly')}
                          </span>
                          <div className="flex shrink-0 items-center gap-0.5">
                            {(
                              [
                                ['allow', 'mcp.alwaysAllow'],
                                ['ask', 'mcp.alwaysAsk'],
                                ['deny', 'mcp.alwaysDeny']
                              ] as const
                            ).map(([value, label]) => (
                              <button
                                key={value}
                                type="button"
                                title={t(label)}
                                onClick={() =>
                                  void setToolPermission(server.id, tool.toolName, current === value ? 'ask' : value)
                                }
                                className={cn(
                                  'rounded-[4px] px-1 py-0.5 text-[9px] transition-colors',
                                  current === value
                                    ? 'bg-brand text-brand-fg'
                                    : 'bg-surface-3 text-fg-subtle hover:text-fg'
                                )}
                              >
                                {t(label)}
                              </button>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <Button variant="ghost" size="sm" onClick={() => void window.lumilm.mcp.revealConfig()}>
        {t('mcp.revealConfig')}
      </Button>
    </div>
  )
}
