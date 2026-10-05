import { useState, type ReactNode } from 'react'
import { Download, Pencil, Plus, RotateCw, Trash2 } from 'lucide-react'
import type { McpServerConfig, McpTransportKind } from '@shared/types'
import {
  Badge,
  Button,
  Dialog,
  Field,
  SectionTitle,
  Select,
  Switch,
  TextArea,
  TextInput
} from '@/components/ui'
import { useT } from '@/i18n'
import { useMcpStore } from '@/stores/mcp'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

const EMPTY: McpServerConfig = {
  id: '',
  name: '',
  transport: 'stdio',
  command: '',
  args: [],
  env: {},
  cwd: null,
  url: null,
  headers: {},
  enabled: true,
  autoConnect: true,
  toolAllowlist: [],
  toolDenylist: [],
  trusted: false
}

function toLines(record: Record<string, string>): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

function fromLines(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    result[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim()
  }
  return result
}

function toList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function ServerEditor({
  initial,
  onCancel,
  onSave
}: {
  initial: McpServerConfig
  onCancel: () => void
  onSave: (config: McpServerConfig) => Promise<void>
}): ReactNode {
  const t = useT()
  const [draft, setDraft] = useState<McpServerConfig>(initial)
  const [argsText, setArgsText] = useState(initial.args.join(' '))
  const [envText, setEnvText] = useState(toLines(initial.env))
  const [allowText, setAllowText] = useState(initial.toolAllowlist.join(', '))
  const [denyText, setDenyText] = useState(initial.toolDenylist.join(', '))
  const [acknowledged, setAcknowledged] = useState(initial.trusted)
  const [saving, setSaving] = useState(false)

  const patch = (value: Partial<McpServerConfig>): void => setDraft((c) => ({ ...c, ...value }))
  const isStdio = draft.transport === 'stdio'
  const valid =
    draft.name.trim().length > 0 &&
    acknowledged &&
    (isStdio ? draft.command.trim().length > 0 : (draft.url ?? '').trim().length > 0)

  const submit = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave({
        ...draft,
        id: draft.id || draft.name,
        args: toList(argsText.replace(/\s+/g, ',')),
        env: fromLines(envText),
        toolAllowlist: toList(allowText),
        toolDenylist: toList(denyText),
        trusted: true
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      title={initial.id ? t('mcp.editServer') : t('mcp.addServer')}
      onClose={onCancel}
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={saving} disabled={!valid} onClick={() => void submit()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="rounded-[8px] bg-warning/10 px-2.5 py-2 text-[11px] leading-snug text-warning">
          {t('mcp.trustWarning')}
        </p>

        <Field label={t('mcp.name')}>
          <TextInput
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </Field>

        <Field label={t('mcp.transport')}>
          <Select<McpTransportKind>
            value={draft.transport}
            onChange={(value) => patch({ transport: value })}
            options={[
              { value: 'stdio', label: 'stdio' },
              { value: 'http', label: 'http' },
              { value: 'sse', label: 'sse' }
            ]}
          />
        </Field>

        {isStdio ? (
          <>
            <Field label={t('mcp.command')}>
              <TextInput
                value={draft.command}
                placeholder="npx"
                onChange={(event) => patch({ command: event.target.value })}
              />
            </Field>
            <Field label={t('mcp.args')}>
              <TextInput
                value={argsText}
                placeholder="-y @modelcontextprotocol/server-filesystem D:/work"
                onChange={(event) => setArgsText(event.target.value)}
              />
            </Field>
            <Field label={t('mcp.cwd')}>
              <TextInput
                value={draft.cwd ?? ''}
                onChange={(event) => patch({ cwd: event.target.value || null })}
              />
            </Field>
          </>
        ) : (
          <Field label={t('mcp.url')}>
            <TextInput
              value={draft.url ?? ''}
              placeholder="https://example.com/mcp"
              onChange={(event) => patch({ url: event.target.value || null })}
            />
          </Field>
        )}

        <Field label={t('mcp.env')}>
          <TextArea
            rows={3}
            value={envText}
            placeholder="KEY=value"
            onChange={(event) => setEnvText(event.target.value)}
            className="font-mono text-[11px]"
          />
        </Field>

        <Field label={t('mcp.toolAllowlist')} hint={t('mcp.toolAllowlistHint')}>
          <TextInput value={allowText} onChange={(event) => setAllowText(event.target.value)} />
        </Field>

        <Field label={t('mcp.toolDenylist')}>
          <TextInput value={denyText} onChange={(event) => setDenyText(event.target.value)} />
        </Field>

        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-fg-muted">{t('mcp.enabled')}</span>
          <Switch
            checked={draft.enabled}
            label={t('mcp.enabled')}
            onChange={(checked) => patch({ enabled: checked })}
          />
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-fg-muted">{t('mcp.autoConnect')}</span>
          <Switch
            checked={draft.autoConnect}
            label={t('mcp.autoConnect')}
            onChange={(checked) => patch({ autoConnect: checked })}
          />
        </div>

        <label className="flex items-start gap-2 rounded-[8px] border border-border px-2.5 py-2">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            className="mt-0.5"
          />
          <span className="text-[11px] leading-snug text-fg-muted">{t('mcp.trustWarning')}</span>
        </label>
      </div>
    </Dialog>
  )
}

export function McpTab(): ReactNode {
  const t = useT()
  const { servers, configs, save, remove, connect, disconnect, restart, importConfig, refresh } =
    useMcpStore()
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  const pushToast = useUiStore((state) => state.pushToast)
  const [editing, setEditing] = useState<McpServerConfig | null>(null)

  if (!settings) return null
  const mcp = settings.mcp

  const runImport = async (): Promise<void> => {
    try {
      const imported = await importConfig()
      if (!imported || imported.length === 0) return
      for (const server of imported) await save(server)
      pushToast({ kind: 'warning', message: t('mcp.importWarning') })
      await refresh()
    } catch (error) {
      pushToast({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3">
        <SectionTitle>{t('mcp.title')}</SectionTitle>
        <p className="text-[11px] leading-snug text-fg-subtle">{t('mcp.subtitle')}</p>

        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-fg-muted">{t('settings.mcpAutoConnect')}</span>
          <Switch
            checked={mcp.autoConnect}
            label={t('settings.mcpAutoConnect')}
            onChange={(checked) => void update({ mcp: { autoConnect: checked } })}
          />
        </div>

        <Field label={t('settings.mcpCallTimeout')}>
          <TextInput
            type="number"
            min={1000}
            max={600000}
            value={mcp.callTimeoutMs}
            onChange={(event) =>
              void update({ mcp: { callTimeoutMs: Number(event.target.value) || 60000 } })
            }
          />
        </Field>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" onClick={() => setEditing({ ...EMPTY })}>
            <Plus className="size-3.5" />
            {t('mcp.addServer')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void runImport()}>
            <Download className="size-3.5" />
            {t('mcp.importConfig')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void window.lumilm.mcp.revealConfig()}>
            {t('mcp.revealConfig')}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        {servers.length === 0 ? (
          <p className="rounded-[8px] bg-surface-2 px-2.5 py-2 text-[11px] text-fg-subtle">
            {t('mcp.empty')}
          </p>
        ) : null}

        {servers.map((server) => (
          <div
            key={server.id}
            className="flex items-center gap-2 rounded-[9px] border border-border px-2.5 py-2"
          >
            <span
              className={
                server.status === 'ready'
                  ? 'size-1.5 shrink-0 rounded-full bg-success'
                  : server.status === 'error'
                    ? 'size-1.5 shrink-0 rounded-full bg-danger'
                    : 'size-1.5 shrink-0 rounded-full bg-fg-subtle'
              }
            />
            <span className="min-w-0 flex-1 truncate text-[11px] text-fg">
              {server.serverName ?? server.id}
            </span>
            <Badge tone="neutral">
              {server.toolCount} {t('mcp.tools')}
            </Badge>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void (server.status === 'ready' ? disconnect(server.id) : connect(server.id))}
            >
              {t(server.status === 'ready' ? 'mcp.disconnect' : 'mcp.connect')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void restart(server.id)}>
              <RotateCw className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              title={t('mcp.editServer')}
              onClick={() => {
                const config = configs.find((entry) => entry.id === server.id)
                if (config) setEditing(config)
              }}
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button size="sm" variant="ghost" title={t('common.delete')} onClick={() => void remove(server.id)}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </section>

      {editing ? (
        <ServerEditor
          initial={editing}
          onCancel={() => setEditing(null)}
          onSave={async (config) => {
            await save(config)
            setEditing(null)
          }}
        />
      ) : null}
    </div>
  )
}
