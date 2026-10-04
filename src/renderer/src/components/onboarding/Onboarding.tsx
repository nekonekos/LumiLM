import { useEffect, useState, type ReactNode } from 'react'
import { Check, Cpu, Sparkles, Zap } from 'lucide-react'
import { Badge, Button, Dialog } from '@/components/ui'
import { formatBytes, formatGigabytes } from '@/lib/format'
import { useT } from '@/i18n'
import { useModelsStore } from '@/stores/models'
import { useSettingsStore } from '@/stores/settings'

/**
 * First-run wizard. It only helps the user point LumiLM at models that already
 * exist on disk — nothing is ever downloaded.
 */
export function Onboarding({ onDone }: { onDone: () => void }): ReactNode {
  const t = useT()
  const models = useModelsStore((state) => state.models)
  const hardware = useModelsStore((state) => state.hardware)
  const suggestion = useModelsStore((state) => state.suggestion)
  const suggest = useModelsStore((state) => state.suggest)
  const addPaths = useModelsStore((state) => state.addPaths)
  const update = useSettingsStore((state) => state.update)

  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)

  const candidates = suggestion?.candidates ?? []

  useEffect(() => {
    if (step === 1) void suggest()
  }, [step, suggest])

  const adopt = async (): Promise<void> => {
    if (candidates.length === 0) return
    setBusy(true)
    try {
      await addPaths(candidates.map((candidate) => candidate.modelPath))
      const added = useModelsStore.getState().models
      if (added[0]) await update({ models: { activeModelId: added[0].id } })
    } finally {
      setBusy(false)
      onDone()
    }
  }

  const gpu = hardware?.gpus.find((item) => (item.vramBytes ?? 0) > 0) ?? null

  return (
    <Dialog
      open
      onClose={onDone}
      title={t('onboard.title')}
      description={t('onboard.subtitle')}
      width="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onDone}>
            {t('onboard.skip')}
          </Button>
          {step === 0 ? (
            <Button variant="primary" onClick={() => setStep(1)}>
              {t('common.confirm')}
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setStep(0)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                loading={busy}
                disabled={candidates.length === 0}
                onClick={() => void adopt()}
              >
                <Check className="size-3.5" />
                {t('onboard.finish')}
              </Button>
            </>
          )}
        </>
      }
    >
      {step === 0 ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-fg">{t('onboard.step1')}</span>
            <p className="text-[11px] leading-relaxed text-fg-muted">{t('onboard.step1Body')}</p>
          </div>

          <div className="flex flex-col gap-2 rounded-[12px] border border-border bg-surface-2 p-3 text-[11px]">
            <div className="flex items-center gap-2">
              <Cpu className="size-3.5 text-fg-subtle" />
              <span className="truncate text-fg-muted">{hardware?.cpuModel ?? '—'}</span>
              <span className="ml-auto shrink-0 text-fg-subtle">
                {hardware ? `${hardware.physicalCores}C / ${hardware.logicalCores}T` : ''}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Sparkles className="size-3.5 text-fg-subtle" />
              <span className="text-fg-muted">{t('hardware.ram')}</span>
              <span className="ml-auto shrink-0 text-fg-subtle">
                {formatBytes(hardware?.totalRamBytes ?? null, 1)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Zap className="size-3.5 text-fg-subtle" />
              <span className="truncate text-fg-muted">{gpu?.name ?? t('hardware.noGpu')}</span>
              <span className="ml-auto shrink-0 text-fg-subtle">
                {gpu ? formatGigabytes(gpu.vramBytes) : ''}
              </span>
            </div>

            <div className="mt-1 flex flex-wrap gap-1.5">
              {(hardware?.backends ?? []).map((backend) => (
                <Badge
                  key={backend.kind}
                  tone={backend.available ? 'success' : backend.present ? 'warning' : 'neutral'}
                >
                  {backend.kind.toUpperCase()}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-fg">{t('onboard.step2')}</span>
            <p className="text-[11px] leading-relaxed text-fg-muted">{t('onboard.step2Body')}</p>
          </div>

          {models.length > 0 ? (
            <p className="rounded-[10px] border border-border bg-surface-2 px-3 py-2 text-[11px] text-fg-muted">
              {t('models.detected')}: {models.length}
            </p>
          ) : candidates.length === 0 ? (
            <p className="rounded-[10px] border border-border bg-surface-2 px-3 py-2 text-[11px] text-fg-muted">
              {t('onboard.noModelFound')}
            </p>
          ) : (
            <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
              {candidates.map((candidate) => (
                <li
                  key={candidate.modelPath}
                  className="flex items-center gap-2 rounded-[9px] border border-border bg-surface-2 px-2 py-1.5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] font-medium text-fg">
                      {candidate.modelPath.split(/[\\/]/).pop()}
                    </span>
                    <span className="block truncate text-[10px] text-fg-subtle">
                      {candidate.modelPath}
                    </span>
                  </span>
                  <Badge tone="neutral">{formatBytes(candidate.sizeBytes, 1)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  )
}
