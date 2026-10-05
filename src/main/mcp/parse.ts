import type { McpServerConfig, McpTransportKind } from '@shared/types'

/**
 * Parsing lives apart from the file I/O so it stays free of Electron imports
 * and can be unit tested directly. The accepted shapes are LumiLM's own
 * `mcp.json`, Claude Desktop's config and VS Code's `.vscode/mcp.json`.
 */
function extractServerMap(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const root = raw as Record<string, unknown>
  for (const key of ['mcpServers', 'servers', 'mcp_servers']) {
    const value = root[key]
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  }
  return null
}

/** Server ids end up inside OpenAI function names, so they must stay boring. */
export function slugifyId(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return slug.length > 0 ? slug : 'server'
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function asStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') result[key] = entry
    else if (typeof entry === 'number' || typeof entry === 'boolean') result[key] = String(entry)
  }
  return result
}

function normalizeTransport(value: unknown, hasUrl: boolean): McpTransportKind {
  if (value === 'stdio' || value === 'http' || value === 'sse') return value
  return hasUrl ? 'http' : 'stdio'
}

/** Parses one server entry, filling every field so the UI never sees undefined. */
export function parseServerEntry(key: string, raw: unknown): McpServerConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const entry = raw as Record<string, unknown>

  const url = typeof entry.url === 'string' && entry.url.trim().length > 0 ? entry.url.trim() : null
  const command = typeof entry.command === 'string' ? entry.command : ''
  const transport = normalizeTransport(entry.transport ?? entry.type, url !== null)

  if (transport === 'stdio' && command.trim().length === 0) return null
  if (transport !== 'stdio' && url === null) return null

  const id =
    typeof entry.id === 'string' && entry.id.trim().length > 0 ? slugifyId(entry.id) : slugifyId(key)
  const name = typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name : key

  return {
    id,
    name,
    transport,
    command,
    args: asStringArray(entry.args),
    env: asStringRecord(entry.env),
    cwd: typeof entry.cwd === 'string' && entry.cwd.trim().length > 0 ? entry.cwd : null,
    url,
    headers: asStringRecord(entry.headers),
    enabled: entry.enabled !== false,
    autoConnect: entry.autoConnect !== false,
    toolAllowlist: asStringArray(entry.toolAllowlist),
    toolDenylist: asStringArray(entry.toolDenylist),
    // Imported servers are never trusted implicitly.
    trusted: entry.trusted === true
  }
}

export interface ParsedMcpConfig {
  servers: McpServerConfig[]
  /** entries that were present but unusable, reported verbatim to the user */
  rejected: string[]
}

export function parseMcpConfig(raw: unknown): ParsedMcpConfig {
  const map = extractServerMap(raw)
  if (!map) return { servers: [], rejected: ['config has no mcpServers/servers object'] }

  const servers: McpServerConfig[] = []
  const rejected: string[] = []
  for (const [key, entry] of Object.entries(map)) {
    const parsed = parseServerEntry(key, entry)
    if (parsed) servers.push(parsed)
    else rejected.push(key)
  }
  return { servers, rejected }
}
