import { useEffect, useState, type ReactNode } from 'react'
import { ChevronRight, FolderOpen, RefreshCw } from 'lucide-react'
import type { SkillInfo } from '@shared/types'
import { Badge, Button, EmptyHint, IconButton } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n'
import { useAgentStore } from '@/stores/agent'
import { useChatStore } from '@/stores/chat'
import { useSkillsStore } from '@/stores/skills'

function SkillRow({
  skill,
  enabled,
  onToggle
}: {
  skill: SkillInfo
  enabled: boolean
  onToggle: () => void
}): ReactNode {
  const t = useT()
  const [open, setOpen] = useState(false)
  const invalid = skill.error !== null

  return (
    <div className="overflow-hidden rounded-[9px] border border-border">
      <div className="flex items-start gap-2 bg-surface-2 px-2.5 py-1.5">
        <button
          type="button"
          onClick={onToggle}
          disabled={invalid}
          title={t('skills.enableForConversation')}
          className={cn(
            'mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-[4px] border transition-colors',
            enabled ? 'border-transparent bg-brand text-brand-fg' : 'border-border-strong',
            invalid && 'cursor-not-allowed opacity-40'
          )}
        >
          {enabled ? <span className="text-[9px] leading-none">✓</span> : null}
        </button>

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex items-center gap-1.5">
            <ChevronRight
              className={cn('size-3 shrink-0 text-fg-subtle transition-transform', open && 'rotate-90')}
            />
            <span className="truncate text-[11px] text-fg">{skill.name}</span>
            <Badge tone="neutral">{skill.format}</Badge>
          </div>
          <p className="mt-0.5 line-clamp-2 pl-4.5 text-[10px] leading-snug text-fg-subtle">
            {invalid ? skill.error : skill.description}
          </p>
        </button>

        <IconButton
          label={t('skills.reveal')}
          className="size-6 shrink-0"
          onClick={() => void window.lumilm.skills.revealFile(skill.sourcePath)}
        >
          <FolderOpen className="size-3" />
        </IconButton>
      </div>

      {open ? (
        <div className="border-t border-border px-2.5 py-2">
          {skill.systemPrompt.trim().length > 0 ? (
            <pre className="max-h-60 overflow-auto rounded-[7px] bg-surface-3/60 p-2 font-mono text-[10px] whitespace-pre-wrap text-fg-muted">
              {skill.systemPrompt}
            </pre>
          ) : (
            <p className="text-[10px] text-fg-subtle">{t('skills.systemPromptMissing')}</p>
          )}
          {skill.resources.length > 0 ? (
            <p className="mt-1.5 text-[10px] text-fg-subtle">
              {t('skills.resources')}: {skill.resources.join(', ')}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Skills the current conversation may inject. Nothing is on by default. */
export function SkillsPanel(): ReactNode {
  const t = useT()
  const skills = useSkillsStore((state) => state.skills)
  const refresh = useSkillsStore((state) => state.refresh)
  const addDirectory = useSkillsStore((state) => state.addDirectory)
  const conversation = useChatStore((state) => state.conversation)
  const toggleSkill = useAgentStore((state) => state.toggleSkill)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const enabledIds = conversation?.agent.enabledSkillIds ?? []

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5">
        <span className="flex-1 text-[11px] text-fg-muted">
          {enabledIds.length > 0
            ? t('skills.enabledCount').replace('{count}', String(enabledIds.length))
            : t('skills.noneEnabled')}
        </span>
        <IconButton label={t('common.refresh')} className="size-6" onClick={() => void refresh()}>
          <RefreshCw className="size-3" />
        </IconButton>
        <Button variant="ghost" size="sm" onClick={() => void addDirectory()}>
          {t('skills.addDirectory')}
        </Button>
      </div>

      {skills.length === 0 ? (
        <EmptyHint>
          {t('skills.empty')} {t('skills.emptyHint')}
        </EmptyHint>
      ) : (
        <div className="flex flex-col gap-1.5">
          {skills.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              enabled={enabledIds.includes(skill.id)}
              onToggle={() => void toggleSkill(skill.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
