import type { ReactNode } from 'react'
import { Cpu, HardDrive, MemoryStick, Timer, Zap } from 'lucide-react'
import { useT } from '@/i18n'
import { formatBytes, formatDuration, formatGigabytes, formatSpeed } from '@/lib/format'
import { useChatStore } from '@/stores/chat'
import { useModelsStore } from '@/stores/models'

function Metric({
  icon,
  label,
  value
}: {
  icon: ReactNode
  label: string
  value: string
}): ReactNode {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap" title={label}>
      <span className="text-fg-subtle">{icon}</span>
      <span className="tabular-nums text-fg-muted">{value}</span>
    </span>
  )
}

export function StatusBar(): ReactNode {
  const t = useT()
  const serverState = useChatStore((state) => state.serverState)
  const lastTrimmed = useChatStore((state) => state.lastTrimmed)
  const models = useModelsStore((state) => state.models)

  const model = models.find((item) => item.id === serverState.modelId) ?? null
  const hardware = useModelsStore((state) => state.hardware)
  const metrics = serverState.metrics

  const contextUsed = metrics?.contextUsedTokens ?? null
  const contextSize = serverState.contextSize ?? null
  const usagePercent =
    contextUsed !== null && contextSize ? Math.min(100, Math.round((contextUsed / contextSize) * 100)) : 0

  const gpu = hardware?.gpus.find((item) => (item.vramBytes ?? 0) > 0) ?? null

  return (
    <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-border bg-surface px-3 text-[11px]">
      <span className="flex min-w-0 items-center gap-2">
        <HardDrive className="size-3 shrink-0 text-fg-subtle" />
        <span className="truncate text-fg-muted">
          {serverState.modelName ?? model?.fileName ?? t('status.idle')}
        </span>
      </span>

      {contextSize ? (
        <span className="flex items-center gap-2 whitespace-nowrap">
          <span className="text-fg-subtle">{t('metrics.context')}</span>
          <span className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-3">
            <span
              className="block h-full rounded-full bg-brand transition-[width]"
              style={{ width: `${usagePercent}%` }}
            />
          </span>
          <span className="tabular-nums text-fg-muted">
            {contextUsed !== null ? `${contextUsed} / ${contextSize}` : `0 / ${contextSize}`}
          </span>
        </span>
      ) : null}

      {lastTrimmed > 0 ? (
        <span className="text-warning" title={t('chat.truncatedNotice')}>
          −{lastTrimmed}
        </span>
      ) : null}

      <span className="flex-1" />

      {gpu ? (
        <Metric
          icon={<Zap className="size-3" />}
          label={`${gpu.name} ${t('hardware.vram')}`}
          value={formatGigabytes(gpu.vramBytes)}
        />
      ) : null}

      {hardware ? (
        <>
          <Metric
            icon={<MemoryStick className="size-3" />}
            label={t('hardware.ram')}
            value={`${formatBytes(hardware.freeRamBytes, 1)} ${t('hardware.free')}`}
          />
          <Metric
            icon={<Cpu className="size-3" />}
            label={t('hardware.cores')}
            value={`${hardware.physicalCores}C/${hardware.logicalCores}T`}
          />
        </>
      ) : null}

      <Metric
        icon={<Timer className="size-3" />}
        label={t('metrics.firstToken')}
        value={formatDuration(metrics?.ttftMs ?? null)}
      />
      <Metric
        icon={<Zap className="size-3" />}
        label={t('metrics.tokensPerSecond')}
        value={formatSpeed(metrics?.tokensPerSecond ?? null)}
      />
    </footer>
  )
}
