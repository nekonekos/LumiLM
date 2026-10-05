import type { ReactNode } from 'react'
import { ShieldAlert } from 'lucide-react'
import { Button, Dialog } from '@/components/ui'
import { useT } from '@/i18n'
import { useAgentStore } from '@/stores/agent'

function formatArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

/**
 * Blocks the turn until the user decides. Dismissing the dialog denies the
 * call, because silently allowing third-party code to run is never acceptable.
 */
export function ApprovalDialog(): ReactNode {
  const t = useT()
  const approval = useAgentStore((state) => state.approval)
  const decide = useAgentStore((state) => state.decide)

  if (!approval) return null

  return (
    <Dialog
      open
      title={t('agent.approvalTitle')}
      onClose={() => void decide('deny')}
      footer={
        <>
          <Button variant="ghost" onClick={() => void decide('deny')}>
            {t('agent.deny')}
          </Button>
          <Button variant="secondary" onClick={() => void decide('allow-session')}>
            {t('agent.allowSession')}
          </Button>
          <Button variant="primary" onClick={() => void decide('allow')}>
            {t('agent.allow')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="rounded-[6px] bg-surface-3 px-2 py-0.5 text-[11px] text-fg-muted">
            {approval.call.serverId ?? 'builtin'}
          </span>
          <span className="font-mono text-xs text-fg">{approval.call.toolName}</span>
          <span
            className={
              approval.risk === 'destructive'
                ? 'inline-flex items-center gap-1 text-[11px] text-warning'
                : 'inline-flex items-center gap-1 text-[11px] text-fg-subtle'
            }
          >
            <ShieldAlert className="size-3" />
            {t(approval.risk === 'destructive' ? 'agent.riskDestructive' : 'agent.riskReadOnly')}
          </span>
        </div>

        <div>
          <div className="mb-1 text-[10px] tracking-wide text-fg-subtle uppercase">
            {t('agent.arguments')}
          </div>
          <pre className="max-h-64 overflow-auto rounded-[8px] bg-surface-3/70 p-2 font-mono text-[11px] whitespace-pre-wrap text-fg-muted">
            {formatArgs(approval.call.args)}
          </pre>
        </div>

        <p className="text-[11px] text-fg-subtle">
          {t('agent.approvalReason')}: {approval.reason}
        </p>
        <p className="text-[11px] text-fg-subtle">{t('agent.approvalHint')}</p>
      </div>
    </Dialog>
  )
}
