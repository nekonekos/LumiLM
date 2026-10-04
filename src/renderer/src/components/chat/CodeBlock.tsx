import { useCallback, useState, type ReactNode } from 'react'
import { Check, Copy, Download, WrapText } from 'lucide-react'
import { IconButton } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n'

export function CodeBlock({
  language,
  code,
  children
}: {
  language: string
  code: string
  children: ReactNode
}): ReactNode {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const [wrap, setWrap] = useState(false)

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable */
    }
  }, [code])

  const save = useCallback(() => {
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `snippet.${language || 'txt'}`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [code, language])

  return (
    <div className="group/code my-3 overflow-hidden rounded-[12px] border border-border bg-surface-2">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-surface-3 px-3 py-1.5">
        <span className="font-mono text-[11px] tracking-wide text-fg-subtle lowercase">
          {language || 'text'}
        </span>
        <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/code:opacity-100 focus-within:opacity-100">
          <IconButton label={t('common.copy')} className="size-6" onClick={() => void copy()}>
            {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
          </IconButton>
          <IconButton label={t('common.save')} className="size-6" onClick={save}>
            <Download className="size-3.5" />
          </IconButton>
          <IconButton
            label="Wrap"
            className="size-6"
            active={wrap}
            onClick={() => setWrap((value) => !value)}
          >
            <WrapText className="size-3.5" />
          </IconButton>
        </span>
      </div>
      <pre
        className={cn(
          'overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-relaxed',
          wrap && 'whitespace-pre-wrap break-words'
        )}
      >
        {children}
      </pre>
    </div>
  )
}
