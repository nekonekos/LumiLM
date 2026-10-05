import type { AgentPermission, ApprovalDecision, ToolCall, ToolPermission, ToolRisk } from '@shared/types'
import { logger } from '../util/logger'

/** How long the main process waits for a click before refusing on the user's behalf. */
const APPROVAL_TIMEOUT_MS = 15_000

/**
 * Combines the configured override, the conversation's policy and the tool's
 * risk into a single decision.
 */
export function decidePermission(
  policy: AgentPermission,
  risk: ToolRisk,
  override: ToolPermission | null
): 'allow' | 'ask' | 'deny' {
  if (override === 'allow') return 'allow'
  if (override === 'deny') return 'deny'
  // An explicit "ask" only forces a prompt where the policy would allow.
  if (override === 'ask') return 'ask'

  if (policy === 'auto') return 'allow'
  if (policy === 'ask-all') return 'ask'
  return risk === 'destructive' ? 'ask' : 'allow'
}

/** Key used for both the settings map and the in-memory session grant. */
export function toolKey(call: Pick<ToolCall, 'serverId' | 'toolName'>): string {
  return `${call.serverId ?? 'builtin'}::${call.toolName}`
}

export function configPermissionFor(
  permissions: Record<string, ToolPermission>,
  call: Pick<ToolCall, 'serverId' | 'toolName'>
): ToolPermission | null {
  return permissions[toolKey(call)] ?? null
}

/**
 * Tracks approvals that are waiting on the renderer. Grants given with
 * "always allow" live only in memory, so a new session always asks again.
 */
class ApprovalBroker {
  private waiters = new Map<string, (decision: ApprovalDecision) => void>()
  private timers = new Map<string, NodeJS.Timeout>()
  private sessionAllowed = new Set<string>()

  /** "Always allow" is scoped to the running app, never persisted. */
  rememberForSession(call: Pick<ToolCall, 'serverId' | 'toolName'>): void {
    this.sessionAllowed.add(toolKey(call))
  }

  isSessionAllowed(call: Pick<ToolCall, 'serverId' | 'toolName'>): boolean {
    return this.sessionAllowed.has(toolKey(call))
  }

  clearSession(): void {
    this.sessionAllowed.clear()
  }

  /** Resolves to `deny` when the user never answers. */
  await(streamId: string, callId: string): Promise<ApprovalDecision> {
    const key = waiterKey(streamId, callId)
    return new Promise<ApprovalDecision>((resolve) => {
      this.waiters.set(key, resolve)
      const timer = setTimeout(() => {
        logger.warn('agent', `approval timed out for ${key}, denying`)
        this.settle(streamId, callId, 'deny')
      }, APPROVAL_TIMEOUT_MS)
      timer.unref()
      this.timers.set(key, timer)
    })
  }

  resolve(streamId: string, callId: string, decision: ApprovalDecision): void {
    if (decision === 'allow-session') {
      this.settle(streamId, callId, 'allow-session')
      return
    }
    this.settle(streamId, callId, decision)
  }

  /** Called on abort and on window teardown so nothing is left dangling. */
  denyPending(streamId: string): void {
    for (const key of [...this.waiters.keys()]) {
      if (key.startsWith(`${streamId}::`)) {
        const callId = key.slice(streamId.length + 2)
        this.settle(streamId, callId, 'deny')
      }
    }
  }

  private settle(streamId: string, callId: string, decision: ApprovalDecision): void {
    const key = waiterKey(streamId, callId)
    const waiter = this.waiters.get(key)
    const timer = this.timers.get(key)
    if (timer) clearTimeout(timer)
    this.timers.delete(key)
    this.waiters.delete(key)
    waiter?.(decision)
  }
}

function waiterKey(streamId: string, callId: string): string {
  return `${streamId}::${callId}`
}

export const approvalBroker = new ApprovalBroker()
