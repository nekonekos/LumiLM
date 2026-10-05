import { useEffect, useState, type ReactNode } from 'react'
import { Brain, Download, Sparkles, Trash2, Upload } from 'lucide-react'
import type { MemorySweepProposal, MemorySweepReport } from '@shared/types'
import { Badge, Button, Dialog, Tabs, TextInput } from '@/components/ui'
import { useT } from '@/i18n'
import { useChatStore } from '@/stores/chat'
import { useMemoryStore } from '@/stores/memory'
import { useUiStore } from '@/stores/ui'
import { FactList, NewlyLearned } from './FactList'
import { EpisodeTimeline, PendingFacts, RelationshipPanel } from './MemoryViews'

type LibraryTab = 'facts' | 'timeline' | 'pending' | 'relationship'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * The tidy-up's suggestion list.
 *
 * Nothing here has happened yet: the sweep only proposes, and each row is a change
 * the user can decline individually. That is the whole point of not letting the
 * model rewrite the store on its own.
 */
function TidyUpPanel({
  report
}: {
  report: MemorySweepReport
}): ReactNode {
  const t = useT()
  const sweeping = useMemoryStore((state) => state.sweeping)
  const applySweep = useMemoryStore((state) => state.applySweep)
  const dismissSweep = useMemoryStore((state) => state.dismissSweep)
  // Everything starts selected; the panel is remounted per report, so this never
  // needs an effect to stay in step with a new run.
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(report.proposals.map((proposal) => proposal.id))
  )

  const toggle = (id: string): void => {
    const next = new Set(chosen)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setChosen(next)
  }

  const reason = (proposal: MemorySweepProposal): string => {
    if (proposal.op === 'merge' && proposal.targetText) {
      return t('memory.sweep.merge', { target: proposal.targetText.slice(0, 18) })
    }
    return t(`memory.sweep.${proposal.reason}` as 'memory.sweep.drop')
  }

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-brand/50 bg-brand-soft/20 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Sparkles className="size-3.5 text-brand" />
        <span className="text-[12px] font-medium text-fg">{t('memory.tidyUp')}</span>
        <Badge tone="neutral">{report.scanned}</Badge>
        {!report.usedModel ? (
          <span className="text-[11px] text-fg-subtle">{t('memory.tidyUpOffline')}</span>
        ) : null}
      </div>

      {report.proposals.length === 0 ? (
        <p className="text-[11px] text-fg-subtle">{t('memory.tidyUpNone')}</p>
      ) : (
        <>
          <ul className="flex max-h-[200px] flex-col gap-1 overflow-y-auto">
            {report.proposals.map((proposal) => (
              <li
                key={proposal.id}
                className="flex items-start gap-2 rounded-[6px] border border-border bg-surface px-2 py-1.5"
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={chosen.has(proposal.id)}
                  onChange={() => toggle(proposal.id)}
                />
                <span className="flex flex-1 flex-col gap-0.5">
                  <span className="text-[11px] text-fg">{proposal.text}</span>
                  <span className="text-[10px] text-fg-subtle">{reason(proposal)}</span>
                </span>
                <Badge tone={proposal.op === 'merge' ? 'brand' : 'warning'}>
                  {proposal.op === 'merge' ? t('memory.tidyUpMerge') : t('memory.tidyUpDrop')}
                </Badge>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={sweeping || chosen.size === 0}
              onClick={() => void applySweep([...chosen])}
            >
              {t('memory.tidyUpApply')}
            </Button>
            <Button size="sm" variant="ghost" disabled={sweeping} onClick={dismissSweep}>
              {t('memory.tidyUpDismiss')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * The full-window memory library.
 *
 * The inspector column is far too narrow to browse a diary in, so the serious
 * work — reading, editing, deleting and importing memories — happens here. The
 * panel exists so the companion is never a black box: every fact shows where it
 * came from and can be changed or forgotten.
 */
export function MemoryLibrary(): ReactNode {
  const t = useT()
  const open = useUiStore((state) => state.memoryOpen)
  const setOpen = useUiStore((state) => state.setMemoryOpen)

  const facts = useMemoryStore((state) => state.facts)
  const episodes = useMemoryStore((state) => state.episodes)
  const stats = useMemoryStore((state) => state.stats)
  const load = useMemoryStore((state) => state.load)
  const forgetAll = useMemoryStore((state) => state.forgetAll)
  const exportToFile = useMemoryStore((state) => state.exportToFile)
  const importFromFile = useMemoryStore((state) => state.importFromFile)
  const runSweep = useMemoryStore((state) => state.runSweep)
  const sweeping = useMemoryStore((state) => state.sweeping)
  const sweep = useMemoryStore((state) => state.sweep)

  const conversationId = useChatStore((state) => state.conversation?.id ?? null)

  const [tab, setTab] = useState<LibraryTab>('facts')
  const [confirming, setConfirming] = useState(false)
  const [confirmText, setConfirmText] = useState('')

  const pendingCount = facts.filter((fact) => fact.pending && !fact.archived).length

  useEffect(() => {
    if (!open) return
    void load()
  }, [open, load, conversationId])

  const close = (): void => {
    setOpen(false)
    setConfirming(false)
    setConfirmText('')
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('memory.title')}
      width="max-w-6xl"
      footer={
        <>
          <span className="mr-auto text-[11px] text-fg-subtle">
            {t('memory.total', { n: facts.length })}
            {stats ? ` · ${t('memory.size', { size: formatBytes(stats.bytes) })}` : ''}
          </span>
          <Button variant="ghost" disabled={sweeping} onClick={() => void runSweep()}>
            <Sparkles className="size-3.5" />
            {sweeping ? t('memory.tidyUpScanning') : t('memory.tidyUp')}
          </Button>
          <Button variant="ghost" onClick={() => void exportToFile()}>
            <Download className="size-3.5" />
            {t('memory.export')}
          </Button>
          <Button variant="ghost" onClick={() => void importFromFile()}>
            <Upload className="size-3.5" />
            {t('memory.import')}
          </Button>
          <Button variant="ghost" className="text-danger" onClick={() => setConfirming(true)}>
            <Trash2 className="size-3.5" />
            {t('memory.forgetAll')}
          </Button>
          <Button variant="secondary" onClick={close}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <div className="flex min-h-[62vh] flex-col gap-3">
        <Tabs<LibraryTab>
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'facts', label: `${t('memory.facts')} (${facts.length})` },
            { value: 'timeline', label: `${t('memory.timeline')} (${episodes.length})` },
            {
              value: 'pending',
              label: pendingCount > 0 ? `${t('memory.pending')} (${pendingCount})` : t('memory.pending')
            },
            { value: 'relationship', label: t('memory.relationship') }
          ]}
        />

        {tab === 'facts' ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            {sweep ? (
              <TidyUpPanel
                key={sweep.proposals.map((proposal) => proposal.id).join(',') || 'empty'}
                report={sweep}
              />
            ) : null}
            <NewlyLearned />
            <FactList />
          </div>
        ) : null}
        {tab === 'timeline' ? <EpisodeTimeline /> : null}
        {tab === 'pending' ? <PendingFacts /> : null}
        {tab === 'relationship' ? <RelationshipPanel /> : null}

        {confirming ? (
          <div className="rounded-[10px] border border-danger/60 bg-surface-2 px-3 py-2.5">
            <p className="text-[12px] text-danger">{t('memory.forgetAllConfirm')}</p>
            <div className="mt-2 flex items-center gap-2">
              <TextInput
                value={confirmText}
                placeholder={t('memory.forgetAllWord')}
                onChange={(event) => setConfirmText(event.target.value)}
                className="max-w-[180px]"
              />
              <Button
                variant="danger"
                size="sm"
                disabled={confirmText.trim() !== t('memory.forgetAllWord')}
                onClick={() => {
                  void forgetAll().then(() => {
                    setConfirming(false)
                    setConfirmText('')
                  })
                }}
              >
                <Trash2 className="size-3.5" />
                {t('memory.forgetAll')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        ) : null}

        <p className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
          <Brain className="size-3" />
          {t('memory.importHint')}
        </p>
      </div>
    </Dialog>
  )
}
