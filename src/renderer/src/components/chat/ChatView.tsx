import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowDown, Loader2, Play, Sparkles } from 'lucide-react'
import { Button, ProgressBar } from '@/components/ui'
import { Composer } from '@/components/chat/Composer'
import { MessageBubble } from '@/components/chat/MessageBubble'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n'
import { useChatStore } from '@/stores/chat'
import { useModelsStore } from '@/stores/models'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

/** Distance from the bottom (px) that still counts as "following the stream". */
const BOTTOM_THRESHOLD_PX = 80

function ServerBanner(): ReactNode {
  const t = useT()
  const serverState = useChatStore((state) => state.serverState)
  const loadServerState = useChatStore((state) => state.loadServerState)
  const models = useModelsStore((state) => state.models)
  const activeModelId = useSettingsStore((state) => state.settings?.models.activeModelId ?? null)
  const [loading, setLoading] = useState(false)

  const model = models.find((item) => item.id === activeModelId) ?? null

  if (serverState.status === 'ready') return null

  const busy = serverState.status === 'starting' || serverState.status === 'loading'

  const start = (): void => {
    setLoading(true)
    void window.lumilm.server
      .load({ modelId: model?.id })
      .catch(() => undefined)
      .then(() => loadServerState())
      .finally(() => setLoading(false))
  }

  return (
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
            {busy
              ? `${t('status.loading')}${serverState.progress ? ` · ${Math.round(serverState.progress * 100)}%` : ''}`
              : serverState.status === 'error'
                ? (serverState.error ?? t('status.error'))
                : t('status.idle')}
          </p>
          <p className="truncate text-[11px] text-fg-subtle">
            {model?.fileName ?? t('chat.placeholderNoModel')}
          </p>
        </div>

        {busy ? (
          <ProgressBar value={serverState.progress ?? 0.05} className="w-28 shrink-0" />
        ) : (
          <Button size="sm" variant="primary" loading={loading} disabled={!model} onClick={start}>
            <Play className="size-3.5" />
            {t('models.load')}
          </Button>
        )}
      </div>
    </div>
  )
}

export function ChatView(): ReactNode {
  const t = useT()

  const conversation = useChatStore((state) => state.conversation)
  const stream = useChatStore((state) => state.stream)
  const serverState = useChatStore((state) => state.serverState)
  const regenerate = useChatStore((state) => state.regenerate)
  const editMessage = useChatStore((state) => state.editMessage)
  const deleteMessage = useChatStore((state) => state.deleteMessage)
  const createConversation = useChatStore((state) => state.create)

  const models = useModelsStore((state) => state.models)
  const openSettings = useUiStore((state) => state.openSettings)

  const layout = useSettingsStore((state) => state.settings?.appearance.layout ?? 'bubble')
  const density = useSettingsStore((state) => state.settings?.appearance.density ?? 'comfortable')
  const showReasoning = useSettingsStore((state) => state.settings?.appearance.showReasoning ?? true)

  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [showJump, setShowJump] = useState(false)

  const messages = conversation?.messages ?? []
  const streamingId = stream?.messageId ?? null

  const isEmpty = messages.length === 0
  const hasModel = models.length > 0

  const scrollToBottom = (behavior: ScrollBehavior = 'auto'): void => {
    const element = scrollRef.current
    if (!element) return
    pinnedRef.current = true
    setShowJump(false)
    element.scrollTo({ top: element.scrollHeight, behavior })
  }

  const followStream = (): void => {
    const element = scrollRef.current
    if (!element) return
    // Keep the viewport glued to the stream while the user stays at the bottom.
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

  const emptyState = useMemo(() => {
    if (!hasModel) {
      return {
        icon: <AlertTriangle className="size-5" />,
        title: t('chat.emptyNoModel'),
        body: t('onboard.noModelFound'),
        action: (
          <Button variant="primary" onClick={() => openSettings('models')}>
            {t('chat.addModel')}
          </Button>
        )
      }
    }
    return {
      icon: <Sparkles className="size-5" />,
      title: t('chat.emptyTitle'),
      body: t('chat.emptyBody'),
      action: (
        <Button variant="ghost" onClick={() => void createConversation()}>
          {t('nav.newChat')}
        </Button>
      )
    }
  }, [createConversation, hasModel, openSettings, t])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-4">
          {serverState.status !== 'ready' ? <ServerBanner /> : null}

          {isEmpty ? (
            <div className="flex min-h-[46vh] flex-col items-center justify-center gap-3 text-center">
              <span className="grid size-11 place-items-center rounded-[14px] bg-brand-soft text-brand">
                {emptyState.icon}
              </span>
              <h2 className="text-base font-semibold text-fg">{emptyState.title}</h2>
              <p className="max-w-md text-xs leading-relaxed text-fg-muted">{emptyState.body}</p>
              {emptyState.action}
            </div>
          ) : (
            <div className={cn('flex flex-col', density === 'compact' ? 'gap-3' : 'gap-5')}>
              {messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  layout={layout}
                  density={density}
                  showReasoning={showReasoning}
                  isStreaming={message.id === streamingId}
                  streamContent={stream?.content}
                  streamReasoning={stream?.reasoning}
                  canAct={stream === null}
                  onRegenerate={(id) => void regenerate(id)}
                  onEdit={(id, content) => void editMessage(id, content)}
                  onDelete={(id) => void deleteMessage(id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {showJump ? (
        <button
          type="button"
          onClick={() => scrollToBottom('smooth')}
          className="absolute right-6 bottom-32 z-10 grid size-8 place-items-center rounded-full border border-border bg-surface text-fg-muted shadow-[var(--shadow-soft)] hover:text-fg"
          aria-label={t('chat.generating')}
        >
          <ArrowDown className="size-4" />
        </button>
      ) : null}

      <Composer />
    </div>
  )
}
