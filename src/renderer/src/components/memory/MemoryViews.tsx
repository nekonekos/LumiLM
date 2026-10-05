import type { ReactNode } from 'react'
import { CalendarDays, Check, Trash2 } from 'lucide-react'
import { Badge, Button, EmptyHint, SectionTitle, Slider, Switch, TextInput } from '@/components/ui'
import { useT } from '@/i18n'
import { useMemoryStore } from '@/stores/memory'
import { useCompanionStore } from '@/stores/companion'
import { useState } from 'react'

/** The companion's diary, newest day first. */
export function EpisodeTimeline(): ReactNode {
  const t = useT()
  const episodes = useMemoryStore((state) => state.episodes)

  if (episodes.length === 0) return <EmptyHint>{t('memory.episodeEmpty')}</EmptyHint>

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
      {episodes.map((episode) => (
        <article
          key={episode.id}
          className="rounded-[10px] border border-border bg-surface-2 px-3 py-2.5"
        >
          <header className="mb-1.5 flex items-center gap-2">
            <CalendarDays className="size-3.5 text-brand" />
            <span className="text-[11px] font-medium text-fg">{episode.date}</span>
            {episode.emotion ? (
              <Badge tone="brand" className="px-1.5 py-0">
                {episode.emotion}
              </Badge>
            ) : null}
          </header>
          <p className="text-[12px] leading-relaxed text-fg-muted">{episode.summary}</p>
          {episode.highlights.length > 0 ? (
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {episode.highlights.map((highlight) => (
                <li key={highlight} className="text-[11px] text-fg-subtle">
                  · {highlight}
                </li>
              ))}
            </ul>
          ) : null}
        </article>
      ))}
    </div>
  )
}

/** Facts the extractor learned but the user has not decided on yet. */
export function PendingFacts(): ReactNode {
  const t = useT()
  const facts = useMemoryStore((state) => state.facts)
  const approve = useMemoryStore((state) => state.approve)
  const update = useMemoryStore((state) => state.update)

  const pending = facts.filter((fact) => fact.pending && !fact.archived)
  const [draft, setDraft] = useState<Record<string, string>>({})

  if (pending.length === 0) return <EmptyHint>{t('memory.emptyPending')}</EmptyHint>

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant="primary"
          onClick={() => void approve(pending.map((fact) => fact.id), true)}
        >
          <Check className="size-3.5" />
          {t('memory.acceptAll')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-danger"
          onClick={() => void approve(pending.map((fact) => fact.id), false)}
        >
          <Trash2 className="size-3.5" />
          {t('memory.rejectAll')}
        </Button>
      </div>

      {pending.map((fact) => (
        <div key={fact.id} className="rounded-[10px] border border-border bg-surface-2 px-3 py-2.5">
          <TextInput
            value={draft[fact.id] ?? fact.text}
            onChange={(event) => setDraft({ ...draft, [fact.id]: event.target.value })}
            className="text-[12px]"
          />
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[10px] text-fg-subtle">
              {new Date(fact.createdAt).toLocaleDateString()}
            </span>
            <div className="w-28">
              <Slider
                min={1}
                max={5}
                step={1}
                value={fact.importance}
                onChange={(value) => void update(fact.id, { importance: value })}
              />
            </div>
            <Button
              size="sm"
              variant="primary"
              className="ml-auto"
              onClick={() => {
                const text = draft[fact.id]
                if (text !== undefined && text !== fact.text) void update(fact.id, { text })
                void approve([fact.id], true)
              }}
            >
              <Check className="size-3.5" />
              {t('memory.accept')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void approve([fact.id], false)}>
              {t('memory.reject')}
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}

/** The relationship, editable: the companion's memory of you is yours to correct. */
export function RelationshipPanel(): ReactNode {
  const t = useT()
  const status = useCompanionStore((state) => state.status)
  const loadedAt = useCompanionStore((state) => state.loadedAt)
  const updateRelationship = useCompanionStore((state) => state.updateRelationship)
  const heartbeatEnabled = useCompanionStore((state) => state.setHeartbeatEnabled)
  const snooze = useCompanionStore((state) => state.snooze)
  const speakNow = useCompanionStore((state) => state.speakNow)
  const dreamNow = useCompanionStore((state) => state.dreamNow)
  const speaking = useCompanionStore((state) => state.speaking)

  if (!status) return <EmptyHint>{t('common.loading')}</EmptyHint>

  const relationship = status.relationship
  const bookkeeping = status.heartbeat

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
      <div className="rounded-[10px] border border-border bg-surface-2 px-3 py-2.5">
        <SectionTitle>{t('companion.relationship')}</SectionTitle>
        <p className="mt-1 text-[12px] text-fg">
          {relationship.stage} · {relationship.affinity}/100
        </p>
        <p className="mt-0.5 text-[11px] text-fg-subtle">
          {relationship.mood ? `${t('companion.mood')}: ${relationship.mood}` : null}
          {relationship.knownSince > 0
            ? ` · ${Math.max(1, Math.floor((loadedAt - relationship.knownSince) / 86_400_000))} ${t(
                'companion.daysKnown'
              )}`
            : ''}
        </p>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-fg-muted">{t('companion.affinity')}</span>
        <Slider
          min={0}
          max={100}
          step={1}
          value={relationship.affinity}
          onChange={(value) => void updateRelationship({ affinity: value })}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-fg-muted">{t('companion.nicknameUser')}</span>
        <TextInput
          defaultValue={relationship.nicknameForUser ?? ''}
          onBlur={(event) => void updateRelationship({ nicknameForUser: event.target.value || null })}
        />
      </label>

      <div className="rounded-[10px] border border-border bg-surface-2 px-3 py-2.5">
        <SectionTitle>{t('companion.heartbeat')}</SectionTitle>
        <label className="mt-1.5 flex items-center gap-2 text-[11px] text-fg-muted">
          <Switch
            checked={status.enabled}
            onChange={(checked) => void heartbeatEnabled(checked)}
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
        {bookkeeping.unansweredStreak > 0 ? (
          <p className="mt-1 text-[11px] text-warning">
            {t('companion.backoff', { n: bookkeeping.unansweredStreak })}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => void snooze(60)}>
            {t('companion.snoozeHour')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void snooze(60 * 12)}>
            {t('companion.snoozeDay')}
          </Button>
          <Button size="sm" variant="secondary" disabled={speaking} onClick={() => void speakNow()}>
            {t('companion.speakNow')}
          </Button>
          <Button size="sm" variant="ghost" disabled={speaking} onClick={() => void dreamNow()}>
            {t('companion.dreamNow')}
          </Button>
        </div>
      </div>
    </div>
  )
}
