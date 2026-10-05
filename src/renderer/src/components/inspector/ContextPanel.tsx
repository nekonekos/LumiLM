import { useEffect, useState, type ReactNode } from 'react'
import type { PromptBlockInfo, PromptPreview } from '@shared/types'
import { Badge, EmptyHint, SectionTitle, Spinner, Switch } from '@/components/ui'
import { useT, type MessageKey } from '@/i18n'
import { useAgentStore } from '@/stores/agent'
import { useChatStore } from '@/stores/chat'
import { useSettingsStore } from '@/stores/settings'

const BLOCK_LABELS: Record<PromptBlockInfo['id'], MessageKey> = {
  user: 'agent.blockUser',
  preamble: 'agent.blockPreamble',
  skills: 'agent.blockSkills',
  servers: 'agent.blockServers',
  persona: 'companion.card',
  relationship: 'companion.relationship',
  memory: 'memory.facts',
  summary: 'agent.contextTitle'
}

/**
 * Shows exactly what LumiLM would send as the system message, block by block.
 * Nothing about the injection is hidden from the user.
 */
export function ContextPanel(): ReactNode {
  const t = useT()
  const conversation = useChatStore((state) => state.conversation)
  const settings = useSettingsStore((state) => state.settings)
  const [result, setResult] = useState<{ key: string; preview: PromptPreview | null } | null>(null)
  const [openBlock, setOpenBlock] = useState<string | null>(null)

  const mode = conversation?.mode ?? 'chat'
  const agent = conversation?.agent
  const companion = conversation?.companion
  const conversationId = conversation?.id
  const systemPrompt = conversation?.systemPrompt ?? ''
  const injectPrompt = agent?.injectPrompt ?? settings?.agent.injectPrompt ?? true

  // Derived loading state: a result is stale as soon as the inputs change.
  const requestKey = JSON.stringify([
    systemPrompt,
    mode,
    agent ?? null,
    companion ?? null,
    injectPrompt,
    conversationId ?? null
  ])
  const loading = result?.key !== requestKey
  const preview = result?.preview ?? null

  useEffect(() => {
    if (!conversationId) return
    let cancelled = false
    const request = { systemPrompt, mode, agent, companion, conversationId }
    // Each mode composes its own prompt, so the preview comes from the channel
    // that would actually run the turn.
    const pending =
      mode === 'companion'
        ? window.lumilm.companion.previewPrompt(request)
        : window.lumilm.agent.previewPrompt(request)

    void pending
      .then((next) => {
        if (!cancelled) setResult({ key: requestKey, preview: next })
      })
      .catch(() => {
        if (!cancelled) setResult({ key: requestKey, preview: null })
      })
    return () => {
      cancelled = true
    }
  }, [requestKey, systemPrompt, mode, agent, companion, conversationId])

  if (!conversation) {
    return <EmptyHint>{t('chat.systemPromptEmpty')}</EmptyHint>
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <SectionTitle>{t('agent.contextTitle')}</SectionTitle>
        {loading ? <Spinner className="size-3" /> : null}
      </div>

      {mode === 'chat' ? (
        <p className="rounded-[8px] bg-surface-2 px-2.5 py-2 text-[11px] leading-relaxed text-fg-muted">
          {t('agent.modeChatHint')}
        </p>
      ) : null}

      {preview?.injectionDisabled ? (
        <p className="rounded-[8px] bg-surface-2 px-2.5 py-2 text-[11px] leading-relaxed text-fg-muted">
          {t('agent.injectionDisabled')}
        </p>
      ) : null}

      {preview && preview.blocks.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {preview.blocks.map((block) => (
            <div key={block.id} className="overflow-hidden rounded-[9px] border border-border">
              <button
                type="button"
                onClick={() => setOpenBlock((current) => (current === block.id ? null : block.id))}
                className="flex w-full items-center gap-2 bg-surface-2 px-2.5 py-1.5 text-left transition-colors hover:bg-surface-3"
              >
                <span className={block.enabled ? 'text-[11px] text-fg' : 'text-[11px] text-fg-subtle'}>
                  {t(BLOCK_LABELS[block.id])}
                </span>
                <span className="flex-1" />
                {block.enabled ? (
                  <Badge tone="brand">
                    {block.tokens} {t('agent.tokens')}
                  </Badge>
                ) : (
                  <Badge tone="neutral">{t('common.none')}</Badge>
                )}
              </button>
              {openBlock === block.id && block.content.trim().length > 0 ? (
                <pre className="max-h-72 overflow-auto border-t border-border bg-surface px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap text-fg-muted">
                  {block.content}
                </pre>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {preview ? (
        <div className="flex flex-col gap-1.5 rounded-[9px] border border-border bg-surface-2 px-2.5 py-2 text-[11px]">
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">{t('agent.toolCount')}</span>
            <span className="tabular-nums text-fg">{preview.toolsCount}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">{t('agent.toolSchemaCost')}</span>
            <span className="tabular-nums text-fg">
              {preview.toolsTokens} {t('agent.tokens')}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">{t('agent.effectivePrompt')}</span>
            <span className="tabular-nums text-fg">
              {preview.totalTokens} {t('agent.tokens')}
            </span>
          </div>
        </div>
      ) : null}

      {mode === 'agent' ? (
        <div className="flex items-start justify-between gap-2 rounded-[9px] border border-border px-2.5 py-2">
          <div className="flex flex-col">
            <span className="text-[11px] text-fg">{t('settings.agentInjectPrompt')}</span>
            <span className="text-[10px] leading-snug text-fg-subtle">
              {t('settings.agentInjectPromptHint')}
            </span>
          </div>
          <Switch
            checked={injectPrompt}
            label={t('settings.agentInjectPrompt')}
            onChange={(checked) => void useAgentStore.getState().setInjectPrompt(checked)}
          />
        </div>
      ) : null}

      {preview && preview.text.trim().length > 0 ? (
        <div>
          <SectionTitle>{t('agent.effectivePrompt')}</SectionTitle>
          <pre className="mt-1.5 max-h-80 overflow-auto rounded-[9px] bg-surface-3/60 px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap text-fg-muted">
            {preview.text}
          </pre>
        </div>
      ) : null}

      {preview && preview.injection ? (
        <div>
          <SectionTitle>{t('agent.contextTitle')}</SectionTitle>
          <p className="mt-1 text-[10px] leading-snug text-fg-subtle">
            {t('memory.injectionUserSuffix')} · {preview.injectionTokens ?? 0} {t('agent.tokens')}
          </p>
          <pre className="mt-1.5 max-h-72 overflow-auto rounded-[9px] bg-surface-3/60 px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap text-fg-muted">
            {preview.injection}
          </pre>
        </div>
      ) : null}
    </div>
  )
}
