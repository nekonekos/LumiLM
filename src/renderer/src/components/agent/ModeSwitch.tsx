import type { ReactNode } from 'react'
import { Bot, Heart, MessageSquare } from 'lucide-react'
import type { AgentPermission } from '@shared/types'
import { Select } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useT, type MessageKey } from '@/i18n'
import { useAgentStore } from '@/stores/agent'
import { useChatStore } from '@/stores/chat'
import { useSettingsStore } from '@/stores/settings'

const PERMISSIONS: AgentPermission[] = ['ask-all', 'ask-risky', 'auto']

const PERMISSION_LABELS: Record<AgentPermission, MessageKey> = {
  'ask-all': 'agent.permissionAskAll',
  'ask-risky': 'agent.permissionAskRisky',
  auto: 'agent.permissionAuto'
}

const PERMISSION_HINTS: Record<AgentPermission, MessageKey> = {
  'ask-all': 'agent.permissionAskAllHint',
  'ask-risky': 'agent.permissionAskRiskyHint',
  auto: 'agent.permissionAutoHint'
}

/**
 * The per-conversation switch between plain chat and the tool-calling agent.
 * Chat mode is the default and keeps LumiLM's "no injected prompt" promise.
 */
export function ModeSwitch(): ReactNode {
  const t = useT()
  const conversation = useChatStore((state) => state.conversation)
  const setMode = useAgentStore((state) => state.setMode)
  const setPermission = useAgentStore((state) => state.setPermission)
  const settingMode = useSettingsStore((state) => state.settings?.agent.defaultMode)
  const settingPermission = useSettingsStore((state) => state.settings?.agent.permission)

  // With no conversation open these controls edit the defaults for the next
  // chat rather than being disabled, which used to block the switch entirely.
  const mode = conversation?.mode ?? settingMode ?? 'chat'
  const permission = conversation?.agent.permission ?? settingPermission ?? 'ask-risky'

  return (
    <div className="flex items-center gap-2">
      <div
        className="inline-flex items-center rounded-[8px] border border-border bg-surface-2 p-0.5"
        role="radiogroup"
        aria-label={t('agent.mode')}
      >
        {(['chat', 'agent', 'companion'] as const).map((value) => {
          const active = mode === value
            const Icon = value === 'chat' ? MessageSquare : value === 'agent' ? Bot : Heart
            const label =
              value === 'chat' ? 'agent.modeChat' : value === 'agent' ? 'agent.modeAgent' : 'companion.mode'
            const hint =
              value === 'chat'
                ? 'agent.modeChatHint'
                : value === 'agent'
                  ? 'agent.modeAgentHint'
                  : 'companion.modeHint'
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                title={t(hint)}
                onClick={() => void setMode(value)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[11px] transition-colors',
                  active ? 'bg-brand text-brand-fg' : 'text-fg-muted hover:text-fg'
                )}
              >
                <Icon className="size-3" />
                {t(label)}
              </button>
            )
          })}
        </div>

      {mode === 'agent' ? (
        <span title={t(PERMISSION_HINTS[permission])} className="inline-flex">
          <Select<AgentPermission>
            value={permission}
            options={PERMISSIONS.map((value) => ({
              value,
              label: t(PERMISSION_LABELS[value])
            }))}
            onChange={(value) => void setPermission(value)}
            className="w-32"
          />
        </span>
      ) : null}
    </div>
  )
}
