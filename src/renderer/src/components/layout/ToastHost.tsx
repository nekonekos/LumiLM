import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useUiStore } from '@/stores/ui'

const ICONS = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle
} as const

const TONES = {
  info: 'text-brand',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-danger'
} as const

export function ToastHost(): ReactNode {
  const toasts = useUiStore((state) => state.toasts)
  const dismiss = useUiStore((state) => state.dismissToast)

  if (toasts.length === 0) return null

  return (
    <div className="pointer-events-none fixed right-4 bottom-12 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
      {toasts.map((toast) => {
        const Icon = ICONS[toast.kind]
        return (
          <div
            key={toast.id}
            role="status"
            className="lm-fade-in pointer-events-auto flex items-start gap-2.5 rounded-[12px] border border-border bg-surface px-3.5 py-2.5 shadow-[var(--shadow-pop)]"
          >
            <Icon className={cn('mt-0.5 size-4 shrink-0', TONES[toast.kind])} />
            <div className="min-w-0 flex-1">
              <p className="text-xs leading-snug break-words text-fg">{toast.message}</p>
              {toast.detail ? (
                <p className="mt-0.5 text-[11px] leading-snug break-words text-fg-subtle">{toast.detail}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="shrink-0 rounded p-0.5 text-fg-subtle transition-colors hover:text-fg"
              aria-label="Dismiss"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
