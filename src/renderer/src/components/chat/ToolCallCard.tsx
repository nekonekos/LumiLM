import { useState, type ReactNode } from 'react'
import { Check, ChevronRight, Loader2, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import type { ApprovalDecision, ToolCall, ToolCallResult, ToolRisk } from '@shared/types'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n'

interface ToolCallCardProps {
  call: ToolCall
  result: ToolCallResult | null
  /** resolved approval, when this call needed one */
  decision: ApprovalDecision | null
  /** true while the call is the one the dialog is asking about */
  awaitingApproval: boolean
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function StatusPill({ status }: { status: string }): ReactNode {
  const t = useT()
  const map = {
    running: { icon: Loader2, className: 'text-brand', spin: true, key: 'agent.statusRunning' },
    pending: { icon: ShieldAlert, className: 'text-warning', spin: false, key: 'agent.statusPending' },
    done: { icon: Check, className: 'text-success', spin: false, key: 'agent.statusDone' },
    failed: { icon: X, className: 'text-danger', spin: false, key: 'agent.statusFailed' },
    denied: { icon: ShieldAlert, className: 'text-fg-subtle', spin: false, key: 'agent.statusDenied' }
  } as const
  const entry = map[status as keyof typeof map] ?? map.running
  const Icon = entry.icon

  return (
    <span className={cn('inline-flex items-center gap-1 text-[10px]', entry.className)}>
      <Icon className={cn('size-3', entry.spin && 'animate-spin')} />
      {t(entry.key)}
    </span>
  )
}

/** Renders one tool call and whatever came back from it. */
export function ToolCallCard({
  call,
  result,
  decision,
  awaitingApproval
}: ToolCallCardProps): ReactNode {
  const t = useT()
  const [open, setOpen] = useState(false)

  const risk: ToolRisk = call.risk ?? 'destructive'
  const status =
    decision === 'deny'
      ? 'denied'
      : awaitingApproval
        ? 'pending'
        : result
          ? result.ok
            ? 'done'
            : 'failed'
          : 'running'

  return (
    <div className="mt-2 overflow-hidden rounded-[10px] border border-border bg-surface-2/60">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-surface-3/60"
      >
        <ChevronRight className={cn('size-3 shrink-0 text-fg-subtle transition-transform', open && 'rotate-90')} />
        <span className="shrink-0 rounded-[5px] bg-surface-3 px-1.5 py-0.5 text-[10px] text-fg-muted">
          {call.serverId ?? 'builtin'}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">{call.toolName}</span>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-0.5 text-[10px]',
            risk === 'destructive' ? 'text-warning' : 'text-fg-subtle'
          )}
        >
          {risk === 'destructive' ? (
            <ShieldAlert className="size-3" />
          ) : (
            <ShieldCheck className="size-3" />
          )}
          {t(risk === 'destructive' ? 'agent.riskDestructive' : 'agent.riskReadOnly')}
        </span>
        <StatusPill status={status} />
      </button>

      {open ? (
        <div className="space-y-2 border-t border-border px-2.5 py-2">
          <div>
            <div className="mb-1 text-[10px] tracking-wide text-fg-subtle uppercase">
              {t('agent.arguments')}
            </div>
            <pre className="max-h-52 overflow-auto rounded-[8px] bg-surface-3/70 p-2 font-mono text-[11px] whitespace-pre-wrap text-fg-muted">
              {formatJson(call.args)}
            </pre>
          </div>

          <div>
            <div className="mb-1 flex items-center gap-2 text-[10px] tracking-wide text-fg-subtle uppercase">
              <span>{t('agent.result')}</span>
              {result?.truncated ? (
                <span className="rounded-[4px] bg-warning/15 px-1 py-0.5 text-[9px] text-warning normal-case">
                  {t('agent.truncated')}
                </span>
              ) : null}
            </div>
            <pre className="max-h-72 overflow-auto rounded-[8px] bg-surface-3/70 p-2 font-mono text-[11px] whitespace-pre-wrap text-fg-muted">
              {result ? result.content || t('agent.noOutput') : '…'}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  )
}
