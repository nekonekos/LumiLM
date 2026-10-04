import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  BrainCircuit,
  Check,
  ChevronRight,
  Copy,
  Pencil,
  RefreshCw,
  Trash2
} from 'lucide-react'
import type { Attachment, ChatMessage } from '@shared/types'
import { Button, IconButton, TextArea } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatDuration, formatSpeed } from '@/lib/format'
import { useImageDataUrl } from '@/hooks/useImageDataUrl'
import { useAppIcon } from '@/hooks/useAppIcon'
import { useT } from '@/i18n'
import { MarkdownView } from './MarkdownView'

function AttachmentThumb({ attachment }: { attachment: Attachment }): ReactNode {
  const dataUrl = useImageDataUrl(attachment.kind === 'image' ? attachment.path : null)
  if (attachment.kind !== 'image' || !dataUrl) return null
  return (
    <img
      src={dataUrl}
      alt={attachment.name}
      className="max-h-52 max-w-[260px] rounded-[10px] border border-border object-cover"
    />
  )
}

function TypingDots(): ReactNode {
  return (
    <span className="flex items-center gap-1 py-1">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="lm-pulse-dot size-1.5 rounded-full bg-brand"
          style={{ animationDelay: `${index * 0.15}s` }}
        />
      ))}
    </span>
  )
}

function ReasoningPanel({ text, defaultOpen }: { text: string; defaultOpen: boolean }): ReactNode {
  const t = useT()
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="mb-2 overflow-hidden rounded-[10px] border border-border bg-surface-3/60">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-fg-muted transition-colors hover:text-fg"
      >
        <BrainCircuit className="size-3.5 text-brand" />
        {t('chat.reasoning')}
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
      </button>
      {open ? (
        <div className="border-t border-border px-2.5 py-2 text-[12px] leading-relaxed whitespace-pre-wrap text-fg-muted">
          {text}
        </div>
      ) : null}
    </div>
  )
}

export interface MessageBubbleProps {
  message: ChatMessage
  layout: 'bubble' | 'document'
  density: 'comfortable' | 'compact'
  showReasoning: boolean
  isStreaming: boolean
  streamContent?: string
  streamReasoning?: string
  canAct: boolean
  onRegenerate: (messageId: string) => void
  onEdit: (messageId: string, content: string) => void
  onDelete: (messageId: string) => void
}

export const MessageBubble = memo(function MessageBubble({
  message,
  layout,
  density,
  showReasoning,
  isStreaming,
  streamContent,
  streamReasoning,
  canAct,
  onRegenerate,
  onEdit,
  onDelete
}: MessageBubbleProps): ReactNode {
  const t = useT()
  const appIcon = useAppIcon()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const [copied, setCopied] = useState(false)
  const editRef = useRef<HTMLTextAreaElement>(null)

  const isUser = message.role === 'user'
  const content = isStreaming ? (streamContent ?? '') : message.content
  const reasoning = isStreaming ? (streamReasoning ?? '') : (message.reasoning ?? '')

  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.focus()
      editRef.current.setSelectionRange(editRef.current.value.length, editRef.current.value.length)
    }
  }, [editing])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  const padding = density === 'compact' ? 'px-3 py-2' : 'px-4 py-3'

  const actions = (
    <div
      className={cn(
        'flex items-center gap-0.5 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100',
        isUser ? 'flex-row-reverse' : ''
      )}
    >
      <IconButton label={t('common.copy')} className="size-6" onClick={() => void copy()}>
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </IconButton>
      {canAct && isUser ? (
        <IconButton
          label={t('chat.edit')}
          className="size-6"
          onClick={() => {
            setDraft(message.content)
            setEditing(true)
          }}
        >
          <Pencil className="size-3.5" />
        </IconButton>
      ) : null}
      {canAct && !isUser ? (
        <IconButton label={t('chat.regenerate')} className="size-6" onClick={() => onRegenerate(message.id)}>
          <RefreshCw className="size-3.5" />
        </IconButton>
      ) : null}
      {canAct ? (
        <IconButton label={t('chat.delete')} className="size-6" onClick={() => onDelete(message.id)}>
          <Trash2 className="size-3.5" />
        </IconButton>
      ) : null}
    </div>
  )

  if (editing) {
    return (
      <div className="group/message flex flex-col gap-2 py-1">
        <TextArea
          ref={editRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="font-sans text-sm"
        />
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setEditing(false)
              onEdit(message.id, draft)
            }}
          >
            {t('chat.send')}
          </Button>
        </div>
      </div>
    )
  }

  if (layout === 'document') {
    return (
      <div className="group/message flex flex-col gap-1 py-2.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'grid size-6 place-items-center overflow-hidden rounded-full text-[10px] font-bold text-white',
              isUser ? 'bg-brand' : null
            )}
          >
            {isUser ? (
              t('chat.you').slice(0, 1)
            ) : (
              <img src={appIcon} alt="" className="size-6 select-none" draggable={false} />
            )}
          </span>
          <span className="text-xs font-semibold text-fg-muted">
            {isUser ? t('chat.you') : t('chat.assistant')}
          </span>
          <div className="flex-1" />
          {actions}
        </div>

        <div className="pl-8">
          {showReasoning && reasoning.length > 0 ? (
            <ReasoningPanel text={reasoning} defaultOpen={false} />
          ) : null}
          <Attachments attachments={message.attachments} />
          {isStreaming && !content && reasoning.length === 0 ? (
            <TypingDots />
          ) : isUser ? (
            <div className="text-sm leading-relaxed whitespace-pre-wrap text-fg">{content}</div>
          ) : (
            <MarkdownView content={content} />
          )}
          <MessageFooter message={message} isStreaming={isStreaming} />
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn('group/message flex flex-col gap-1 py-1', isUser ? 'items-end' : 'items-start')}
    >
      <div className={cn('flex max-w-[min(760px,88%)] flex-col', isUser ? 'items-end' : 'items-start')}>
        {showReasoning && reasoning.length > 0 ? (
          <div className="w-full">
            <ReasoningPanel text={reasoning} defaultOpen={false} />
          </div>
        ) : null}

        <Attachments attachments={message.attachments} />

        {content.length > 0 || !isStreaming ? (
          <div
            className={cn(
              'rounded-[14px] border text-sm leading-relaxed',
              padding,
              isUser
                ? 'rounded-br-[6px] border-transparent bg-[var(--color-bubble-user)] text-fg'
                : 'rounded-bl-[6px] border-border bg-[var(--color-bubble)] text-fg'
            )}
          >
            {isStreaming && !content ? (
              <TypingDots />
            ) : isUser ? (
              <div className="whitespace-pre-wrap">{content}</div>
            ) : (
              <MarkdownView content={content} />
            )}
          </div>
        ) : (
          <div className={cn('rounded-[14px] border border-border bg-[var(--color-bubble)]', padding)}>
            <TypingDots />
          </div>
        )}
      </div>

      <div className={cn('flex items-center gap-2', isUser ? 'flex-row-reverse' : '')}>
        <MessageFooter message={message} isStreaming={isStreaming} />
        {actions}
      </div>
    </div>
  )
})

function Attachments({ attachments }: { attachments?: Attachment[] }): ReactNode {
  const images = attachments ?? []
  if (images.length === 0) return null
  return (
    <div className="mb-1.5 flex flex-wrap gap-1.5">
      {images.map((attachment) => (
        <AttachmentThumb key={attachment.id} attachment={attachment} />
      ))}
    </div>
  )
}

function MessageFooter({ message, isStreaming }: { message: ChatMessage; isStreaming: boolean }): ReactNode {
  const t = useT()
  const stats = message.stats

  if (isStreaming) return null

  if (message.error) {
    return <span className="max-w-[420px] text-[11px] leading-snug text-danger">{message.error}</span>
  }

  if (message.stopped) {
    return <span className="text-[11px] text-fg-subtle">{t('chat.stopped')}</span>
  }

  if (!stats) return null

  return (
    <span className="flex items-center gap-3 text-[10.5px] tabular-nums text-fg-subtle">
      {stats.ttftMs !== undefined ? (
        <span>
          {t('metrics.firstToken')} {formatDuration(stats.ttftMs)}
        </span>
      ) : null}
      {stats.tokensPerSecond !== undefined ? <span>{formatSpeed(stats.tokensPerSecond)}</span> : null}
      {stats.completionTokens !== undefined ? (
        <span>
          {t('metrics.generated')} {stats.completionTokens}
        </span>
      ) : null}
    </span>
  )
}
