import { useMemo, type ReactNode } from 'react'

/** Flattens a React node tree into its plain text content. */
export function collectText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join('')
  const element = node as { props?: { children?: ReactNode } }
  if (element.props?.children !== undefined) return collectText(element.props.children)
  return ''
}

/** Raw source of a rendered `<code>` element, used by the copy button. */
export function useCodeFromChildren(children: ReactNode): string {
  return useMemo(() => collectText(children), [children])
}
