import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Brain,
  Download,
  FileJson,
  Copy,
  Heart,
  MessageSquarePlus,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  Upload,
  Pencil
} from 'lucide-react'
import { Badge, Button, Dialog, IconButton, TextInput } from '@/components/ui'
import { useT, useLocale } from '@/i18n'
import { cn } from '@/lib/cn'
import { formatRelativeTime } from '@/lib/format'
import { useChatStore } from '@/stores/chat'
import { useCompanionStore } from '@/stores/companion'
import { useMemoryStore } from '@/stores/memory'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

export function Sidebar(): ReactNode {
  const t = useT()
  const locale = useLocale()
  const metas = useChatStore((state) => state.metas)
  const conversation = useChatStore((state) => state.conversation)
  const open = useChatStore((state) => state.open)
  const create = useChatStore((state) => state.create)
  const remove = useChatStore((state) => state.remove)
  const duplicate = useChatStore((state) => state.duplicate)
  const rename = useChatStore((state) => state.rename)
  const togglePin = useChatStore((state) => state.togglePin)
  const exportConversation = useChatStore((state) => state.exportConversation)
  const importConversation = useChatStore((state) => state.importConversation)
  const confirmOnDelete = useSettingsStore((state) => state.settings?.general.confirmOnDelete ?? true)
  const openSettings = useUiStore((state) => state.openSettings)
  const setMemoryOpen = useUiStore((state) => state.setMemoryOpen)
  const openConversation = useCompanionStore((state) => state.openConversation)
  const memoryStats = useMemoryStore((state) => state.stats)
  const loadMemory = useMemoryStore((state) => state.load)
  const pendingCount = memoryStats?.pending ?? 0

  useEffect(() => {
    void loadMemory()
  }, [loadMemory])

  const [query, setQuery] = useState('')
  const [menuId, setMenuId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return metas
    return metas.filter(
      (meta) =>
        meta.title.toLowerCase().includes(needle) || meta.preview.toLowerCase().includes(needle)
    )
  }, [metas, query])

  const commitRename = async (id: string): Promise<void> => {
    const value = renameValue.trim()
    setRenamingId(null)
    if (value.length > 0) await rename(id, value)
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deletingId) return
    await remove(deletingId)
    setDeletingId(null)
  }

  const requestDelete = (id: string): void => {
    setMenuId(null)
    if (confirmOnDelete) setDeletingId(id)
    else void remove(id)
  }

  return (
    <aside className="flex h-full w-full flex-col border-r border-border bg-surface">
      <div className="flex flex-col gap-2 p-3">
        <Button
          variant="primary"
          size="md"
          className="w-full justify-center"
          onClick={() => void create()}
        >
          <MessageSquarePlus className="size-4" />
          {t('nav.newChat')}
        </Button>

        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-subtle" />
          <TextInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('nav.searchPlaceholder')}
            className="w-full pl-8"
            aria-label={t('nav.searchPlaceholder')}
          />
        </div>

        <div className="flex gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 justify-center"
            onClick={() => void openConversation()}
          >
            <Heart className="size-3.5" />
            {t('companion.title')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 justify-center"
            onClick={() => setMemoryOpen(true)}
          >
            <Brain className="size-3.5" />
            {t('memory.title')}
            {pendingCount > 0 ? (
              <Badge tone="brand" className="px-1 py-0">
                {pendingCount}
              </Badge>
            ) : null}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {filtered.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <p className="text-xs text-fg-subtle">
              {metas.length === 0 ? t('nav.noConversations') : t('nav.searchPlaceholder')}
            </p>
            {metas.length === 0 ? (
              <p className="mt-1 text-[11px] text-fg-subtle">{t('nav.emptyHint')}</p>
            ) : null}
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {filtered.map((meta) => {
              const active = conversation?.id === meta.id
              return (
                <li key={meta.id} className="group relative">
                  {renamingId === meta.id ? (
                    <div className="px-1 py-1">
                      <TextInput
                        autoFocus
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onBlur={() => void commitRename(meta.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void commitRename(meta.id)
                          if (event.key === 'Escape') setRenamingId(null)
                        }}
                        className="w-full"
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void open(meta.id)}
                      className={cn(
                        'flex w-full flex-col items-start gap-0.5 rounded-[10px] px-2.5 py-2 text-left transition-colors',
                        active ? 'bg-brand-soft' : 'hover:bg-surface-3'
                      )}
                    >
                      <span className="flex w-full items-center gap-1.5">
                        {meta.pinned ? <Pin className="size-3 shrink-0 text-brand" /> : null}
                        {meta.mode === 'companion' ? (
                          <Heart
                            className="size-3 shrink-0 text-brand"
                            aria-label={t('companion.title')}
                          />
                        ) : null}
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate text-[13px] font-medium',
                            active ? 'text-brand' : 'text-fg'
                          )}
                        >
                          {meta.title || t('nav.newChat')}
                        </span>
                        <span className="shrink-0 text-[10px] text-fg-subtle">
                          {formatRelativeTime(meta.updatedAt, locale)}
                        </span>
                      </span>                      {meta.preview ? (
                        <span className="w-full truncate text-[11px] text-fg-subtle">{meta.preview}</span>
                      ) : null}
                      {meta.mode === 'companion' && meta.unreadCount > 0 ? (
                        <Badge tone="brand" className="mt-0.5 px-1.5 py-0">
                          <Heart className="size-2.5" />
                          {meta.unreadCount}
                        </Badge>
                      ) : null}
                    </button>
                  )}

                  <div
                    className={cn(
                      'absolute top-1 right-1 flex items-center gap-0.5 opacity-0 transition-opacity',
                      'group-hover:opacity-100 focus-within:opacity-100',
                      menuId === meta.id && 'opacity-100'
                    )}
                  >
                    <IconButton
                      label={t('nav.delete')}
                      className="size-6 bg-surface/80"
                      onClick={() => requestDelete(meta.id)}
                    >
                      <Trash2 className="size-3.5" />
                    </IconButton>
                    <IconButton
                      label="More"
                      className="size-6 bg-surface/80"
                      onClick={() => setMenuId(menuId === meta.id ? null : meta.id)}
                    >
                      <MoreHorizontal className="size-3.5" />
                    </IconButton>
                  </div>

                  {menuId === meta.id ? (
                    <>
                      <div className="fixed inset-0 z-30" onClick={() => setMenuId(null)} />
                      <div className="absolute top-8 right-1 z-40 w-44 overflow-hidden rounded-[10px] border border-border bg-surface py-1 shadow-[var(--shadow-pop)]">
                        <MenuItem
                          icon={<Pencil className="size-3.5" />}
                          label={t('common.rename')}
                          onClick={() => {
                            setMenuId(null)
                            setRenamingId(meta.id)
                            setRenameValue(meta.title)
                          }}
                        />
                        <MenuItem
                          icon={meta.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                          label={meta.pinned ? t('nav.unpin') : t('nav.pin')}
                          onClick={() => {
                            setMenuId(null)
                            void togglePin(meta.id)
                          }}
                        />
                        <MenuItem
                          icon={<Copy className="size-3.5" />}
                          label={t('nav.duplicate')}
                          onClick={() => {
                            setMenuId(null)
                            void duplicate(meta.id)
                          }}
                        />
                        <MenuItem
                          icon={<Download className="size-3.5" />}
                          label={t('nav.export')}
                          onClick={() => {
                            setMenuId(null)
                            void exportConversation(meta.id, 'md')
                          }}
                        />
                        <MenuItem
                          icon={<FileJson className="size-3.5" />}
                          label={t('nav.exportJson')}
                          onClick={() => {
                            setMenuId(null)
                            void exportConversation(meta.id, 'json')
                          }}
                        />
                        <div className="my-1 h-px bg-border" />
                        <MenuItem
                          icon={<Trash2 className="size-3.5" />}
                          label={t('nav.delete')}
                          danger
                          onClick={() => requestDelete(meta.id)}
                        />
                      </div>
                    </>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-1.5 border-t border-border p-2">
        <Button size="sm" variant="ghost" className="flex-1 justify-center" onClick={() => void importConversation()}>
          <Upload className="size-3.5" />
          {t('nav.import')}
        </Button>
        <Button size="sm" variant="ghost" className="flex-1 justify-center" onClick={() => openSettings('models')}>
          <Plus className="size-3.5" />
          {t('nav.models')}
        </Button>
      </div>

      <Dialog
        open={deletingId !== null}
        onClose={() => setDeletingId(null)}
        title={t('nav.delete')}
        description={t('nav.deleteConfirm')}
        width="max-w-md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeletingId(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={() => void confirmDelete()}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-muted">
          {metas.find((meta) => meta.id === deletingId)?.title ?? ''}
        </p>
      </Dialog>
    </aside>
  )
}

function MenuItem({
  icon,
  label,
  onClick,
  danger
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
        danger ? 'text-danger hover:bg-surface-3' : 'text-fg-muted hover:bg-surface-3 hover:text-fg'
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  )
}
