import { memo, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import { useCodeFromChildren } from '@/lib/code-text'
import { CodeBlock } from './CodeBlock'

interface CodeElementProps {
  className?: string
  children?: ReactNode
}

function PreBlock({ children }: { children?: ReactNode }): ReactNode {
  const code = useCodeFromChildren(children)
  const child = Array.isArray(children) ? children[0] : children
  const className = (child as { props?: CodeElementProps })?.props?.className ?? ''
  const language = /language-([\w+#-]+)/.exec(className)?.[1] ?? ''

  return (
    <CodeBlock language={language} code={code}>
      {children}
    </CodeBlock>
  )
}

const COMPONENTS: Components = {
  pre: PreBlock,
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault()
        if (href && /^https?:\/\//i.test(href)) void window.lumilm.app.openExternal(href)
      }}
    >
      {children}
    </a>
  ),
  img: ({ src, alt }) => <img src={src} alt={alt ?? ''} loading="lazy" />,
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table>{children}</table>
    </div>
  )
}

const REMARK_PLUGINS = [remarkGfm, remarkMath]
const REHYPE_PLUGINS = [
  rehypeKatex,
  [rehypeHighlight, { detect: true, ignoreMissing: true }] as never
]

/**
 * Renders assistant/user markdown. Raw HTML is intentionally not enabled, so
 * model output can never inject markup into the application.
 */
export const MarkdownView = memo(function MarkdownView({ content }: { content: string }): ReactNode {
  return (
    <div className="lm-markdown">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})
