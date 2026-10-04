import type { ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'
import { DEFAULT_SAMPLING, type SamplingParams } from '@shared/types'
import { Button, Field, Slider, TextArea, TextInput } from '@/components/ui'
import { formatNumber } from '@/lib/format'
import { useT } from '@/i18n'
import { useChatStore } from '@/stores/chat'
import { useUiStore } from '@/stores/ui'

function NumberSlider({
  label,
  value,
  min,
  max,
  step,
  digits,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  digits: number
  onChange: (value: number) => void
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-fg-muted">{label}</span>
        <span className="shrink-0 rounded-[6px] bg-surface-3 px-1.5 py-0.5 text-[11px] tabular-nums text-fg">
          {formatNumber(value, digits)}
        </span>
      </div>
      <Slider value={value} min={min} max={max} step={step} onChange={onChange} />
    </div>
  )
}

/** Sampling controls. Every value is stored per conversation, never globally. */
export function SamplingPanel(): ReactNode {
  const t = useT()
  const conversation = useChatStore((state) => state.conversation)
  const saveCurrent = useChatStore((state) => state.saveCurrent)
  const pushToast = useUiStore((state) => state.pushToast)

  const sampling = conversation?.sampling ?? DEFAULT_SAMPLING

  const patch = (next: Partial<SamplingParams>): void => {
    if (!conversation) {
      pushToast({ kind: 'info', message: t('toast.noModelSelected') })
      return
    }
    void saveCurrent({ sampling: { ...sampling, ...next } })
  }

  const unlimited = sampling.maxTokens < 0
  const randomSeed = sampling.seed < 0

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-x-4 gap-y-4">
        <NumberSlider
          label={t('params.temperature')}
          value={sampling.temperature}
          min={0}
          max={2}
          step={0.01}
          digits={2}
          onChange={(value) => patch({ temperature: value })}
        />
        <NumberSlider
          label={t('params.topP')}
          value={sampling.topP}
          min={0}
          max={1}
          step={0.01}
          digits={2}
          onChange={(value) => patch({ topP: value })}
        />
        <NumberSlider
          label={t('params.topK')}
          value={sampling.topK}
          min={0}
          max={200}
          step={1}
          digits={0}
          onChange={(value) => patch({ topK: value })}
        />
        <NumberSlider
          label={t('params.minP')}
          value={sampling.minP}
          min={0}
          max={1}
          step={0.01}
          digits={2}
          onChange={(value) => patch({ minP: value })}
        />
        <NumberSlider
          label={t('params.repeatPenalty')}
          value={sampling.repeatPenalty}
          min={0.5}
          max={2}
          step={0.01}
          digits={2}
          onChange={(value) => patch({ repeatPenalty: value })}
        />
        <NumberSlider
          label={t('params.repeatLastN')}
          value={sampling.repeatLastN}
          min={0}
          max={512}
          step={1}
          digits={0}
          onChange={(value) => patch({ repeatLastN: value })}
        />
        <NumberSlider
          label={t('params.presencePenalty')}
          value={sampling.presencePenalty}
          min={-2}
          max={2}
          step={0.05}
          digits={2}
          onChange={(value) => patch({ presencePenalty: value })}
        />
        <NumberSlider
          label={t('params.frequencyPenalty')}
          value={sampling.frequencyPenalty}
          min={-2}
          max={2}
          step={0.05}
          digits={2}
          onChange={(value) => patch({ frequencyPenalty: value })}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t('params.maxTokens')}>
          <TextInput
            type="number"
            min={-1}
            value={sampling.maxTokens}
            onChange={(event) => patch({ maxTokens: Number(event.target.value) })}
          />
        </Field>
        <Field label={t('params.seed')}>
          <TextInput
            type="number"
            value={sampling.seed}
            onChange={(event) => patch({ seed: Number(event.target.value) })}
          />
        </Field>
      </div>

      {unlimited || randomSeed ? (
        <p className="-mt-2 text-[11px] text-fg-subtle">
          {[unlimited ? t('params.unlimited') : null, randomSeed ? t('params.random') : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}

      <Field label={t('params.stop')} hint={t('params.stopHint')}>
        <TextArea
          rows={3}
          className="min-h-16"
          value={sampling.stop.join('\n')}
          onChange={(event) =>
            patch({
              stop: event.target.value
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0)
            })
          }
        />
      </Field>

      <Button
        size="sm"
        variant="ghost"
        className="justify-center"
        disabled={!conversation}
        onClick={() => patch({ ...DEFAULT_SAMPLING })}
      >
        <RotateCcw className="size-3.5" />
        {t('params.resetDefaults')}
      </Button>
    </div>
  )
}
