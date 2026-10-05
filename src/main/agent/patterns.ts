/**
 * Glob matching for the `allowed-tools` list a skill can declare, e.g.
 * `mcp__filesystem__*`. Kept separate so it stays free of Electron imports and
 * can be unit tested directly.
 */
export function matchesPattern(pattern: string, name: string): boolean {
  if (pattern === name) return true
  if (!pattern.includes('*')) return false

  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')

  return new RegExp(`^${escaped}$`).test(name)
}
