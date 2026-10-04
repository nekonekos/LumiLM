import { useEffect, useState, type ReactNode } from 'react'
import { BookmarkPlus, Check, Trash2, Wand2 } from 'lucide-react'
import type { PromptPreset } from '@shared/types'
import { Button, EmptyHint, Field, IconButton, TextArea, TextInput } from '@/components/ui'
import { useT } from '@/i18n'
import { useChatStore } from '@/stores/chat'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

/**
 * System prompt editor plus a user-owned preset library. LumiLM ships with no
 * preset prompts at all: the list is empty until the user saves one.
 *
 * The component is keyed by conversation id, so the draft always starts from
 * the prompt of the conversation it was mounted for.
 */
export function SystemPanel(): ReactNode {
  const t = useT()
  const locale = useSettingsStore((state) => state.settings?.general.locale ?? 'zh-CN')
  const conversation = useChatStore((state) => state.conversation)
  const saveCurrent = useChatStore((state) => state.saveCurrent)
  const pushToast = useUiStore((state) => state.pushToast)

  const [draft, setDraft] = useState(conversation?.systemPrompt ?? '')
  const [presets, setPresets] = useState<PromptPreset[]>([])
  const [presetName, setPresetName] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.lumilm.presets.list().then((list) => {
      if (!cancelled) setPresets(list)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const commit = (): void => {
    if (!conversation) return
    if (draft === conversation.systemPrompt) return
    void saveCurrent({ systemPrompt: draft })
  }

  const savePreset = async (): Promise<void> => {
    const name = presetName.trim()
    if (name.length === 0) return
    const now = Date.now()
    const preset: PromptPreset = {
      id: `preset-${now.toString(36)}`,
      name,
      description: '',
      systemPrompt: draft,
      sampling: conversation?.sampling ?? null,
      createdAt: now,
      updatedAt: now
    }
    setPresets(await window.lumilm.presets.save(preset))
    setPresetName('')
    setCreating(false)
    pushToast({ kind: 'success', message: t('preset.create') })
  }

  const applyPreset = (preset: PromptPreset): void => {
    if (!conversation) return
    setDraft(preset.systemPrompt)
    void saveCurrent({
      systemPrompt: preset.systemPrompt,
      ...(preset.sampling ? { sampling: { ...conversation.sampling, ...preset.sampling } } : {})
    })
  }

  const removePreset = async (id: string): Promise<void> => {
    setPresets(await window.lumilm.presets.remove(id))
  }

  return (
    <div className="flex flex-col gap-4">
      <Field label={t('params.systemPrompt')} hint={t('params.systemPromptHint')}>
        <TextArea
          rows={8}
          value={draft}
          disabled={!conversation}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          placeholder={t('params.systemPromptHint')}
        />
      </Field>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" className="flex-1 justify-center" disabled={!conversation} onClick={commit}>
          <Check className="size-3.5" />
          {t('common.save')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="flex-1 justify-center"
          disabled={!conversation}
          onClick={() => setCreating((value) => !value)}
        >
          <BookmarkPlus className="size-3.5" />
          {t('preset.create')}
        </Button>
      </div>

      {creating ? (
        <div className="flex items-end gap-2">
          <Field label={t('preset.name')} className="flex-1">
            <TextInput
              autoFocus
              value={presetName}
              onChange={(event) => setPresetName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void savePreset()
              }}
            />
          </Field>
          <Button size="sm" variant="primary" onClick={() => void savePreset()}>
            {t('common.save')}
          </Button>
        </div>
      ) : null}

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Wand2 className="size-3.5 text-brand" />
          <span className="text-xs font-semibold text-fg">{t('preset.title')}</span>
        </div>
        <p className="text-[11px] leading-snug text-fg-subtle">{t('preset.subtitle')}</p>

        {presets.length === 0 ? (
          <EmptyHint>{t('preset.empty')}</EmptyHint>
        ) : (
          <ul className="flex flex-col gap-1">
            {presets.map((preset) => (
              <li
                key={preset.id}
                className="group flex items-center gap-2 rounded-[9px] border border-border bg-surface-2 px-2 py-1.5"
              >
                <button
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className="min-w-0 flex-1 text-left"
                  title={preset.systemPrompt.slice(0, 200)}
                >
                  <span className="block truncate text-xs font-medium text-fg">{preset.name}</span>
                  <span className="block truncate text-[10px] text-fg-subtle">
                    {new Date(preset.updatedAt).toLocaleDateString(locale)}
                  </span>
                </button>
                <IconButton
                  label={t('common.delete')}
                  className="size-6 opacity-0 group-hover:opacity-100"
                  onClick={() => void removePreset(preset.id)}
                >
                  <Trash2 className="size-3.5" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
