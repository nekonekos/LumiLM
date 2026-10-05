import { useMemo, useState, type ReactNode } from 'react'
import { Copy, Plus, RotateCcw, Trash2, Upload, Download } from 'lucide-react'
import type { PersonaCard } from '@shared/types'
import { Badge, Button, Field, Select, TextArea, TextInput } from '@/components/ui'
import { estimateTokens } from '@/stores/chat'
import { useT } from '@/i18n'
import { useCompanionStore } from '@/stores/companion'
import { useSettingsStore } from '@/stores/settings'

function newCard(): PersonaCard {
  const now = Date.now()
  return {
    id: `card-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    avatarFile: null,
    identity: '',
    personality: '',
    speechStyle: '',
    relationship: '',
    boundaries: '',
    examples: '',
    firstMessage: '',
    scenario: '',
    notes: '',
    careBaseline: '',
    builtin: false,
    createdAt: now,
    updatedAt: now
  }
}

/**
 * The character card editor.
 *
 * Cards are the whole of the companion's personality, so they are fully
 * editable rather than hidden behind presets, and they round-trip with the
 * SillyTavern V2 format so cards written for other apps work here.
 */
export function PersonaCardEditor(): ReactNode {
  const t = useT()
  const cards = useCompanionStore((state) => state.cards)
  const saveCard = useCompanionStore((state) => state.saveCard)
  const removeCard = useCompanionStore((state) => state.removeCard)
  const importCard = useCompanionStore((state) => state.importCard)
  const exportCard = useCompanionStore((state) => state.exportCard)
  const restoreBuiltin = useCompanionStore((state) => state.restoreBuiltin)
  const selectCard = useCompanionStore((state) => state.selectCard)

  const selectedId = useSettingsStore(
    (state) => state.settings?.companion.characterCardId ?? null
  )
  const personaTokenLimit = useSettingsStore(
    (state) => state.settings?.companion.personaTokenLimit ?? 320
  )

  const [draft, setDraft] = useState<PersonaCard | null>(null)

  const active = useMemo(
    () => cards.find((card) => card.id === selectedId) ?? cards[0] ?? null,
    [cards, selectedId]
  )
  const editing = draft ?? active

  const patch = (next: Partial<PersonaCard>): void => {
    if (!editing) return
    setDraft({ ...editing, ...next })
  }

  const tokens = useMemo(() => {
    if (!editing) return 0
    return estimateTokens(
      [
        editing.name,
        editing.identity,
        editing.personality,
        editing.speechStyle,
        editing.relationship,
        editing.boundaries,
        editing.examples,
        editing.scenario,
        editing.careBaseline
      ].join('\n')
    )
  }, [editing])

  if (!editing) {
    return (
      <div className="flex flex-col gap-2">
        <Button variant="primary" onClick={() => setDraft(newCard())}>
          <Plus className="size-3.5" />
          {t('companion.newCard')}
        </Button>
        <Button variant="ghost" onClick={() => void importCard()}>
          <Upload className="size-3.5" />
          {t('companion.importCard')}
        </Button>
      </div>
    )
  }

  const overBudget = tokens > personaTokenLimit

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Select
          value={editing.id}
          options={cards.map((card) => ({ value: card.id, label: card.name || card.id }))}
          onChange={(value) => {
            setDraft(null)
            void selectCard(value)
          }}
          className="max-w-[200px]"
        />
        <Badge tone={overBudget ? 'warning' : 'neutral'}>
          {t('companion.cardTokens', { n: tokens })}
        </Badge>
        <span className="ml-auto flex flex-wrap gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setDraft(newCard())}>
            <Plus className="size-3.5" />
            {t('companion.newCard')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void importCard()}>
            <Upload className="size-3.5" />
            {t('companion.importCard')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void exportCard(editing.id)}>
            <Download className="size-3.5" />
            {t('companion.exportCard')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDraft({ ...editing, id: newCard().id, name: `${editing.name} 副本` })}
          >
            <Copy className="size-3.5" />
            {t('companion.copyName')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void restoreBuiltin()}>
            <RotateCcw className="size-3.5" />
            {t('companion.restoreBuiltin')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            onClick={() => {
              if (cards.length <= 1) return
              void removeCard(editing.id).then(() => setDraft(null))
            }}
          >
            <Trash2 className="size-3.5" />
            {t('companion.deleteCard')}
          </Button>
        </span>
      </div>

      {overBudget ? (
        <p className="text-[11px] text-warning">{t('companion.cardTruncated')}</p>
      ) : null}

      <Field label={t('companion.cardName')}>
        <TextInput value={editing.name} onChange={(e) => patch({ name: e.target.value })} />
      </Field>

      <Field label={t('companion.cardIdentity')}>
        <TextArea
          rows={3}
          value={editing.identity}
          onChange={(e) => patch({ identity: e.target.value })}
        />
      </Field>

      <Field label={t('companion.cardPersonality')}>
        <TextArea
          rows={3}
          value={editing.personality}
          onChange={(e) => patch({ personality: e.target.value })}
        />
      </Field>

      <Field label={t('companion.cardSpeech')}>
        <TextArea
          rows={2}
          value={editing.speechStyle}
          onChange={(e) => patch({ speechStyle: e.target.value })}
        />
      </Field>

      <Field label={t('companion.cardRelationship')}>
        <TextArea
          rows={2}
          value={editing.relationship}
          onChange={(e) => patch({ relationship: e.target.value })}
        />
      </Field>

      <Field label={t('companion.cardBoundaries')}>
        <TextArea
          rows={2}
          value={editing.boundaries}
          onChange={(e) => patch({ boundaries: e.target.value })}
        />
      </Field>

      <Field label={t('companion.cardExamples')}>
        <TextArea
          rows={4}
          value={editing.examples}
          onChange={(e) => patch({ examples: e.target.value })}
        />
      </Field>

      <Field label={t('companion.cardFirstMessage')}>
        <TextArea
          rows={2}
          value={editing.firstMessage}
          onChange={(e) => patch({ firstMessage: e.target.value })}
        />
      </Field>

      <Field label={t('companion.cardScenario')}>
        <TextArea
          rows={2}
          value={editing.scenario}
          onChange={(e) => patch({ scenario: e.target.value })}
        />
      </Field>

      <Field label={t('companion.cardCare')} hint={t('companion.cardCareHint')}>
        <TextArea
          rows={5}
          value={editing.careBaseline}
          onChange={(e) => patch({ careBaseline: e.target.value })}
        />
      </Field>

      <Field label={t('companion.cardNotes')} hint={t('companion.importHint')}>
        <TextArea
          rows={2}
          value={editing.notes}
          onChange={(e) => patch({ notes: e.target.value })}
        />
      </Field>

      <div className="flex gap-1.5">
        <Button
          variant="primary"
          disabled={editing.name.trim().length === 0}
          onClick={() => {
            void saveCard(editing).then(() => setDraft(null))
          }}
        >
          {t('common.save')}
        </Button>
        <Button variant="ghost" onClick={() => setDraft(null)}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}
