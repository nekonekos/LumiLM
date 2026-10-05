import { useState, type ReactNode } from 'react'
import { SlidersHorizontal, X } from 'lucide-react'
import { IconButton, Tabs } from '@/components/ui'
import { ContextPanel } from './ContextPanel'
import { RuntimePanel } from './RuntimePanel'
import { SamplingPanel } from './SamplingPanel'
import { SkillsPanel } from './SkillsPanel'
import { SystemPanel } from './SystemPanel'
import { ToolsPanel } from './ToolsPanel'
import { useT } from '@/i18n'
import { useChatStore } from '@/stores/chat'
import { useUiStore } from '@/stores/ui'

type InspectorTab = 'sampling' | 'runtime' | 'system' | 'context' | 'skills' | 'tools'

/** Right-hand panel: everything that controls how the model runs and answers. */
export function Inspector(): ReactNode {
  const t = useT()
  const toggleInspector = useUiStore((state) => state.toggleInspector)
  const conversationId = useChatStore((state) => state.conversation?.id ?? null)
  const [tab, setTab] = useState<InspectorTab>('sampling')

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
        <Tabs<InspectorTab>
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'sampling', label: t('params.sampling') },
            { value: 'runtime', label: t('params.runtime') },
            { value: 'system', label: t('params.promptTab') },
            { value: 'context', label: t('agent.contextTitle') },
            { value: 'skills', label: t('skills.title') },
            { value: 'tools', label: t('mcp.tools') }
          ]}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
        {tab === 'sampling' ? <SamplingPanel /> : null}
        {tab === 'runtime' ? <RuntimePanel /> : null}
        {tab === 'system' ? <SystemPanel key={conversationId ?? 'none'} /> : null}
        {tab === 'context' ? <ContextPanel key={conversationId ?? 'none'} /> : null}
        {tab === 'skills' ? <SkillsPanel /> : null}
        {tab === 'tools' ? <ToolsPanel /> : null}
      </div>
    </aside>
  )
}
