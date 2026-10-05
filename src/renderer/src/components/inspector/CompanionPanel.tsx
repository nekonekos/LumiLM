import { useEffect, type ReactNode } from 'react'
import { Brain, Heart, Loader2, SlidersHorizontal } from 'lucide-react'
import { Badge, Button, EmptyHint, Field, SectionTitle, Slider, Switch, TextInput } from '@/components/ui'
import { useT } from '@/i18n'
import { useMemoryStore } from '@/stores/memory'
import { useCompanionStore } from '@/stores/companion'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

/** The companion tab: who she is, how close you are, and whether she may speak up. */
export function CompanionPanel(): ReactNode {
  const t = useT()
  const status = useCompanionStore((state) => state.status)
  const stats = useCompanionStore((state) => state.stats)
  const load = useCompanionStore((state) => state.load)
  const updateRelationship = useCompanionStore((state) => state.updateRelationship)
  const setHeartbeatEnabled = useCompanionStore((state) => state.setHeartbeatEnabled)
  const snooze = useCompanionStore((state) => state.snooze)
  const speakNow = useCompanionStore((state) => state.speakNow)
  const dreamNow = useCompanionStore((state) => state.dreamNow)
  const speaking = useCompanionStore((state) => state.speaking)
  const setMemoryOpen = useUiStore((state) => state.setMemoryOpen)

  const enabled = useSettingsStore((state) => state.settings?.companion.enabled ?? false)
  const update = useSettingsStore((state) => state.update)

  useEffect(() => {
    void load()
  }, [load])

  if (!status) return <EmptyHint>{t('common.loading')}</EmptyHint>

  const relationship = status.relationship
  const bookkeeping = status.heartbeat

  return (
    <div className="flex flex-col gap-3.5">
      <label className="flex items-center gap-2 text-xs text-fg-muted">
        <Switch
          checked={enabled}
          onChange={(checked) => void update({ companion: { enabled: checked } })}
          label={t('companion.title')}
        />
        {t('companion.title')}
      </label>

      <div className="rounded-[10px] border border-border bg-surface-2 px-3 py-2.5">
        <SectionTitle>{t('companion.relationship')}</SectionTitle>
        <p className="mt-1 text-[12px] text-fg">
          {status.card.name} · {relationship.stage}
        </p>
        <p className="mt-0.5 text-[11px] text-fg-subtle">
          {t('companion.affinity')} {relationship.affinity}/100
          {relationship.mood ? ` · ${relationship.mood}` : ''}
        </p>
        <div className="mt-2">
          <Slider
            min={0}
            max={100}
            step={1}
            value={relationship.affinity}
            onChange={(value) => void updateRelationship({ affinity: value })}
          />
        </div>
        <Field label={t('companion.nicknameUser')} className="mt-2">
          <TextInput
            defaultValue={relationship.nicknameForUser ?? ''}
            onBlur={(event) =>
              void updateRelationship({ nicknameForUser: event.target.value || null })
            }
          />
        </Field>
      </div>

      <div className="rounded-[10px] border border-border bg-surface-2 px-3 py-2.5">
        <SectionTitle>{t('memory.title')}</SectionTitle>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Badge tone="neutral">{t('memory.facts')} {stats?.active ?? 0}</Badge>
          <Badge tone={stats && stats.pending > 0 ? 'brand' : 'neutral'}>
            {t('memory.pending')} {stats?.pending ?? 0}
          </Badge>
          <Badge tone="neutral">{t('memory.timeline')} {stats?.episodes ?? 0}</Badge>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="mt-2 w-full justify-center"
          onClick={() => setMemoryOpen(true)}
        >
          <Brain className="size-3.5" />
          {t('memory.openLibrary')}
        </Button>
      </div>

      <div className="rounded-[10px] border border-border bg-surface-2 px-3 py-2.5">
        <SectionTitle>{t('companion.heartbeat')}</SectionTitle>
        <label className="mt-1.5 flex items-center gap-2 text-[11px] text-fg-muted">
          <Switch
            checked={enabled}
            onChange={(checked) => void setHeartbeatEnabled(checked)}
            label={t('companion.heartbeatOn')}
          />
          {t('companion.heartbeatOn')}
        </label>
        <p className="mt-1.5 text-[11px] text-fg-subtle">
          {bookkeeping.lastGreetingAt > 0
            ? t('companion.lastSpoke', {
                time: new Date(bookkeeping.lastGreetingAt).toLocaleString()
              })
            : t('companion.neverSpoke')}
        </p>
        {status.snoozed ? (
          <p className="mt-1 text-[11px] text-warning">
            {t('companion.snoozeUntil', {
              time: new Date(bookkeeping.snoozeUntil).toLocaleTimeString()
            })}
          </p>
        ) : null}
        {bookkeeping.unansweredStreak > 0 ? (
          <p className="mt-1 text-[11px] text-warning">
            {t('companion.backoff', { n: bookkeeping.unansweredStreak })}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => void snooze(60)}>
            {t('companion.snoozeHour')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void snooze(720)}>
            {t('companion.snoozeDay')}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          disabled={!enabled || speaking || status.snoozed}
          onClick={() => void speakNow()}
        >
          {speaking ? <Loader2 className="size-3.5 animate-spin" /> : <Heart className="size-3.5" />}
          {t('companion.speakNow')}
        </Button>
        <Button size="sm" variant="ghost" disabled={speaking} onClick={() => void dreamNow()}>
          <SlidersHorizontal className="size-3.5" />
          {t('companion.dreamNow')}
        </Button>
      </div>
      <p className="text-[11px] leading-snug text-fg-subtle">{t('companion.dreamHint')}</p>
    </div>
  )
}

/** The memory tab: what she would recall right now, and the switches for it. */
export function MemoryPanel(): ReactNode {
  const t = useT()
  const facts = useMemoryStore((state) => state.facts)
  const stats = useMemoryStore((state) => state.stats)
  const load = useMemoryStore((state) => state.load)
  const preview = useMemoryStore((state) => state.preview)
  const runPreview = useMemoryStore((state) => state.runPreview)
  const setMemoryOpen = useUiStore((state) => state.setMemoryOpen)

  const settings = useSettingsStore((state) => state.settings?.companion)
  const update = useSettingsStore((state) => state.update)

  useEffect(() => {
    void load()
  }, [load])

  if (!settings) return <EmptyHint>{t('common.loading')}</EmptyHint>

  const pending = facts.filter((fact) => fact.pending && !fact.archived)

  return (
    <div className="flex flex-col gap-3.5">
      <label className="flex items-center gap-2 text-xs text-fg-muted">
        <Switch
          checked={settings.memoryEnabled}
          onChange={(checked) => void update({ companion: { memoryEnabled: checked } })}
          label={t('memory.enabled')}
        />
        {t('memory.enabled')}
      </label>
      <p className="text-[11px] leading-snug text-fg-subtle">{t('memory.enabledHint')}</p>

      <Field label={t('memory.recallCount')} hint={`${settings.recallCount}`}>
        <Slider
          min={1}
          max={10}
          step={1}
          value={settings.recallCount}
          onChange={(value) => void update({ companion: { recallCount: value } })}
        />
      </Field>

      <label className="flex items-center gap-2 text-[11px] text-fg-muted">
        <Switch
          checked={settings.autoExtract}
          onChange={(checked) => void update({ companion: { autoExtract: checked } })}
          label={t('memory.autoExtract')}
        />
        {t('memory.autoExtract')}
      </label>

      <label className="flex items-center gap-2 text-[11px] text-fg-muted">
        <Switch
          checked={settings.autoAcceptFacts}
          onChange={(checked) => void update({ companion: { autoAcceptFacts: checked } })}
          label={t('memory.autoAccept')}
        />
        {t('memory.autoAccept')}
      </label>

      <div className="rounded-[10px] border border-border bg-surface-2 px-3 py-2.5">
        <SectionTitle>{t('memory.recallPreview')}</SectionTitle>
        <TextInput
          className="mt-1.5"
          placeholder={t('memory.searchPlaceholder')}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void runPreview(event.currentTarget.value)
          }}
        />
        {preview.length === 0 ? (
          <p className="mt-1.5 text-[11px] text-fg-subtle">{t('memory.recallPreviewHint')}</p>
        ) : (
          <ul className="mt-1.5 flex flex-col gap-1">
            {preview.slice(0, 5).map((hit) => (
              <li key={hit.fact.id} className="text-[11px] text-fg-muted">
                · {hit.fact.text}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="neutral">{t('memory.total', { n: stats?.facts ?? 0 })}</Badge>
        <Badge tone={pending.length > 0 ? 'brand' : 'neutral'}>
          {t('memory.pending')} {pending.length}
        </Badge>
      </div>

      <Button
        size="sm"
        variant="secondary"
        className="justify-center"
        onClick={() => setMemoryOpen(true)}
      >
        <Brain className="size-3.5" />
        {t('memory.openLibrary')}
      </Button>
    </div>
  )
}
