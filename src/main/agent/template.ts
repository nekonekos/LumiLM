/**
 * Minimal templating for the agent preamble.
 *
 * Supports `{{name}}` substitution plus `{{#name}} … {{/name}}` sections that
 * disappear entirely when the value is empty. Users edit this template in
 * Settings → Agent, so it stays deliberately small and predictable rather than
 * becoming a general purpose template engine.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  const withoutSections = template.replace(
    /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_match, name: string, body: string) => {
      const value = vars[name]
      if (value === undefined || value.trim().length === 0) return ''
      return body
    }
  )

  const substituted = withoutSections.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = vars[name]
    return value ?? ''
  })

  // Removed sections leave blank lines behind; keep the result tidy.
  return substituted.replace(/\n{3,}/g, '\n\n').trim()
}
