import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Copy, Download, Trash2 } from 'lucide-react'
import { Button, Dialog, EmptyHint, Switch } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n'
import { useUiStore } from '@/stores/ui'

function toneFor(line: string): string {
  const lower = line.toLowerCase()
  if (lower.includes('error') || lower.includes('failed') || lower.includes('oom')) return 'text-danger'
  if (lower.includes('warn')) return 'text-warning'
  if (lower.includes('load') || lower.includes('listening')) return 'text-success'
  return 'text-fg-muted'
}

/** Live view of the llama-server stdout/stderr ring buffer. */
export function LogViewer(): ReactNode {
  const t = useT()
  const open = useUiStore((state) => state.logsOpen)
  const setOpen = useUiStore((state) => state.setLogsOpen)
  const logs = useUiStore((state) => state.logs)
  const setLogs = useUiStore((state) => state.setLogs)

  const [autoScroll, setAutoScroll] = useState(true)
  const [copied, setCopied] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Pull whatever the main process already buffered when the panel opens.
  useEffect(() => {
    if (!open) return
    void window.lumilm.server.logs().then((existing) => {
      if (existing.length > 0) setLogs(existing)
    })
  }, [open, setLogs])

  useEffect(() => {
    if (open && autoScroll) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [logs, open, autoScroll])

  const copyAll = async (): Promise<void> => {
    await navigator.clipboard.writeText(logs.join('\n'))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title={t('logs.title')}
      width="max-w-4xl"
      footer={
        <>
          <span className="mr-auto flex items-center gap-2 text-[11px] text-fg-subtle">
            <Switch checked={autoScroll} onChange={setAutoScroll} label={t('logs.autoScroll')} />
            {t('logs.autoScroll')}
          </span>
          <Button variant="ghost" onClick={() => void copyAll()}>
            <Copy className="size-3.5" />
            {copied ? t('common.copied') : t('common.copy')}
          </Button>
          <Button variant="ghost" onClick={() => void window.lumilm.server.clearLogs().then(() => setLogs([]))}>
            <Trash2 className="size-3.5" />
            {t('settings.clearLogs')}
          </Button>
          <Button
            variant="ghost"
            onClick={() => void window.lumilm.app.exportDiagnostics()}
          >
            <Download className="size-3.5" />
            {t('settings.exportDiagnostics')}
          </Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      {logs.length === 0 ? (
        <EmptyHint>{t('logs.empty')}</EmptyHint>
      ) : (
        <div className="max-h-[58vh] overflow-auto rounded-[10px] border border-border bg-surface-2 p-2 font-mono text-[11px] leading-relaxed">
          {logs.map((line, index) => (
            <div key={`${index}-${line.slice(0, 12)}`} className={cn('whitespace-pre-wrap', toneFor(line))}>
              {line}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </Dialog>
  )
}
