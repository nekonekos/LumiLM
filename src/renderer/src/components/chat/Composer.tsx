import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { ImagePlus, Send, Square, X } from 'lucide-react'
import type { Attachment } from '@shared/types'
import { IconButton } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatBytes } from '@/lib/format'
import {
  attachmentFromBlob,
  attachmentFromPath,
  attachmentsFromDataTransfer,
  isSupportedImage
} from '@/lib/attachments'
import { useImageDataUrl } from '@/hooks/useImageDataUrl'
import { useT } from '@/i18n'
import { useChatStore, estimateTokens } from '@/stores/chat'
import { useModelsStore } from '@/stores/models'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

const MAX_TEXTAREA_HEIGHT = 240

function AttachmentChip({
  attachment,
  onRemove
}: {
  attachment: Attachment
  onRemove: (id: string) => void
}): ReactNode {
  const t = useT()
  const preview = useImageDataUrl(attachment.kind === 'image' ? attachment.path : null)

  return (
    <div className="group relative overflow-hidden rounded-[10px] border border-border bg-surface-2">
      {preview ? (
        <img src={preview} alt={attachment.name} className="size-16 object-cover" />
      ) : (
        <div className="grid size-16 place-items-center text-[10px] text-fg-subtle">
          {formatBytes(attachment.sizeBytes, 0)}
        </div>
      )}
      <IconButton
        label={t('chat.removeAttachment')}
        onClick={() => onRemove(attachment.id)}
        className="absolute top-0.5 right-0.5 size-5 bg-surface/85 opacity-0 backdrop-blur group-hover:opacity-100"
      >
        <X className="size-3" />
      </IconButton>
    </div>
  )
}

export function Composer(): ReactNode {
  const t = useT()
  const send = useChatStore((state) => state.send)
  const abort = useChatStore((state) => state.abort)
  const streaming = useChatStore((state) => state.stream !== null)
  const serverState = useChatStore((state) => state.serverState)
  const pushToast = useUiStore((state) => state.pushToast)

  const models = useModelsStore((state) => state.models)
  const activeModelId = useSettingsStore((state) => state.settings?.models.activeModelId ?? null)
  const activeModel = useMemo(
    () => models.find((model) => model.id === activeModelId) ?? null,
    [models, activeModelId]
  )

  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // IME input fires Enter while the candidate window is open; sending then would
  // swallow the confirmation keystroke.
  const composingRef = useRef(false)

  const canSend = !streaming && (text.trim().length > 0 || attachments.length > 0)

  const focusInput = useCallback(() => {
    textareaRef.current?.focus()
  }, [])

  useEffect(() => {
    focusInput()
  }, [focusInput])

  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
  }, [text])

  const addAttachments = useCallback(
    (next: Attachment[]) => {
      if (next.length === 0) return
      setAttachments((current) => [...current, ...next])
    },
    []
  )

  const removeAttachment = (id: string): void => {
    setAttachments((current) => current.filter((item) => item.id !== id))
  }

  const submit = async (): Promise<void> => {
    if (!canSend) return
    const value = text
    const files = attachments
    setText('')
    setAttachments([])
    await send(value, files)
    focusInput()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter') return
    if (event.shiftKey || event.nativeEvent.isComposing || composingRef.current) return
    event.preventDefault()
    void submit()
  }

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = Array.from(event.clipboardData?.items ?? [])
    const images = items.filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    if (images.length === 0) return
    event.preventDefault()

    void (async () => {
      const next: Attachment[] = []
      for (const item of images) {
        const file = item.getAsFile()
        if (!file || !isSupportedImage(file)) continue
        const attachment = await attachmentFromBlob(file, file.name || 'pasted-image.png')
        if (attachment) next.push(attachment)
      }
      addAttachments(next)
    })()
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragging(false)
    void attachmentsFromDataTransfer(event.dataTransfer).then(addAttachments)
  }

  const pickImages = async (): Promise<void> => {
    const paths = await window.lumilm.dialog.pickImages()
    const next: Attachment[] = []
    for (const path of paths) {
      const attachment = await attachmentFromPath(path)
      if (attachment) next.push(attachment)
    }
    addAttachments(next)
  }

  const tokens = estimateTokens(text)
  const contextSize = serverState.contextSize

  return (
    <div
      className="shrink-0 border-t border-border bg-surface px-4 py-3"
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return
        setDragging(false)
      }}
      onDrop={handleDrop}
    >
      <div className="mx-auto w-full max-w-3xl">
        {dragging ? (
          <div className="mb-2 rounded-[10px] border border-dashed border-brand bg-brand-soft px-3 py-2 text-center text-xs text-brand">
            {t('chat.dropHint')}
          </div>
        ) : null}

        {attachments.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <AttachmentChip
                key={attachment.id}
                attachment={attachment}
                onRemove={removeAttachment}
              />
            ))}
          </div>
        ) : null}

        <div
          className={cn(
            'flex items-end gap-2 rounded-[14px] border bg-surface-2 p-1.5 pl-2 transition-colors',
            dragging ? 'border-brand' : 'border-border focus-within:border-brand'
          )}
        >
          <IconButton
            label={t('chat.attachImage')}
            onClick={() => void pickImages()}
            className="mb-0.5"
          >
            <ImagePlus className="size-4" />
          </IconButton>

          <textarea
            ref={textareaRef}
            value={text}
            rows={1}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              composingRef.current = true
            }}
            onCompositionEnd={() => {
              composingRef.current = false
            }}
            onPaste={handlePaste}
            placeholder={activeModel ? t('chat.placeholder') : t('chat.placeholderNoModel')}
            className={cn(
              // The rounded container is the only visible frame: the field itself
              // stays borderless so it grows into a rounded rectangle when it wraps.
              'max-h-60 min-h-[34px] flex-1 resize-none rounded-[11px] bg-transparent px-1 py-1.5',
              'text-sm leading-relaxed text-fg outline-none',
              'focus:outline-none focus-visible:outline-none placeholder:text-fg-subtle'
            )}
          />

          <div className="mb-0.5 flex items-center gap-1.5">
            {text.length > 0 ? (
              <span className="text-[10px] tabular-nums text-fg-subtle" title={t('metrics.context')}>
                ~{tokens}
                {contextSize ? ` / ${contextSize}` : ''}
              </span>
            ) : null}

            {streaming ? (
              <button
                type="button"
                onClick={() => void abort()}
                title={t('chat.stop')}
                className="inline-flex size-8 items-center justify-center rounded-[9px] bg-danger text-white transition-colors hover:brightness-110"
              >
                <Square className="size-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSend}
                title={t('chat.send')}
                className={cn(
                  'inline-flex size-8 items-center justify-center rounded-[9px] transition-colors',
                  canSend
                    ? 'bg-brand text-brand-fg hover:bg-brand-hover'
                    : 'bg-surface-3 text-fg-subtle'
                )}
              >
                <Send className="size-4" />
              </button>
            )}
          </div>
        </div>

        <div className="mt-1.5 flex items-center justify-end px-1 text-[10px] text-fg-subtle">
          {attachments.length > 0 && !activeModel?.mmprojPath ? (
            <button
              type="button"
              className="text-warning"
              onClick={() => pushToast({ kind: 'warning', message: t('chat.imageUnsupported') })}
            >
              {t('models.mmprojMissing')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
