import { useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  BadgeCheck,
  Eye,
  EyeOff,
  FolderOpen,
  Info,
  Play,
  Trash2
} from 'lucide-react'
import type { ModelInfo } from '@shared/types'
import { Badge, Button, IconButton } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatBytes, formatParameterCount } from '@/lib/format'
import { useT } from '@/i18n'
import { useChatStore } from '@/stores/chat'
import { useSettingsStore } from '@/stores/settings'

export function ModelCard({
  model,
  active,
  onRemove
}: {
  model: ModelInfo
  active: boolean
  onRemove: (model: ModelInfo) => void
}): ReactNode {
  const t = useT()
  const loadServerState = useChatStore((state) => state.loadServerState)
  const serverState = useChatStore((state) => state.serverState)
  const update = useSettingsStore((state) => state.update)
  const [loading, setLoading] = useState(false)

  const meta = model.metadata
  const loaded = serverState.modelId === model.id && serverState.status === 'ready'
  const busy = serverState.modelId === model.id && (serverState.status === 'loading' || serverState.status === 'starting')

  const activate = (): void => {
    void update({ models: { activeModelId: model.id } })
  }

  const load = (): void => {
    setLoading(true)
    void window.lumilm.server
      .load({ modelId: model.id })
      .catch(() => undefined)
      .then(() => loadServerState())
      .finally(() => setLoading(false))
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-[12px] border p-3 transition-colors',
        active ? 'border-brand bg-brand-soft/40' : 'border-border bg-surface-2 hover:border-border-strong'
      )}
    >
      <div className="flex items-start gap-2">
        <button type="button" onClick={activate} className="min-w-0 flex-1 text-left">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium text-fg" title={model.path}>
              {model.fileName}
            </span>
            {loaded ? <BadgeCheck className="size-3.5 shrink-0 text-success" /> : null}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-fg-subtle">
            <span className="tabular-nums">{formatBytes(model.sizeBytes, 1)}</span>
            {meta?.quantization ? <span>· {meta.quantization}</span> : null}
            {meta?.parameterCount ? <span>· {formatParameterCount(meta.parameterCount)}</span> : null}
            {meta?.contextLength ? <span>· ctx {meta.contextLength}</span> : null}
            {meta?.architecture ? <span>· {meta.architecture}</span> : null}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            label={t('models.revealInExplorer')}
            className="size-7"
            onClick={() => void window.lumilm.app.showItemInFolder(model.path)}
          >
            <FolderOpen className="size-3.5" />
          </IconButton>
          <IconButton
            label={t('models.remove')}
            className="size-7"
            onClick={() => onRemove(model)}
          >
            <Trash2 className="size-3.5" />
          </IconButton>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {active ? <Badge tone="brand">{t('models.active')}</Badge> : null}
        {model.mmprojPath ? (
          <Badge tone="success">
            <Eye className="size-3" />
            {t('models.vision')}
          </Badge>
        ) : (
          <Badge tone="neutral">
            <EyeOff className="size-3" />
            {t('models.noVision')}
          </Badge>
        )}
        {model.recommended ? (
          <Badge tone={model.recommended.fitsFullyInVram ? 'success' : 'warning'}>
            {model.recommended.gpuLayers}/{model.recommended.totalLayers}
          </Badge>
        ) : null}
        {model.metadataError ? (
          <Badge tone="danger">
            <AlertTriangle className="size-3" />
            {t('models.metadataError')}
          </Badge>
        ) : null}
        {model.mmprojMissing ? (
          <Badge tone="warning">
            <Info className="size-3" />
            {t('models.mmprojMissing')}
          </Badge>
        ) : null}
      </div>

      {meta?.chatTemplate ? (
        <details className="text-[11px] text-fg-subtle">
          <summary className="cursor-pointer select-none">{t('common.optional')}</summary>
          <pre className="mt-1 max-h-28 overflow-auto rounded-[8px] bg-surface p-2 font-mono text-[10px] leading-snug">
            {meta.chatTemplate.slice(0, 1200)}
          </pre>
        </details>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant={active ? 'primary' : 'secondary'}
          className="flex-1 justify-center"
          loading={loading || busy}
          onClick={load}
        >
          <Play className="size-3.5" />
          {busy ? t('models.loading') : t('models.load')}
        </Button>
        {!active ? (
          <Button size="sm" variant="ghost" className="justify-center" onClick={activate}>
            {t('models.select')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
