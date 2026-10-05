import type { ReactNode } from 'react'
import { FolderOpen } from 'lucide-react'
import type { AgentPermission, AgentThinking, ChatMode } from '@shared/types'
import { Button, Field, SectionTitle, Select, Slider, Switch, TextArea, TextInput } from '@/components/ui'
import { useT, type MessageKey } from '@/i18n'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

const MODE_LABELS: Record<ChatMode, MessageKey> = {
  chat: 'agent.modeChat',
  agent: 'agent.modeAgent'
}

const PERMISSION_LABELS: Record<AgentPermission, MessageKey> = {
  'ask-all': 'agent.permissionAskAll',
  'ask-risky': 'agent.permissionAskRisky',
  auto: 'agent.permissionAuto'
}

const THINKING_LEVELS: AgentThinking[] = ['unlimited', 'brief', 'minimal']

const THINKING_LABELS: Record<AgentThinking, MessageKey> = {
  unlimited: 'agent.thinking.unlimited',
  brief: 'agent.thinking.brief',
  minimal: 'agent.thinking.minimal'
}

/** Defaults and the editable prompt template for agent mode. */
export function AgentTab(): ReactNode {
  const t = useT()
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  const pushToast = useUiStore((state) => state.pushToast)

  if (!settings) return null
  const agent = settings.agent

  const pickWorkspace = async (): Promise<void> => {
    const directory = await window.lumilm.dialog.pickDirectory()
    if (!directory) return
    await update({ agent: { workspaceRoot: directory } })
    pushToast({ kind: 'success', message: directory })
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3">
        <SectionTitle>{t('settings.agent')}</SectionTitle>

        <Field label={t('settings.agentDefaultMode')}>
          <Select<ChatMode>
            value={agent.defaultMode}
            onChange={(value) => void update({ agent: { defaultMode: value } })}
            options={(['chat', 'agent'] as const).map((value) => ({
              value,
              label: t(MODE_LABELS[value])
            }))}
          />
        </Field>

        <Field label={t('settings.agentPermission')}>
          <Select<AgentPermission>
            value={agent.permission}
            onChange={(value) => void update({ agent: { permission: value } })}
            options={(['ask-all', 'ask-risky', 'auto'] as const).map((value) => ({
              value,
              label: t(PERMISSION_LABELS[value])
            }))}
          />
        </Field>

        <Field label={t('settings.agentThinking')} hint={t('agent.thinkingHint')}>
          <Select<AgentThinking>
            value={agent.thinking}
            onChange={(value) => void update({ agent: { thinking: value } })}
            options={THINKING_LEVELS.map((value) => ({
              value,
              label: t(THINKING_LABELS[value])
            }))}
          />
        </Field>

        <label className="flex flex-col gap-1.5">
          <span className="flex items-center justify-between">
            <span className="text-xs font-medium text-fg-muted">
              {t('settings.agentMaxIterations')}
            </span>
            <span className="text-[11px] tabular-nums text-fg">{agent.maxIterations}</span>
          </span>
          <Slider
            value={agent.maxIterations}
            min={1}
            max={20}
            step={1}
            onChange={(value) => void update({ agent: { maxIterations: value } })}
          />
        </label>

        <Field label={t('settings.agentMaxToolResult')}>
          <TextInput
            type="number"
            min={500}
            max={100000}
            value={agent.maxToolResultChars}
            onChange={(event) =>
              void update({ agent: { maxToolResultChars: Number(event.target.value) || 8000 } })
            }
          />
        </Field>

        <Field label={t('settings.agentToolSchemaWarn')}>
          <TextInput
            type="number"
            min={0}
            max={100000}
            value={agent.toolSchemaTokenWarn}
            onChange={(event) =>
              void update({ agent: { toolSchemaTokenWarn: Number(event.target.value) || 0 } })
            }
          />
        </Field>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>{t('settings.agentInjectPrompt')}</SectionTitle>

        <Field label={t('settings.agentInjectPrompt')} hint={t('settings.agentInjectPromptHint')}>
          <Switch
            checked={agent.injectPrompt}
            label={t('settings.agentInjectPrompt')}
            onChange={(checked) => void update({ agent: { injectPrompt: checked } })}
          />
        </Field>

        <Field label={t('settings.agentPreamble')} hint={t('settings.agentPreambleHint')}>
          <TextArea
            rows={12}
            value={agent.preambleTemplate}
            onChange={(event) => void update({ agent: { preambleTemplate: event.target.value } })}
            className="font-mono text-[11px]"
          />
        </Field>

        <Field label={t('settings.agentParseText')} hint={t('settings.agentParseTextHint')}>
          <Switch
            checked={agent.parseTextToolCalls}
            label={t('settings.agentParseText')}
            onChange={(checked) => void update({ agent: { parseTextToolCalls: checked } })}
          />
        </Field>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>{t('settings.agentBuiltinTools')}</SectionTitle>
        <p className="text-[11px] leading-snug text-fg-subtle">{t('settings.agentWorkspaceHint')}</p>

        <Field label={t('settings.agentFileTools')} hint={t('settings.agentFileToolsHint')}>
          <Switch
            checked={agent.fileToolsEnabled}
            label={t('settings.agentFileTools')}
            onChange={(checked) => void update({ agent: { fileToolsEnabled: checked } })}
          />
        </Field>

        <Field label={t('settings.agentShellTools')} hint={t('settings.agentShellToolsHint')}>
          <Switch
            checked={agent.shellToolsEnabled}
            label={t('settings.agentShellTools')}
            onChange={(checked) => void update({ agent: { shellToolsEnabled: checked } })}
          />
        </Field>

        <Field label={t('settings.agentWorkspaceRoot')}>
          <div className="flex items-center gap-2">
            <TextInput
              value={agent.workspaceRoot ?? ''}
              placeholder={t('tools.homeDir')}
              onChange={(event) => void update({ agent: { workspaceRoot: event.target.value || null } })}
            />
            <Button variant="secondary" onClick={() => void pickWorkspace()}>
              <FolderOpen className="size-3.5" />
              {t('common.browse')}
            </Button>
          </div>
        </Field>

        <p className="text-[11px] leading-snug text-fg-subtle">{t('settings.agentToolsTokenHint')}</p>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>{t('settings.agentAllowRemote')}</SectionTitle>
        <p className="text-[11px] leading-snug text-fg-subtle">
          {t('settings.agentAllowRemoteHint')}
        </p>
        <Switch
          checked={agent.allowRemoteMcp}
          label={t('settings.agentAllowRemote')}
          onChange={(checked) => void update({ agent: { allowRemoteMcp: checked } })}
        />
      </section>
    </div>
  )
}
