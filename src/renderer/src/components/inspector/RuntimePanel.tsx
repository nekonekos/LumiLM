import { useEffect, useState, type ReactNode } from 'react'
import { Gauge, RefreshCw, Rocket } from 'lucide-react'
import type {
  BackendKind,
  KvCacheType,
  PerfPreset,
  RecommendedParams
} from '@shared/types'
import { Badge, Button, Field, SectionTitle, Select, Switch, TextArea, TextInput } from '@/components/ui'
import { formatBytes, formatGigabytes } from '@/lib/format'
import { useT, useDynamicT } from '@/i18n'
import { useChatStore } from '@/stores/chat'
import { useModelsStore } from '@/stores/models'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

type TriState = 'auto' | 'on' | 'off'

function toTri(value: boolean | 'auto'): TriState {
  return value === 'auto' ? 'auto' : value ? 'on' : 'off'
}

function fromTri(value: TriState, fallback: boolean): boolean | 'auto' {
  if (value === 'auto') return 'auto'
  return value === 'on' ? true : value === 'off' ? false : fallback
}

export function RuntimePanel(): ReactNode {
  const t = useT()
  const tKey = useDynamicT()
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  const pushToast = useUiStore((state) => state.pushToast)

  const models = useModelsStore((state) => state.models)
  const recommend = useModelsStore((state) => state.recommend)
  const loadServerState = useChatStore((state) => state.loadServerState)
  const serverState = useChatStore((state) => state.serverState)

  const [advice, setAdvice] = useState<{ modelId: string; params: RecommendedParams } | null>(null)
  const [applying, setApplying] = useState(false)

  const inference = settings?.inference
  const activeModelId = settings?.models.activeModelId ?? null
  const model = models.find((item) => item.id === activeModelId) ?? null

  useEffect(() => {
    if (!activeModelId) return
    let cancelled = false
    void recommend(activeModelId).then((result) => {
      if (!cancelled && result) setAdvice({ modelId: activeModelId, params: result })
    })
    return () => {
      cancelled = true
    }
  }, [activeModelId, recommend])

  const recommendation = advice && advice.modelId === activeModelId ? advice.params : null

  if (!settings || !inference) return null

  const patch = (next: Partial<typeof inference>): void => {
    void update({ inference: next })
  }

  const autoNum = (value: number | 'auto'): string => (value === 'auto' ? 'auto' : String(value))

  const setAutoNum = (
    raw: string,
    key: 'gpuLayers' | 'contextSize' | 'threads' | 'batchSize'
  ): void => {
    const trimmed = raw.trim().toLowerCase()
    if (trimmed === 'auto' || trimmed === '') {
      patch({ [key]: 'auto' } as Partial<typeof inference>)
      return
    }
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed) && parsed >= 0) {
      patch({ [key]: Math.round(parsed) } as Partial<typeof inference>)
    }
  }

  const applyToServer = (): void => {
    setApplying(true)
    void window.lumilm.server
      .load({ modelId: activeModelId ?? undefined })
      .catch(() => undefined)
      .then(() => loadServerState())
      .finally(() => setApplying(false))
  }

  const adoptAdvice = (): void => {
    if (!recommendation) return
    void update({
      inference: {
        gpuLayers: recommendation.gpuLayers,
        contextSize: recommendation.contextSize,
        kvCacheType: recommendation.kvCacheType,
        threads: recommendation.threads,
        batchSize: recommendation.batchSize,
        flashAttention: recommendation.flashAttention,
        useMmap: recommendation.useMmap,
        useMlock: recommendation.useMlock
      }
    }).then(() => pushToast({ kind: 'success', message: t('models.applyRecommended') }))
  }

  const fitsTone = recommendation?.fitsFullyInVram
    ? 'success'
    : recommendation?.gpuLayers
      ? 'warning'
      : 'danger'
  const fitsLabel = recommendation?.fitsFullyInVram
    ? t('params.fits')
    : recommendation?.gpuLayers
      ? t('params.partial')
      : t('params.cpuOnly')

  return (
    <div className="flex flex-col gap-6">
      {recommendation ? (
        <section className="flex flex-col gap-2 rounded-[12px] border border-border bg-surface-2 p-3">
          <div className="flex items-center gap-2">
            <Gauge className="size-3.5 text-brand" />
            <span className="text-xs font-semibold text-fg">{t('models.recommended')}</span>
            <span className="flex-1" />
            <Badge tone={fitsTone}>{fitsLabel}</Badge>
          </div>

          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-fg-muted">
            <span>
              {t('params.gpuLayers')}:{' '}
              <b className="text-fg">
                {recommendation.gpuLayers}/{recommendation.totalLayers}
              </b>
            </span>
            <span>
              {t('params.contextSize')}: <b className="text-fg">{recommendation.contextSize}</b>
            </span>
            <span>
              {t('params.kvCache')}: <b className="text-fg">{recommendation.kvCacheType}</b>
            </span>
            <span>
              {t('params.estimatedVram')}:{' '}
              <b className="text-fg">{formatGigabytes(recommendation.estimatedVramBytes)}</b>
            </span>
            <span>
              {t('params.estimatedRam')}:{' '}
              <b className="text-fg">{formatBytes(recommendation.estimatedRamBytes, 1)}</b>
            </span>
          </div>

          {recommendation.notes.length > 0 ? (
            <ul className="flex flex-col gap-0.5 text-[11px] leading-snug text-fg-subtle">
              {recommendation.notes.map((note) => (
                <li key={note}>· {tKey(note)}</li>
              ))}
            </ul>
          ) : null}

          <div className="flex items-center gap-2">
            <Button size="sm" variant="soft" className="flex-1 justify-center" onClick={adoptAdvice}>
              <RefreshCw className="size-3.5" />
              {t('models.applyRecommended')}
            </Button>
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <SectionTitle>{t('params.runtime')}</SectionTitle>

        <Field label={t('params.perfPreset')}>
          <Select<PerfPreset>
            value={inference.perfPreset}
            onChange={(value) => patch({ perfPreset: value })}
            options={[
              { value: 'low-vram', label: t('presets.lowVram') },
              { value: 'balanced', label: t('presets.balanced') },
              { value: 'performance', label: t('presets.performance') }
            ]}
          />
        </Field>

        <Field label={t('params.backend')}>
          <Select<BackendKind>
            value={inference.backend}
            onChange={(value) => patch({ backend: value })}
            options={[
              { value: 'auto', label: t('common.auto') },
              { value: 'cpu', label: 'CPU' },
              { value: 'vulkan', label: 'Vulkan' },
              { value: 'cuda', label: 'CUDA' }
            ]}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('params.gpuLayers')}>
            <TextInput
              value={autoNum(inference.gpuLayers)}
              placeholder={t('common.auto')}
              onChange={(event) => setAutoNum(event.target.value, 'gpuLayers')}
            />
          </Field>
          <Field label={t('params.contextSize')}>
            <TextInput
              value={autoNum(inference.contextSize)}
              placeholder={t('common.auto')}
              onChange={(event) => setAutoNum(event.target.value, 'contextSize')}
            />
          </Field>
          <Field label={t('params.kvCache')}>
            <Select<KvCacheType | 'auto'>
              value={inference.kvCacheType}
              onChange={(value) => patch({ kvCacheType: value })}
              options={[
                { value: 'auto', label: t('common.auto') },
                { value: 'f16', label: 'f16' },
                { value: 'q8_0', label: 'q8_0' },
                { value: 'q4_0', label: 'q4_0' }
              ]}
            />
          </Field>
          <Field label={t('params.threads')}>
            <TextInput
              value={autoNum(inference.threads)}
              placeholder={t('common.auto')}
              onChange={(event) => setAutoNum(event.target.value, 'threads')}
            />
          </Field>
          <Field label={t('params.batchSize')}>
            <TextInput
              value={autoNum(inference.batchSize)}
              placeholder={t('common.auto')}
              onChange={(event) => setAutoNum(event.target.value, 'batchSize')}
            />
          </Field>
          <Field label={t('params.flashAttention')}>
            <Select<TriState>
              value={toTri(inference.flashAttention)}
              onChange={(value) =>
                patch({ flashAttention: fromTri(value, inference.flashAttention === true) })
              }
              options={[
                { value: 'auto', label: t('common.auto') },
                { value: 'on', label: t('common.enabled') },
                { value: 'off', label: t('common.disabled') }
              ]}
            />
          </Field>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>{t('params.advanced')}</SectionTitle>

        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-fg-muted">{t('params.mmap')}</span>
          <Switch
            label={t('params.mmap')}
            checked={inference.useMmap}
            onChange={(checked) => patch({ useMmap: checked })}
          />
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-fg-muted">{t('params.mlock')}</span>
          <Switch
            label={t('params.mlock')}
            checked={inference.useMlock}
            onChange={(checked) => patch({ useMlock: checked })}
          />
        </div>

        <Field label={`${t('params.vramReserve')} (MiB)`}>
          <TextInput
            type="number"
            min={0}
            max={8192}
            step={128}
            value={inference.vramReserveMb}
            onChange={(event) => patch({ vramReserveMb: Number(event.target.value) })}
          />
        </Field>

        <Field label={t('params.extraArgs')} hint={t('params.extraArgsHint')}>
          <TextArea
            rows={2}
            value={inference.extraArgs}
            onChange={(event) => patch({ extraArgs: event.target.value })}
            placeholder="--no-context-shift"
          />
        </Field>
      </section>

      <Button
        variant="primary"
        className="justify-center"
        loading={applying}
        disabled={!model}
        onClick={applyToServer}
      >
        <Rocket className="size-4" />
        {applying ? t('params.applying') : t('params.applyToServer')}
      </Button>

      {serverState.commandLine ? (
        <details className="rounded-[10px] border border-border bg-surface-2 p-2 text-[11px]">
          <summary className="cursor-pointer font-medium text-fg-muted">{t('logs.title')}</summary>
          <code className="mt-1.5 block break-all font-mono text-[10px] text-fg-subtle">
            {serverState.commandLine}
          </code>
        </details>
      ) : null}
    </div>
  )
}
