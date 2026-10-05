import { useState, type ReactNode } from 'react'
import { SlidersHorizontal, X } from 'lucide-react'
import { IconButton, Tabs } from '@/components/ui'
import { CompanionPanel, MemoryPanel } from './CompanionPanel'
import { ContextPanel } from './ContextPanel'
import { RuntimePanel } from './RuntimePanel'
import { SamplingPanel } from './SamplingPanel'
import { SkillsPanel } from './SkillsPanel'
import { SystemPanel } from './SystemPanel'
import { ToolsPanel } from './ToolsPanel'
import { useT } from '@/i18n'
import { useChatStore } from '@/stores/chat'
import { useUiStore } from '@/stores/ui'

type InspectorTab =
  | 'sampling'
  | 'runtime'
  | 'system'
  | 'context'
  | 'companion'
  | 'memory'
  | 'skills'
  | 'tools'

/** Right-hand panel: everything that controls how the model runs and answers. */
export function Inspector(): ReactNode {
  const t = useT()
  const toggleInspector = useUiStore((state) => state.toggleInspector)
  const conversationId = useChatStore((state) => state.conversation?.id ?? null)
  const mode = useChatStore((state) => state.conversation?.mode ?? 'chat')
  const [tab, setTab] = useState<InspectorTab>('sampling')

  // Skills and MCP only exist behind the agent loop, so showing them for plain
  // chat or a companion both overflows the strip and invites the user to
  // configure something that mode will never read.
  const tabs: Array<{ value: InspectorTab; label: string }> = [
    { value: 'sampling', label: t('params.sampling') },
    { value: 'runtime', label: t('params.runtime') },
    { value: 'system', label: t('params.promptTab') },
    { value: 'context', label: t('agent.contextTitle') }
  ]
  if (mode === 'companion') {
    tabs.push({ value: 'companion', label: t('companion.tab') })
    tabs.push({ value: 'memory', label: t('memory.tab') })
  }
  if (mode === 'agent') {
    tabs.push({ value: 'skills', label: t('skills.title') })
    tabs.push({ value: 'tools', label: t('mcp.tools') })
  }

  // Switching mode can retire the open tab; without this the panel would keep
  // rendering a section whose button is gone.
  const active = tabs.some((entry) => entry.value === tab) ? tab : 'sampling'

  return (
    <aside className="flex h-full w-[330px] shrink-0 flex-col border-l border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <SlidersHorizontal className="size-3.5 text-brand" />
        <span className="flex-1 text-xs font-semibold text-fg">{t('params.title')}</span>
        <IconButton label={t('common.close')} onClick={toggleInspector} className="size-7">
          <X className="size-3.5" />
        </IconButton>
      </header>

      <div className="border-b border-border p-3">
        <Tabs<InspectorTab> value={active} onChange={setTab} tabs={tabs} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
        {active === 'sampling' ? <SamplingPanel /> : null}
        {active === 'runtime' ? <RuntimePanel /> : null}
        {active === 'system' ? <SystemPanel key={conversationId ?? 'none'} /> : null}
        {active === 'context' ? <ContextPanel key={conversationId ?? 'none'} /> : null}
        {active === 'companion' ? <CompanionPanel key={conversationId ?? 'none'} /> : null}
        {active === 'memory' ? <MemoryPanel key={conversationId ?? 'none'} /> : null}
        {active === 'skills' ? <SkillsPanel /> : null}
        {active === 'tools' ? <ToolsPanel /> : null}
      </div>
    </aside>
  )
}
