import { useEffect, type ReactNode } from 'react'
import { FolderOpen, Plug, RefreshCw, RotateCw, Unplug } from 'lucide-react'
import type { McpServerState, ToolPermission } from '@shared/types'
import { BUILTIN_TOOL_GROUPS } from '@shared/builtin-tools'
import { Badge, Button, EmptyHint, IconButton, Switch } from '@/components/ui'
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

/**
 * The built-in tools a user loads on demand. They are off by default, so the
 * group switches are what actually puts a tool in front of the model.
 */
function BuiltinToolsSection(): ReactNode {
  const t = useT()
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  if (!settings) return null

  const agent = settings.agent
  const groups = [
    agent.fileToolsEnabled ? BUILTIN_TOOL_GROUPS.file : [],
    agent.shellToolsEnabled ? BUILTIN_TOOL_GROUPS.shell : []
  ].flat()

  const pickRoot = async (): Promise<void> => {
    const directory = await window.lumilm.dialog.pickDirectory()
    if (directory) await update({ agent: { workspaceRoot: directory } })
  }

  return (
    <div className="overflow-hidden rounded-[9px] border border-border">
      <div className="flex items-center gap-2 bg-surface-2 px-2.5 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[11px] text-fg">{t('tools.builtin')}</span>
        <Badge tone={groups.length > 0 ? 'brand' : 'neutral'}>
          {t('tools.count', { n: groups.length })}
        </Badge>
      </div>

      <div className="flex flex-col gap-2 border-t border-border px-2.5 py-2">
        <div className="flex items-center gap-2">
          <Switch
            checked={agent.fileToolsEnabled}
            label={t('settings.agentFileTools')}
            onChange={(checked) => void update({ agent: { fileToolsEnabled: checked } })}
          />
          <span className="flex-1 text-[11px] text-fg">{t('settings.agentFileTools')}</span>
        </div>

        <div className="flex items-center gap-2">
          <Switch
            checked={agent.shellToolsEnabled}
            label={t('settings.agentShellTools')}
            onChange={(checked) => void update({ agent: { shellToolsEnabled: checked } })}
          />
          <span className="flex-1 text-[11px] text-fg">{t('settings.agentShellTools')}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-[10px] text-fg-subtle">
            {t('settings.agentWorkspaceRoot')}
          </span>
          <span
            className="min-w-0 flex-1 truncate font-mono text-[10px] text-fg-muted"
            title={agent.workspaceRoot ?? t('tools.homeDir')}
          >
            {agent.workspaceRoot ?? t('tools.homeDir')}
          </span>
          <IconButton label={t('tools.pickRoot')} className="size-6" onClick={() => void pickRoot()}>
            <FolderOpen className="size-3" />
          </IconButton>
        </div>

        {groups.length > 0 ? (
          <p className="break-all font-mono text-[10px] leading-snug text-fg-subtle">
            {groups.join(' · ')}
          </p>
        ) : (
          <p className="text-[10px] leading-snug text-warning">{t('tools.noneEnabled')}</p>
        )}

        {agent.shellToolsEnabled ? (
          <p className="text-[10px] leading-snug text-fg-subtle">{t('tools.shellWarn')}</p>
        ) : (
          <p className="text-[10px] leading-snug text-fg-subtle">{t('tools.builtinHint')}</p>
        )}
      </div>
    </div>
  )
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
      <BuiltinToolsSection />

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
