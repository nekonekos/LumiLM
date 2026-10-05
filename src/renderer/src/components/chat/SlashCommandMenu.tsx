import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Terminal } from 'lucide-react'
import type { McpPromptInfo } from '@shared/types'
import { Button, Spinner, TextInput } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n'
import { useMcpStore } from '@/stores/mcp'

interface SlashCommandMenuProps {
  /** text typed after the leading slash */
  query: string
  /** index highlighted by the keyboard, owned by the composer */
  activeIndex: number
  onInsert: (text: string) => void
  onClose: () => void
  /**
   * Lets the composer's Enter key activate the highlighted command without this
   * component having to expose its internal state.
   */
  onRegisterPick: (pick: ((index: number) => void) | null) => void
}

/**
 * Slash commands come from the connected MCP servers' `prompts/list`. Selecting
 * one renders it through `prompts/get` and drops the result into the composer —
 * it is never sent automatically.
 */
export function SlashCommandMenu({
  query,
  activeIndex,
  onInsert,
  onClose,
  onRegisterPick
}: SlashCommandMenuProps): ReactNode {
  const t = useT()
  const prompts = useMcpStore((state) => state.prompts)
  const getPrompt = useMcpStore((state) => state.getPrompt)

  const [pending, setPending] = useState<McpPromptInfo | null>(null)
  const [args, setArgs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const matches = useMemo(() => {
    const needle = query.toLowerCase()
    return prompts
      .filter((prompt) => {
        if (needle.length === 0) return true
        return (
          prompt.command.toLowerCase().includes(needle) ||
          prompt.title.toLowerCase().includes(needle) ||
          prompt.description.toLowerCase().includes(needle)
        )
      })
      .slice(0, 12)
  }, [prompts, query])

  const run = async (prompt: McpPromptInfo, values: Record<string, string>): Promise<void> => {
    setBusy(true)
    setFailed(null)
    try {
      const rendered = await getPrompt(prompt.serverId, prompt.name, values)
      if (rendered === null) {
        setFailed(t('mcp.statusError'))
        return
      }
      onInsert(rendered)
    } finally {
      setBusy(false)
    }
  }

  const failures: ReactNode = failed ? (
    <div className="text-[11px] text-danger">{failed}</div>
  ) : null

  /** Selecting a command resets the argument form, then runs or asks for args. */
  const choose = (prompt: McpPromptInfo | undefined): void => {
    if (!prompt) return
    setArgs({})
    setFailed(null)
    if (prompt.arguments.length > 0) setPending(prompt)
    else void run(prompt, {})
  }

  useEffect(() => {
    // While the argument form is open Enter belongs to the form, not the list.
    if (pending) {
      onRegisterPick(null)
      return
    }
    onRegisterPick((index) => choose(matches[index]))
    return () => onRegisterPick(null)
  })

  const title = (
    <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5 text-[10px] tracking-wide text-fg-subtle uppercase">
      <Terminal className="size-3" />
      {t('mcp.prompts')}
    </div>
  )

  if (pending) {
    const required = pending.arguments.filter((argument) => argument.required)
    const missing = required.some((argument) => (args[argument.name] ?? '').trim().length === 0)

    return (
      <div className="absolute bottom-full left-0 z-30 mb-2 w-[min(420px,100%)] overflow-hidden rounded-[12px] border border-border bg-surface shadow-[var(--shadow-soft)]">
        {title}
        <div className="space-y-2 p-2.5">
          <div className="text-[11px] text-fg-muted">{pending.title}</div>
          {pending.arguments.map((argument) => (
            <label key={argument.name} className="block">
              <span className="mb-0.5 block text-[10px] text-fg-subtle">
                {argument.name}
                {argument.required ? ' *' : ''}
              </span>
              <TextInput
                value={args[argument.name] ?? ''}
                placeholder={argument.description}
                onChange={(event) =>
                  setArgs((current) => ({ ...current, [argument.name]: event.target.value }))
                }
              />
            </label>
          ))}
          {failures}
          <div className="flex items-center justify-end gap-2 pt-0.5">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={missing}
              onClick={() => void run(pending, args)}
            >
              {t('common.apply')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (matches.length === 0) {
    return (
      <div className="absolute bottom-full left-0 z-30 mb-2 w-[min(420px,100%)] overflow-hidden rounded-[12px] border border-border bg-surface shadow-[var(--shadow-soft)]">
        {title}
        <div className="px-2.5 py-3 text-[11px] text-fg-subtle">
          {prompts.length === 0 ? t('mcp.noTools') : t('common.none')}
        </div>
      </div>
    )
  }

  return (
    <div className="absolute bottom-full left-0 z-30 mb-2 w-[min(420px,100%)] overflow-hidden rounded-[12px] border border-border bg-surface shadow-[var(--shadow-soft)]">
      {title}
      <div className="max-h-64 overflow-y-auto">
        {matches.map((prompt, index) => (
          <button
            key={`${prompt.serverId}:${prompt.name}`}
            type="button"
            onClick={() => {
              choose(prompt)
            }}
            className={cn(
              'flex w-full flex-col items-start gap-0.5 px-2.5 py-1.5 text-left transition-colors',
              index === activeIndex ? 'bg-brand-soft' : 'hover:bg-surface-2'
            )}
          >
            <span className="flex w-full items-center gap-1.5">
              <span className="font-mono text-[11px] text-fg">/{prompt.command}</span>
              <span className="shrink-0 rounded-[4px] bg-surface-3 px-1 text-[9px] text-fg-subtle">
                {prompt.serverId}
              </span>
              {busy ? <Spinner className="size-3" /> : null}
            </span>
            {prompt.description.length > 0 ? (
              <span className="line-clamp-2 text-[10px] text-fg-subtle">{prompt.description}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  )
}
