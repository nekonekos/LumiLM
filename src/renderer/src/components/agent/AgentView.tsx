import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Brain, ChevronRight, Sparkles, Wrench } from 'lucide-react'
import type { AgentThinking, ApprovalDecision, MessageStats } from '@shared/types'
import { Button } from '@/components/ui'
import { Composer } from '@/components/chat/Composer'
import { MarkdownView } from '@/components/chat/MarkdownView'
import { ToolCallCard } from '@/components/chat/ToolCallCard'
import { ApprovalDialog } from '@/components/agent/ApprovalDialog'
import { applyLiveBlock, groupAgentTurns, type AgentBlock } from '@/lib/agent-blocks'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n'
import { useAgentSession } from '@/stores/agent-session'
import { useAgentStore } from '@/stores/agent'
import { useChatStore } from '@/stores/chat'
import { useModelsStore } from '@/stores/models'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

const THINKING_LEVELS: AgentThinking[] = ['unlimited', 'brief', 'minimal']

function StatsLine({ stats }: { stats?: MessageStats }): ReactNode {
  const t = useT()
  if (!stats) return null
  const parts: string[] = []
  if (stats.tokensPerSecond) parts.push(`${stats.tokensPerSecond.toFixed(1)} tok/s`)
  if (stats.completionTokens) parts.push(`${t('metrics.generated')} ${stats.completionTokens}`)
  if (parts.length === 0) return null
  return <p className="mt-1 text-[10px] text-fg-subtle tabular-nums">{parts.join(' · ')}</p>
}

function Reasoning({ text }: { text: string }): ReactNode {
  const t = useT()
  return (
    <details className="mt-1 rounded-[8px] border border-border bg-surface-2/60 px-2.5 py-1.5">
      <summary className="flex cursor-pointer items-center gap-1 text-[10px] font-medium text-fg-subtle select-none">
        <Brain className="size-3" />
        {t('chat.reasoning')}
      </summary>
      <p className="mt-1.5 text-[11px] leading-relaxed whitespace-pre-wrap text-fg-muted">{text}</p>
    </details>
  )
}

/** One assistant step: what it thought, what it said, what it asked for. */
function Block({
  block,
  decisions,
  awaitingApproval,
  showReasoning
}: {
  block: AgentBlock
  decisions: Record<string, ApprovalDecision>
  awaitingApproval: string | null
  showReasoning: boolean
}): ReactNode {
  const t = useT()
  return (
    <div className="flex flex-col gap-1">
      {showReasoning && block.reasoning.length > 0 ? <Reasoning text={block.reasoning} /> : null}

      {block.content.length > 0 ? <MarkdownView content={block.content} /> : null}

      {block.toolCalls.length > 0 ? (
        <div className="mt-1 flex flex-col gap-1.5">
          <span className="flex items-center gap-1 text-[10px] font-medium tracking-wide text-fg-subtle uppercase">
            <Wrench className="size-3" />
            {block.toolCalls.length}
          </span>
          {block.toolCalls.map((call) => (
            <ToolCallCard
              key={call.id}
              call={call}
              result={block.results[call.id] ?? null}
              decision={decisions[call.id] ?? null}
              awaitingApproval={awaitingApproval === call.id}
            />
          ))}
        </div>
      ) : null}

      {block.error ? <p className="text-[11px] leading-snug text-danger">{block.error}</p> : null}
      {block.stopped ? <p className="text-[11px] text-fg-subtle">{t('chat.stopped')}</p> : null}

      <StatsLine stats={block.stats} />
    </div>
  )
}

/** Toolbar row: the thinking level, which is a launch argument. */
function ThinkingSwitch(): ReactNode {
  const t = useT()
  const conversation = useChatStore((state) => state.conversation)
  const fallback = useSettingsStore((state) => state.settings?.agent.thinking ?? 'unlimited')
  const setThinking = useAgentStore((state) => state.setThinking)
  const current = conversation?.agent.thinking ?? fallback

  return (
    <div className="flex items-center gap-1.5">
      <span className="flex items-center gap-1 text-[10px] text-fg-subtle">
        <Brain className="size-3" />
        {t('agent.thinking')}
      </span>
      <div className="flex overflow-hidden rounded-[7px] border border-border">
        {THINKING_LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            onClick={() => void setThinking(level)}
            title={t('agent.thinkingHint')}
            className={cn(
              'px-1.5 py-0.5 text-[10px] transition-colors',
              current === level
                ? 'bg-brand text-brand-fg'
                : 'bg-surface-3 text-fg-subtle hover:text-fg'
            )}
          >
            {t(`agent.thinking.${level}` as 'agent.thinking.unlimited')}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * The agent transcript: every request followed by the steps the agent took for
 * it, as separate blocks. Deliberately not the chat bubble list — an agent turn
 * is a sequence of steps, not one message with extra chrome.
 */
export function AgentView(): ReactNode {
  const t = useT()
  const conversation = useChatStore((state) => state.conversation)
  const createConversation = useChatStore((state) => state.create)
  const models = useModelsStore((state) => state.models)
  const openSettings = useUiStore((state) => state.openSettings)
  const showReasoning = useSettingsStore((state) => state.settings?.appearance.showReasoning ?? true)

  const live = useAgentSession((state) => state.stream)
  const results = useAgentSession((state) => state.results)
  const decisions = useAgentSession((state) => state.decisions)
  const approvals = useAgentSession((state) => state.approvals)

  const scrollRef = useRef<HTMLDivElement>(null)

  const turns = useMemo(() => {
    const grouped = groupAgentTurns(conversation?.messages ?? [])
    if (!live) return grouped
    const block: AgentBlock = {
      id: live.blockId,
      content: live.content,
      reasoning: live.reasoning,
      toolCalls: live.toolCalls,
      results,
      streaming: true
    }
    return applyLiveBlock(grouped, block)
  }, [conversation, live, results])

  const awaiting = Object.values(approvals)[0]?.callId ?? null

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    if (distance < 120) element.scrollTo({ top: element.scrollHeight })
  }, [turns, live?.content, live?.reasoning])

  const hasModel = models.length > 0
  const isEmpty = turns.length === 0

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-4">
          {isEmpty ? (
            <div className="flex min-h-[46vh] flex-col items-center justify-center gap-3 text-center">
              <span className="grid size-11 place-items-center rounded-[14px] bg-brand-soft text-brand">
                <Sparkles className="size-5" />
              </span>
              <h2 className="text-base font-semibold text-fg">
                {t(hasModel ? 'agent.emptyTitle' : 'chat.emptyNoModel')}
              </h2>
              <p className="max-w-md text-xs leading-relaxed text-fg-muted">
                {t(hasModel ? 'agent.emptyBody' : 'onboard.noModelFound')}
              </p>
              {hasModel ? (
                <Button variant="ghost" onClick={() => void createConversation()}>
                  {t('nav.newChat')}
                </Button>
              ) : (
                <Button variant="primary" onClick={() => openSettings('models')}>
                  {t('chat.addModel')}
                </Button>
              )}
            </div>
          ) : (
            turns.map((turn) => (
              <section key={turn.id} className="flex flex-col gap-3">
                {turn.prompt ? (
                  <div className="flex items-start gap-2">
                    <ChevronRight className="mt-1 size-3.5 shrink-0 text-brand" />
                    <p className="text-sm leading-relaxed font-medium whitespace-pre-wrap text-fg">
                      {turn.prompt.content}
                    </p>
                  </div>
                ) : null}

                <div className="flex flex-col gap-3 border-l border-border pl-3.5">
                  {turn.blocks.map((block) => (
                    <Block
                      key={block.id}
                      block={block}
                      decisions={decisions}
                      awaitingApproval={awaiting}
                      showReasoning={showReasoning}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl px-4">
        <div className="flex items-center justify-end pb-1.5">
          <ThinkingSwitch />
        </div>
      </div>

      <Composer />
      <ApprovalDialog />
    </div>
  )
}
