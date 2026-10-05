import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowDown, Brain, Heart, Loader2, Play, Sparkles } from 'lucide-react'
import { Badge, Button, ProgressBar } from '@/components/ui'
import { Composer } from '@/components/chat/Composer'
import { MessageBubble } from '@/components/chat/MessageBubble'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n'
import { useChatStore } from '@/stores/chat'
import { useCompanionStore } from '@/stores/companion'
import { useModelsStore } from '@/stores/models'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

/** Distance from the bottom (px) that still counts as "following the stream". */
const BOTTOM_THRESHOLD_PX = 80

/**
 * The companion surface.
 *
 * It reuses the chat store for the transcript — a companion turn is still a
 * user/assistant pair with the same persistence and streaming rules — and only
 * adds what is specific to the companion: who she is, how close you are, and
 * whether she has spoken up on her own while you were away.
 */
export function CompanionView(): ReactNode {
  const t = useT()

  const conversation = useChatStore((state) => state.conversation)
  const stream = useChatStore((state) => state.stream)
  const serverState = useChatStore((state) => state.serverState)
  const regenerate = useChatStore((state) => state.regenerate)
  const editMessage = useChatStore((state) => state.editMessage)
  const deleteMessage = useChatStore((state) => state.deleteMessage)

  const status = useCompanionStore((state) => state.status)
  const stats = useCompanionStore((state) => state.stats)
  const speaking = useCompanionStore((state) => state.speaking)
  const openConversation = useCompanionStore((state) => state.openConversation)
  const speakNow = useCompanionStore((state) => state.speakNow)

  const models = useModelsStore((state) => state.models)
  const openSettings = useUiStore((state) => state.openSettings)
  const setMemoryOpen = useUiStore((state) => state.setMemoryOpen)

  const layout = useSettingsStore((state) => state.settings?.appearance.layout ?? 'bubble')
  const density = useSettingsStore((state) => state.settings?.appearance.density ?? 'comfortable')
  const showReasoning = useSettingsStore(
    (state) => state.settings?.appearance.showReasoning ?? true
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const [loadingModel, setLoadingModel] = useState(false)

  const messages = useMemo(() => conversation?.messages ?? [], [conversation])
  const streamingId = stream?.messageId ?? null
  const card = status?.card ?? null

  const followStream = (): void => {
    const element = scrollRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }

  useEffect(() => {
    if (pinnedRef.current) followStream()
  }, [messages.length, stream?.content, stream?.reasoning])

  useEffect(() => {
    pinnedRef.current = true
    followStream()
  }, [conversation?.id])

  const handleScroll = (): void => {
    const element = scrollRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    const pinned = distance < BOTTOM_THRESHOLD_PX
    pinnedRef.current = pinned
    setShowJump(!pinned)
  }

  const loadModel = (): void => {
    const model = models.find((entry) => entry.id === conversation?.modelId) ?? models[0]
    setLoadingModel(true)
    void window.lumilm.server
      .load({ modelId: model?.id })
      .catch(() => undefined)
      .then(() => useChatStore.getState().loadServerState())
      .finally(() => setLoadingModel(false))
  }

  const enabled = status?.enabled ?? false
  const snoozed = status?.snoozed ?? false
  const busy = serverState.status === 'starting' || serverState.status === 'loading'
  const visibleMessages = messages.filter((message) => message.role !== 'tool')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-soft text-sm font-semibold text-brand">
          {card?.name.slice(0, 1) ?? '?'}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-fg">
            {card?.name ?? t('companion.title')}
          </p>
          <p className="truncate text-[11px] text-fg-subtle">
            {status
              ? `${status.relationship.stage} · ${t('companion.affinity')} ${status.relationship.affinity}/100${
                  status.relationship.mood ? ` · ${status.relationship.mood}` : ''
                }`
              : t('companion.title')}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setMemoryOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-[8px] border border-border bg-surface-2 px-2 py-1 text-[11px] text-fg-muted transition-colors hover:text-fg"
          title={t('memory.openLibrary')}
        >
          <Brain className="size-3" />
          {t('memory.tab')}
          <span className="tabular-nums">{stats?.active ?? 0}</span>
          {stats && stats.pending > 0 ? (
            <Badge tone="brand" className="px-1 py-0 text-[10px]">
              {stats.pending}
            </Badge>
          ) : null}
        </button>

        <Button
          size="sm"
          variant="ghost"
          disabled={!enabled || speaking || snoozed}
          onClick={() => void speakNow()}
          title={t('companion.speakNow')}
        >
          {speaking ? <Loader2 className="size-3.5 animate-spin" /> : <Heart className="size-3.5" />}
          <span className="hidden sm:inline">{t('companion.speakNow')}</span>
        </Button>
      </header>

      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-4">
          {serverState.status !== 'ready' ? (
            <div className="mx-auto mb-4 w-full rounded-[12px] border border-border bg-surface-2 px-3.5 py-2.5">
              <div className="flex items-center gap-3">
                <span className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-brand-soft text-brand">
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      'truncate text-xs font-medium',
                      serverState.status === 'error' ? 'text-danger' : 'text-fg'
                    )}
                  >
                    {serverState.status === 'error'
                      ? (serverState.error ?? t('status.error'))
                      : t('status.idle')}
                  </p>
                  <p className="truncate text-[11px] text-fg-subtle">
                    {models.length === 0
                      ? t('chat.placeholderNoModel')
                      : t('companion.heartbeatHint')}
                  </p>
                </div>
                {busy ? (
                  <ProgressBar value={serverState.progress ?? 0.05} className="w-28 shrink-0" />
                ) : (
                  <Button
                    size="sm"
                    variant="primary"
                    loading={loadingModel}
                    disabled={models.length === 0}
                    onClick={loadModel}
                  >
                    <Play className="size-3.5" />
                    {t('models.load')}
                  </Button>
                )}
              </div>
            </div>
          ) : null}

          {!enabled ? (
            <div className="mb-4 rounded-[12px] border border-border bg-surface-2 px-3.5 py-2.5 text-[11px] text-fg-muted">
              {t('companion.notEnabled')}{' '}
              <button
                type="button"
                className="text-brand underline-offset-2 hover:underline"
                onClick={() => openSettings('companion')}
              >
                {t('titlebar.settings')}
              </button>
            </div>
          ) : null}

          {visibleMessages.length === 0 ? (
            <div className="flex min-h-[42vh] flex-col items-center justify-center gap-3 text-center">
              <span className="grid size-11 place-items-center rounded-[14px] bg-brand-soft text-brand">
                {models.length === 0 ? (
                  <AlertTriangle className="size-5" />
                ) : (
                  <Heart className="size-5" />
                )}
              </span>
              <h2 className="text-base font-semibold text-fg">
                {models.length === 0
                  ? t('chat.emptyNoModel')
                  : (card?.name ?? t('companion.emptyTitle'))}
              </h2>
              <p className="max-w-md text-xs leading-relaxed text-fg-muted">
                {models.length === 0 ? t('onboard.noModelFound') : t('companion.emptyBody')}
              </p>
              {models.length === 0 ? (
                <Button variant="primary" onClick={() => openSettings('models')}>
                  {t('chat.addModel')}
                </Button>
              ) : (
                <Button variant="primary" disabled={!enabled} onClick={() => void openConversation()}>
                  {t('companion.start')}
                </Button>
              )}
            </div>
          ) : (
            <div className={cn('flex flex-col', density === 'compact' ? 'gap-3' : 'gap-5')}>
              {visibleMessages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  layout={layout}
                  density={density}
                  showReasoning={showReasoning}
                  isStreaming={message.id === streamingId}
                  streamContent={stream?.content}
                  streamReasoning={stream?.reasoning}
                  toolResults={{}}
                  canAct={stream === null}
                  onRegenerate={(id) => void regenerate(id)}
                  onEdit={(id, content) => void editMessage(id, content)}
                  onDelete={(id) => void deleteMessage(id)}
                />
              ))}
            </div>
          )}

          {speaking ? (
            <p className="mt-4 flex items-center gap-2 text-[11px] text-fg-subtle">
              <Loader2 className="size-3 animate-spin" />
              {t('companion.speaking')}
            </p>
          ) : null}
        </div>
      </div>

      {showJump ? (
        <button
          type="button"
          onClick={() =>
            scrollRef.current?.scrollTo({
              top: scrollRef.current.scrollHeight,
              behavior: 'smooth'
            })
          }
          className="absolute right-6 bottom-32 z-10 grid size-8 place-items-center rounded-full border border-border bg-surface text-fg-muted shadow-[var(--shadow-soft)] hover:text-fg"
          aria-label={t('common.open')}
        >
          <ArrowDown className="size-4" />
        </button>
      ) : null}

      <Composer />
    </div>
  )
}
