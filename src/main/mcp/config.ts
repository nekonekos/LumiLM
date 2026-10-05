import { existsSync, readFileSync } from 'node:fs'
import type { McpServerConfig } from '@shared/types'
import { readJsonSync, writeJsonAtomicSync } from '../util/atomic-json'
import { logger } from '../util/logger'
import { getPaths } from '../store/paths'
import { parseMcpConfig, type ParsedMcpConfig } from './parse'

export { parseMcpConfig, parseServerEntry, slugifyId } from './parse'
export type { ParsedMcpConfig } from './parse'

export function readServers(): McpServerConfig[] {
  const file = getPaths().mcpConfigFile
  if (!existsSync(file)) return []
  try {
    return parseMcpConfig(readJsonSync<unknown>(file)).servers
  } catch (error) {
    logger.warn('mcp', `failed to read mcp.json: ${String(error)}`)
    return []
  }
}

/** Writes LumiLM's extended shape, which Claude Desktop and VS Code ignore gracefully. */
export function writeServers(servers: McpServerConfig[]): void {
  const map: Record<string, unknown> = {}
  for (const server of servers) {
    map[server.id] = {
      id: server.id,
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: server.cwd,
      url: server.url,
      headers: server.headers,
      enabled: server.enabled,
      autoConnect: server.autoConnect,
      toolAllowlist: server.toolAllowlist,
      toolDenylist: server.toolDenylist,
      trusted: server.trusted
    }
  }
  writeJsonAtomicSync(getPaths().mcpConfigFile, { mcpServers: map })
}

export function readConfigFile(path: string): ParsedMcpConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  return parseMcpConfig(raw)
}
