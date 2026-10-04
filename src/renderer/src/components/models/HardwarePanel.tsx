import type { ReactNode } from 'react'
import { Cpu, HardDrive, MemoryStick, RefreshCw, Zap } from 'lucide-react'
import { Badge, Button, EmptyHint } from '@/components/ui'
import { formatBytes, formatGigabytes } from '@/lib/format'
import { useT } from '@/i18n'
import { useModelsStore } from '@/stores/models'

function Row({ icon, label, value }: { icon: ReactNode; label: string; value: string }): ReactNode {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="text-fg-subtle">{icon}</span>
      <span className="text-fg-muted">{label}</span>
      <span className="ml-auto max-w-[60%] truncate text-right font-medium text-fg" title={value}>
        {value}
      </span>
    </div>
  )
}

export function HardwarePanel(): ReactNode {
  const t = useT()
  const hardware = useModelsStore((state) => state.hardware)
  const loading = useModelsStore((state) => state.hardwareLoading)
  const detect = useModelsStore((state) => state.detectHardware)

  if (!hardware) {
    return <EmptyHint>{loading ? t('common.loading') : t('hardware.title')}</EmptyHint>
  }

  return (
    <section className="flex flex-col gap-2 rounded-[12px] border border-border bg-surface-2 p-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-fg">{t('hardware.title')}</span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          loading={loading}
          onClick={() => void detect(true)}
        >
          <RefreshCw className="size-3.5" />
          {t('hardware.rescan')}
        </Button>
      </div>

      <Row
        icon={<Cpu className="size-3.5" />}
        label={t('hardware.cpu')}
        value={`${hardware.cpuModel} (${hardware.physicalCores}C/${hardware.logicalCores}T)`}
      />
      <Row
        icon={<MemoryStick className="size-3.5" />}
        label={t('hardware.ram')}
        value={`${formatBytes(hardware.freeRamBytes, 1)} ${t('hardware.free')} / ${formatBytes(hardware.totalRamBytes, 1)}`}
      />

      {hardware.gpus.length === 0 ? (
        <Row icon={<Zap className="size-3.5" />} label={t('hardware.gpu')} value={t('hardware.noGpu')} />
      ) : (
        hardware.gpus.map((gpu) => (
          <Row
            key={gpu.index}
            icon={<Zap className="size-3.5" />}
            label={t('hardware.vram')}
            value={`${gpu.name} · ${formatGigabytes(gpu.vramBytes)}`}
          />
        ))
      )}

      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {hardware.backends.map((backend) => (
          <span key={backend.kind} title={backend.error ?? (backend.devices.join(', ') || undefined)}>
            <Badge tone={backend.available ? 'success' : backend.present ? 'warning' : 'neutral'}>
              <HardDrive className="size-3" />
              {backend.kind.toUpperCase()}
              {' · '}
              {backend.available
                ? t('hardware.available')
                : backend.present
                  ? t('hardware.unavailable')
                  : t('hardware.missing')}
            </Badge>
          </span>
        ))}
      </div>
    </section>
  )
}
