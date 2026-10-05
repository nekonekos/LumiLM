import { useMemo, useState, type ReactNode } from 'react'
import {
  Archive,
  ArchiveRestore,
  Brain,
  Check,
  ExternalLink,
  EyeOff,
  Heart,
  Pin,
  PinOff,
  Pencil,
  Star,
  Trash2
} from 'lucide-react'
import type { MemoryFact, MemoryHit } from '@shared/types'
import { Badge, Button, EmptyHint, Field, SectionTitle, Select, Slider, Switch, TextArea, TextInput } from '@/components/ui'
import { formatRelativeTime } from '@/lib/format'
import { cn } from '@/lib/cn'
import { useT, useLocale, type MessageKey } from '@/i18n'
import { useMemoryStore } from '@/stores/memory'
import { useChatStore } from '@/stores/chat'
import { useUiStore } from '@/stores/ui'

const KIND_LABEL: Record<MemoryFact['kind'], MessageKey> = {
  identity: 'memory.kind.identity',
  preference: 'memory.kind.preference',
  event: 'memory.kind.event',
  relationship: 'memory.kind.relationship',
  goal: 'memory.kind.goal',
  boundary: 'memory.kind.boundary',
  other: 'memory.kind.other'
}

function Stars({ value }: { value: number }): ReactNode {
  return (
    <span className="inline-flex items-center gap-0.5" title={String(value)}>
      {[1, 2, 3, 4, 5].map((step) => (
        <Star
          key={step}
          className={cn(
            'size-2.5',
            step <= Math.round(value) ? 'fill-current text-brand' : 'text-fg-subtle'
          )}
        />
      ))}
    </span>
  )
}

function FactRow({
  fact,
  now,
  selected,
  onSelect
}: {
  fact: MemoryFact
  now: number
  selected: boolean
  onSelect: () => void
}): ReactNode {
  const t = useT()
  const fresh = now - fact.createdAt < 5 * 60 * 1000

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col gap-1 rounded-[8px] border px-2.5 py-2 text-left transition-colors',
        selected
          ? 'border-brand bg-brand-soft/40'
          : 'border-transparent hover:border-border hover:bg-surface-2'
      )}
    >
      <span className="flex items-start gap-1.5">
        {fact.pinned ? <Pin className="mt-0.5 size-3 shrink-0 text-brand" /> : null}
        <span
          className={cn(
            'flex-1 text-[12px] leading-snug',
            fact.archived ? 'text-fg-subtle line-through' : 'text-fg'
          )}
        >
          {fact.text}
        </span>
      </span>
      <span className="flex items-center gap-1.5 pl-0.5 text-[10px] text-fg-subtle">
        <Badge tone={fact.kind === 'boundary' ? 'warning' : 'neutral'} className="px-1.5 py-0">
          {t(KIND_LABEL[fact.kind])}
        </Badge>
        <Stars value={fact.importance} />
        {fact.useCount > 0 ? <span>{t('memory.useCount', { n: fact.useCount })}</span> : null}
        {fact.pending ? <Badge tone="brand">{t('memory.pending')}</Badge> : null}
        {fresh && !fact.pending ? <Badge tone="success">{t('memory.newBadge')}</Badge> : null}
        {fact.suppressed ? <EyeOff className="size-2.5" /> : null}
      </span>
    </button>
  )
}

function FactDetail({ fact }: { fact: MemoryFact }): ReactNode {
  const t = useT()
  const locale = useLocale()
  const update = useMemoryStore((state) => state.update)
  const remove = useMemoryStore((state) => state.remove)
  const openConversation = useChatStore((state) => state.open)
  const setMemoryOpen = useUiStore((state) => state.setMemoryOpen)

  const [draft, setDraft] = useState(fact.text)
  const [editing, setEditing] = useState(false)

  const jump = (): void => {
    if (!fact.sourceConversationId) return
    void openConversation(fact.sourceConversationId)
    setMemoryOpen(false)
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={fact.kind === 'boundary' ? 'warning' : 'neutral'}>
          {t(KIND_LABEL[fact.kind])}
        </Badge>
        <Badge tone="neutral">{fact.subject}</Badge>
        {fact.pending ? <Badge tone="brand">{t('memory.pending')}</Badge> : null}
        {fact.archived ? <Badge tone="danger">{t('memory.archive')}</Badge> : null}
        <span className="ml-auto text-[10px] text-fg-subtle">
          {formatRelativeTime(fact.updatedAt, locale)}
        </span>
      </div>

      {editing ? (
        <div className="flex flex-col gap-2">
          <TextArea
            value={draft}
            rows={4}
            onChange={(event) => setDraft(event.target.value)}
            className="text-[12px]"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                void update(fact.id, { text: draft })
                setEditing(false)
              }}
            >
              <Check className="size-3.5" />
              {t('common.save')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(fact.text)
                setEditing(false)
              }}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="rounded-[8px] border border-border bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-fg">
          {fact.text}
        </p>
      )}

      <Field label={t('memory.importance')} hint={`${fact.importance}/5`}>
        <Slider
          min={1}
          max={5}
          step={1}
          value={fact.importance}
          onChange={(value) => void update(fact.id, { importance: value })}
        />
      </Field>

      <div className="flex flex-col gap-1.5">
        <Switch
          checked={fact.pinned}
          onChange={(checked) => void update(fact.id, { pinned: checked })}
          label={t('memory.pin')}
        />
        <span className="flex items-center gap-2 text-[11px] text-fg-muted">
          {fact.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
          {fact.pinned ? t('memory.unpin') : t('memory.pin')}
        </span>
        <Switch
          checked={fact.suppressed}
          onChange={(checked) => void update(fact.id, { suppressed: checked })}
          label={t('memory.suppress')}
        />
        <span className="flex items-center gap-2 text-[11px] text-fg-muted">
          <EyeOff className="size-3" />
          {fact.suppressed ? t('memory.unsuppress') : t('memory.suppress')}
        </span>
      </div>

      <div className="flex flex-col gap-1.5 text-[11px] text-fg-muted">
        {fact.reinforcements > 0 ? (
          <span>{t('memory.reinforced', { n: fact.reinforcements })}</span>
        ) : null}
        <span>{t('memory.useCount', { n: fact.useCount })}</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <SectionTitle>{t('memory.whyRemember')}</SectionTitle>
        {fact.sourceConversationId ? (
          <Button size="sm" variant="ghost" onClick={jump}>
            <ExternalLink className="size-3.5" />
            {t('memory.jumpToSource')}
          </Button>
        ) : (
          <p className="text-[11px] text-fg-subtle">{t('memory.noSources')}</p>
        )}
      </div>

      <div className="mt-auto flex flex-wrap gap-1.5 border-t border-border pt-3">
        <Button size="sm" variant="ghost" onClick={() => setEditing((value) => !value)}>
          <Pencil className="size-3.5" />
          {t('memory.edit')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void update(fact.id, { archived: !fact.archived })}
        >
          {fact.archived ? (
            <ArchiveRestore className="size-3.5" />
          ) : (
            <Archive className="size-3.5" />
          )}
          {fact.archived ? t('memory.unarchive') : t('memory.archive')}
        </Button>
        <Button size="sm" variant="ghost" className="text-danger" onClick={() => void remove(fact.id)}>
          <Trash2 className="size-3.5" />
          {t('common.delete')}
        </Button>
      </div>
    </div>
  )
}

function RecallPreview(): ReactNode {
  const t = useT()
  const preview = useMemoryStore((state) => state.preview)
  const runPreview = useMemoryStore((state) => state.runPreview)
  const [text, setText] = useState('')

  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>{t('memory.recallPreview')}</SectionTitle>
      <p className="text-[11px] text-fg-subtle">{t('memory.recallPreviewHint')}</p>
      <TextInput
        value={text}
        placeholder={t('memory.searchPlaceholder')}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void runPreview(text)
        }}
      />
      <Button size="sm" variant="secondary" onClick={() => void runPreview(text)}>
        {t('common.search')}
      </Button>
      {text.trim().length > 0 && preview.length === 0 ? (
        <p className="text-[11px] text-fg-subtle">{t('memory.recallEmpty')}</p>
      ) : (
        preview.map((hit: MemoryHit) => (
          <div
            key={hit.fact.id}
            className="rounded-[8px] border border-border bg-surface-2 px-2.5 py-1.5"
          >
            <p className="text-[11px] text-fg">{hit.fact.text}</p>
            <p className="text-[10px] text-fg-subtle">
              {hit.score.toFixed(2)} · {hit.reasons.join(' · ')}
            </p>
          </div>
        ))
      )}
    </div>
  )
}

/**
 * The memory library's fact view.
 *
 * Everything the companion knows is listed, searchable and editable here: the
 * point of the panel is that no memory is ever a black box.
 */
export function FactList(): ReactNode {
  const t = useT()
  const facts = useMemoryStore((state) => state.facts)
  const query = useMemoryStore((state) => state.query)
  const setQuery = useMemoryStore((state) => state.setQuery)
  const selectedId = useMemoryStore((state) => state.selectedId)
  const select = useMemoryStore((state) => state.select)
  const loadedAt = useMemoryStore((state) => state.loadedAt)
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const kinds = query.kinds ?? []
    return facts
      .filter((fact) => {
        if (!query.includeArchived && fact.archived) return false
        if (query.includePending === false && fact.pending) return false
        if (query.pinnedOnly && !fact.pinned) return false
        if (kinds.length > 0 && !kinds.includes(fact.kind)) return false
        if (needle.length > 0 && !fact.text.toLowerCase().includes(needle)) return false
        return true
      })
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.updatedAt - a.updatedAt
      })
  }, [facts, query.includeArchived, query.includePending, query.pinnedOnly, query.kinds, search])

  const selected = filtered.find((fact) => fact.id === selectedId) ?? null

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)_280px] gap-3 overflow-hidden">
      <div className="flex min-h-0 flex-col gap-2.5 overflow-y-auto pr-1">
        <TextInput
          value={search}
          placeholder={t('memory.searchPlaceholder')}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select
          value={(query.kinds?.[0] ?? 'all') as MemoryFact['kind'] | 'all'}
          options={[
            { value: 'all' as const, label: t('memory.kindAll') },
            ...(Object.keys(KIND_LABEL) as MemoryFact['kind'][]).map((kind) => ({
              value: kind,
              label: t(KIND_LABEL[kind])
            }))
          ]}
          onChange={(value) =>
            void setQuery(value === 'all' ? { kinds: [] } : { kinds: [value as MemoryFact['kind']] })
          }
        />
        <label className="flex items-center gap-2 text-[11px] text-fg-muted">
          <Switch
            checked={query.pinnedOnly ?? false}
            onChange={(checked) => void setQuery({ pinnedOnly: checked })}
            label={t('memory.pinnedOnly')}
          />
          {t('memory.pinnedOnly')}
        </label>
        <label className="flex items-center gap-2 text-[11px] text-fg-muted">
          <Switch
            checked={query.includeArchived ?? false}
            onChange={(checked) => void setQuery({ includeArchived: checked })}
            label={t('memory.includeArchived')}
          />
          {t('memory.includeArchived')}
        </label>
        <label className="flex items-center gap-2 text-[11px] text-fg-muted">
          <Switch
            checked={query.includePending !== false}
            onChange={(checked) => void setQuery({ includePending: checked })}
            label={t('memory.pending')}
          />
          {t('memory.pending')}
        </label>
        <RecallPreview />
      </div>

      <div className="flex min-h-0 flex-col gap-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <EmptyHint>{t('memory.empty')}</EmptyHint>
        ) : (
          filtered.map((fact) => (
            <FactRow
              key={fact.id}
              fact={fact}
              now={loadedAt}
              selected={fact.id === selectedId}
              onSelect={() => select(fact.id)}
            />
          ))
        )}
      </div>

      <div className="min-h-0 border-l border-border pl-3">
        {selected ? (
          <FactDetail key={selected.id} fact={selected} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <Brain className="size-5 text-fg-subtle" />
            <p className="text-[11px] text-fg-subtle">{t('memory.whyRemember')}</p>
          </div>
        )}
      </div>
    </div>
  )
}

/** A compact "what did she just learn" strip, shown above the fact list. */
export function NewlyLearned(): ReactNode {
  const t = useT()
  const facts = useMemoryStore((state) => state.facts)
  const loadedAt = useMemoryStore((state) => state.loadedAt)
  const select = useMemoryStore((state) => state.select)
  const fresh = facts.filter(
    (fact) => loadedAt - fact.createdAt < 5 * 60 * 1000 && !fact.pending
  )

  if (fresh.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-[8px] border border-border bg-surface-2 px-2.5 py-1.5">
      <Heart className="size-3 text-brand" />
      <span className="text-[11px] text-fg-muted">{t('memory.newBadge')}</span>
      {fresh.slice(0, 4).map((fact) => (
        <button
          key={fact.id}
          type="button"
          onClick={() => select(fact.id)}
          className="rounded-full border border-border px-2 py-0.5 text-[10px] text-fg-muted hover:text-fg"
        >
          {fact.text.slice(0, 18)}
          {fact.text.length > 18 ? '…' : ''}
        </button>
      ))}
    </div>
  )
}
