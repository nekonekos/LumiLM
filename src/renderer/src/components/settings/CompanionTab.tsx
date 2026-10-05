import type { ReactNode } from 'react'
import { Gauge } from 'lucide-react'
import { DEFAULT_COMPANION_SAMPLING } from '@shared/types'
import { Button, Field, SectionTitle, Select, Slider, Switch, TextArea } from '@/components/ui'
import { useT } from '@/i18n'
import { useCompanionStore } from '@/stores/companion'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { PersonaCardEditor } from '@/components/companion/PersonaCardEditor'

/** Settings → Companion: the persona, the memory policy and the heartbeat. */
export function CompanionTab(): ReactNode {
  const t = useT()
  const settings = useSettingsStore((state) => state.settings?.companion)
  const update = useSettingsStore((state) => state.update)
  const pushToast = useUiStore((state) => state.pushToast)
  const dreamNow = useCompanionStore((state) => state.dreamNow)

  if (!settings) return null

  const applyVramSuggestion = (): void => {
    void update({
      inference: {
        contextSize: 8192,
        kvCacheType: 'q8_0',
        perfPreset: 'low-vram',
        vramReserveMb: 1024,
        idleUnloadMinutes: 15
      },
      agent: { thinking: 'minimal' },
      companion: { skipThinking: true }
    })
    pushToast({ kind: 'success', message: t('companion.vramApplied') })
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3">
        <SectionTitle>{t('companion.title')}</SectionTitle>
        <label className="flex items-center gap-2 text-xs text-fg-muted">
          <Switch
            checked={settings.enabled}
            onChange={(checked) => void update({ companion: { enabled: checked } })}
            label={t('companion.title')}
          />
          {t('companion.on')}
        </label>
      </section>

      <section className="flex flex-col gap-3 rounded-[12px] border border-border bg-surface-2 p-3">
        <SectionTitle>{t('companion.vramHint')}</SectionTitle>
        <p className="text-[11px] leading-relaxed text-fg-subtle">{t('companion.vramBody')}</p>
        <Button size="sm" variant="secondary" onClick={applyVramSuggestion}>
          <Gauge className="size-3.5" />
          {t('companion.vramApply')}
        </Button>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>{t('companion.card')}</SectionTitle>
        <PersonaCardEditor />
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>{t('companion.personaBudget')}</SectionTitle>
        <Field label={t('companion.personaBudget')} hint={`${settings.personaTokenLimit} tokens`}>
          <Slider
            min={200}
            max={1600}
            step={40}
            value={settings.personaTokenLimit}
            onChange={(value) => void update({ companion: { personaTokenLimit: value } })}
          />
        </Field>
        <Field label={t('companion.recallBudget')} hint={`${settings.recallTokenBudget} tokens`}>
          <Slider
            min={60}
            max={600}
            step={20}
            value={settings.recallTokenBudget}
            onChange={(value) => void update({ companion: { recallTokenBudget: value } })}
          />
        </Field>
        <Field label={t('companion.summaryBudget')} hint={`${settings.summaryTokenBudget} tokens`}>
          <Slider
            min={80}
            max={600}
            step={20}
            value={settings.summaryTokenBudget}
            onChange={(value) => void update({ companion: { summaryTokenBudget: value } })}
          />
        </Field>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>{t('memory.title')}</SectionTitle>
        <label className="flex items-center gap-2 text-[11px] text-fg-muted">
          <Switch
            checked={settings.memoryEnabled}
            onChange={(checked) => void update({ companion: { memoryEnabled: checked } })}
            label={t('memory.enabled')}
          />
          {t('memory.enabled')}
        </label>
        <p className="text-[11px] leading-snug text-fg-subtle">{t('memory.enabledHint')}</p>

        <label className="flex items-center gap-2 text-[11px] text-fg-muted">
          <Switch
            checked={settings.autoExtract}
            onChange={(checked) => void update({ companion: { autoExtract: checked } })}
            label={t('memory.autoExtract')}
          />
          {t('memory.autoExtract')}
        </label>
        <p className="text-[11px] leading-snug text-fg-subtle">{t('memory.autoExtractHint')}</p>

        <label className="flex items-center gap-2 text-[11px] text-fg-muted">
          <Switch
            checked={settings.autoAcceptFacts}
            onChange={(checked) => void update({ companion: { autoAcceptFacts: checked } })}
            label={t('memory.autoAccept')}
          />
          {t('memory.autoAccept')}
        </label>
        <p className="text-[11px] leading-snug text-fg-subtle">{t('memory.autoAcceptHint')}</p>

        <Field label={t('memory.recallCount')} hint={`${settings.recallCount}`}>
          <Slider
            min={1}
            max={10}
            step={1}
            value={settings.recallCount}
            onChange={(value) => void update({ companion: { recallCount: value } })}
          />
        </Field>

        <Field label={t('memory.injectionMode')}>
          <Select
            value={settings.memoryInjectionMode}
            options={[
              { value: 'user-suffix', label: t('memory.injectionUserSuffix') },
              { value: 'tail-system', label: t('memory.injectionTailSystem') }
            ]}
            onChange={(value) =>
              void update({ companion: { memoryInjectionMode: value as 'user-suffix' } })
            }          />
        </Field>

        <label className="flex items-center gap-2 text-[11px] text-fg-muted">
          <Switch
            checked={settings.includeEpisodes}
            onChange={(checked) => void update({ companion: { includeEpisodes: checked } })}
            label={t('memory.includeEpisodes')}
          />
          {t('memory.includeEpisodes')}
        </label>

        <Button size="sm" variant="secondary" onClick={() => void dreamNow()}>
          {t('companion.dreamNow')}
        </Button>
        <p className="text-[11px] leading-snug text-fg-subtle">{t('companion.dreamHint')}</p>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>{t('companion.heartbeat')}</SectionTitle>
        <label className="flex items-center gap-2 text-[11px] text-fg-muted">
          <Switch
            checked={settings.heartbeatEnabled}
            onChange={(checked) => void update({ companion: { heartbeatEnabled: checked } })}
            label={t('companion.heartbeatOn')}
          />
          {t('companion.heartbeatOn')}
        </label>
        <p className="text-[11px] leading-snug text-fg-subtle">{t('companion.heartbeatHint')}</p>

        <Field label={t('companion.idleMinutes')} hint={`${settings.heartbeatIdleMinutes}`}>
          <Slider
            min={1}
            max={120}
            step={1}
            value={settings.heartbeatIdleMinutes}
            onChange={(value) => void update({ companion: { heartbeatIdleMinutes: value } })}
          />
        </Field>

        <Field
          label={t('companion.probability')}
          hint={`${Math.round(settings.heartbeatProbability * 100)}%`}
        >
          <Slider
            min={5}
            max={100}
            step={5}
            value={Math.round(settings.heartbeatProbability * 100)}
            onChange={(value) =>
              void update({ companion: { heartbeatProbability: value / 100 } })
            }
          />
        </Field>

        <Field label={t('companion.minGap')} hint={`${settings.heartbeatMinGapMinutes}`}>
          <Slider
            min={10}
            max={480}
            step={10}
            value={settings.heartbeatMinGapMinutes}
            onChange={(value) => void update({ companion: { heartbeatMinGapMinutes: value } })}
          />
        </Field>

        <Field label={t('companion.maxPerDay')} hint={`${settings.heartbeatMaxPerDay}`}>
          <Slider
            min={1}
            max={12}
            step={1}
            value={settings.heartbeatMaxPerDay}
            onChange={(value) => void update({ companion: { heartbeatMaxPerDay: value } })}
          />
        </Field>

        <Field label={t('companion.quietHours')} hint="23:00 → 08:00">
          <div className="flex items-center gap-2">
            <Slider
              min={0}
              max={23}
              step={1}
              value={settings.quietHours[0]}
              onChange={(value) =>
                void update({ companion: { quietHours: [value, settings.quietHours[1]] } })
              }
            />
            <Slider
              min={0}
              max={23}
              step={1}
              value={settings.quietHours[1]}
              onChange={(value) =>
                void update({ companion: { quietHours: [settings.quietHours[0], value] } })
              }
            />
          </div>
        </Field>

        <label className="flex items-center gap-2 text-[11px] text-fg-muted">
          <Switch
            checked={settings.focusOnNotification}
            onChange={(checked) => void update({ companion: { focusOnNotification: checked } })}
            label={t('companion.focusOnNotification')}
          />
          {t('companion.focusOnNotification')}
        </label>

        <label className="flex items-center gap-2 text-[11px] text-fg-muted">
          <Switch
            checked={settings.allowColdStart}
            onChange={(checked) => void update({ companion: { allowColdStart: checked } })}
            label={t('companion.allowColdStart')}
          />
          {t('companion.allowColdStart')}
        </label>
        <p className="text-[11px] leading-snug text-fg-subtle">
          {t('companion.allowColdStartHint')}
        </p>

        <label className="flex items-center gap-2 text-[11px] text-fg-muted">
          <Switch
            checked={settings.dreamingEnabled}
            onChange={(checked) => void update({ companion: { dreamingEnabled: checked } })}
            label={t('companion.dreamingEnabled')}
          />
          {t('companion.dreamingEnabled')}
        </label>

        <Field label={t('companion.dreamIdleMinutes')} hint={`${settings.dreamIdleMinutes}`}>
          <Slider
            min={1}
            max={120}
            step={1}
            value={settings.dreamIdleMinutes}
            onChange={(value) => void update({ companion: { dreamIdleMinutes: value } })}
          />
        </Field>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>{t('companion.sampling')}</SectionTitle>
        <label className="flex items-center gap-2 text-[11px] text-fg-muted">
          <Switch
            checked={settings.skipThinking}
            onChange={(checked) => void update({ companion: { skipThinking: checked } })}
            label={t('companion.skipThinking')}
          />
          {t('companion.skipThinking')}
        </label>
        <p className="text-[11px] leading-snug text-fg-subtle">{t('companion.skipThinkingHint')}</p>

        <label className="flex items-center gap-2 text-[11px] text-fg-muted">
          <Switch
            checked={settings.antiOocRetry}
            onChange={(checked) => void update({ companion: { antiOocRetry: checked } })}
            label={t('companion.antiOoc')}
          />
          {t('companion.antiOoc')}
        </label>
        <p className="text-[11px] leading-snug text-fg-subtle">{t('companion.antiOocHint')}</p>

        <Field
          label={t('companion.temperature')}
          hint={String(settings.sampling?.temperature ?? DEFAULT_COMPANION_SAMPLING.temperature)}
        >
          <Slider
            min={0.2}
            max={1.4}
            step={0.05}
            value={settings.sampling?.temperature ?? DEFAULT_COMPANION_SAMPLING.temperature}
            onChange={(value) =>
              void update({
                companion: {
                  sampling: { ...(settings.sampling ?? DEFAULT_COMPANION_SAMPLING), temperature: value }
                }
              })
            }
          />
        </Field>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>{t('memory.title')} · {t('common.custom')}</SectionTitle>
        <Field label={t('memory.injectionMode')}>
          <TextArea
            rows={5}
            value={settings.memoryTemplate}
            onChange={(event) => void update({ companion: { memoryTemplate: event.target.value } })}
          />
        </Field>
        <Field label={t('companion.card')}>
          <TextArea
            rows={5}
            value={settings.personaTemplate}
            onChange={(event) => void update({ companion: { personaTemplate: event.target.value } })}
          />
        </Field>
      </section>
    </div>
  )
}
