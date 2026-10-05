import { useEffect, useState, type ReactNode } from 'react'
import { Brain, Download, Trash2, Upload } from 'lucide-react'
import { Button, Dialog, Tabs, TextInput } from '@/components/ui'
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
