import { BrowserWindow, dialog, shell } from 'electron'
import { dirname } from 'node:path'
import { CH } from '@shared/channels'
import type { McpPromptInfo, McpRuntimeInfo, McpServerConfig, McpServerState, McpToolInfo } from '@shared/types'
import { logger, toError } from '../util/logger'
import { mcpManager } from '../mcp/manager'
import { readConfigFile, slugifyId } from '../mcp/config'
import { detectRuntimeInfo } from '../mcp/runtime'
import { registerHandler } from './register'

const MAX_SERVERS = 64

function sanitizeConfig(input: McpServerConfig): McpServerConfig {
  if (!input || typeof input !== 'object') throw new Error('INVALID_CONFIG')

  const id = slugifyId(typeof input.id === 'string' && input.id ? input.id : input.name ?? 'server')
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : id
  const transport =
    input.transport === 'http' || input.transport === 'sse' ? input.transport : 'stdio'
  const command = typeof input.command === 'string' ? input.command.trim() : ''
  const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : null

  if (transport === 'stdio' && command.length === 0) throw new Error('COMMAND_REQUIRED')
  if (transport !== 'stdio' && url === null) throw new Error('URL_REQUIRED')
  if (url !== null && !/^https?:\/\//i.test(url)) throw new Error('INVALID_URL')

  const args = Array.isArray(input.args)
    ? input.args.filter((entry): entry is string => typeof entry === 'string')
    : []
  const toRecord = (value: unknown): Record<string, string> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    const result: Record<string, string> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === 'string') result[key] = entry
    }
    return result
  }

  return {
    id,
    name,
    transport,
    command,
    args,
    env: toRecord(input.env),
    cwd: typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : null,
    url,
    headers: toRecord(input.headers),
    enabled: input.enabled !== false,
    autoConnect: input.autoConnect !== false,
    toolAllowlist: Array.isArray(input.toolAllowlist)
      ? input.toolAllowlist.filter((entry): entry is string => typeof entry === 'string')
      : [],
    toolDenylist: Array.isArray(input.toolDenylist)
      ? input.toolDenylist.filter((entry): entry is string => typeof entry === 'string')
      : [],
    // Trust is granted through the confirmation dialog, never through the payload.
    trusted: input.trusted === true
  }
}

export function registerMcpHandlers(): void {
  registerHandler(CH.mcp.list, (): McpServerState[] => mcpManager.listStates())

  registerHandler(CH.mcp.configs, (): McpServerConfig[] => mcpManager.listConfigs())

  registerHandler(CH.mcp.runtime, (): McpRuntimeInfo => detectRuntimeInfo())

  registerHandler(CH.mcp.detectRuntime, (): McpRuntimeInfo => detectRuntimeInfo(true))

  registerHandler(CH.mcp.tools, (): McpToolInfo[] => mcpManager.listTools())

  registerHandler(CH.mcp.prompts, (): McpPromptInfo[] => mcpManager.listPrompts())

  registerHandler(CH.mcp.save, (_event, config: McpServerConfig): McpServerState[] => {
    if (mcpManager.listConfigs().length >= MAX_SERVERS) throw new Error('TOO_MANY_SERVERS')
    mcpManager.saveConfig(sanitizeConfig(config))
    return mcpManager.listStates()
  })

  registerHandler(CH.mcp.remove, (_event, id: string): McpServerState[] => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('INVALID_REQUEST')
    mcpManager.removeConfig(id)
    return mcpManager.listStates()
  })

  registerHandler(CH.mcp.connect, async (_event, id: string): Promise<McpServerState[]> => {
    if (typeof id !== 'string') throw new Error('INVALID_REQUEST')
    await mcpManager.connect(id)
    return mcpManager.listStates()
  })

  registerHandler(CH.mcp.disconnect, async (_event, id: string): Promise<McpServerState[]> => {
    if (typeof id !== 'string') throw new Error('INVALID_REQUEST')
    await mcpManager.disconnect(id)
    return mcpManager.listStates()
  })

  registerHandler(CH.mcp.restart, async (_event, id: string): Promise<McpServerState[]> => {
    if (typeof id !== 'string') throw new Error('INVALID_REQUEST')
    await mcpManager.restart(id)
    return mcpManager.listStates()
  })

  registerHandler(
    CH.mcp.getPrompt,
    async (_event, serverId: string, name: string, args: Record<string, string>): Promise<string | null> => {
      if (typeof serverId !== 'string' || typeof name !== 'string') throw new Error('INVALID_REQUEST')
      const safeArgs: Record<string, string> = {}
      if (args && typeof args === 'object') {
        for (const [key, value] of Object.entries(args)) {
          if (typeof value === 'string') safeArgs[key] = value
        }
      }
      try {
        return await mcpManager.getPrompt(serverId, name, safeArgs)
      } catch (error) {
        logger.warn('mcp', `prompt ${serverId}/${name} failed: ${toError(error).message}`)
        return null
      }
    }
  )

  registerHandler(CH.mcp.importConfig, async (event): Promise<McpServerConfig[] | null> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(window as BrowserWindow, {
      title: 'Import MCP servers',
      properties: ['openFile'],
      defaultPath: dirname(mcpManager.configPath()),
      filters: [{ name: 'MCP configuration', extensions: ['json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null

    try {
      const parsed = readConfigFile(result.filePaths[0] ?? '')
      if (parsed.servers.length === 0) throw new Error('NO_SERVERS_IN_FILE')
      // Imported servers are handed back for review; nothing is saved or start
      // until the user confirms each one.
      return parsed.servers.map((server) => ({ ...server, enabled: false, autoConnect: false }))
    } catch (error) {
      logger.warn('mcp', `import failed: ${toError(error).message}`)
      throw new Error(toError(error).message, { cause: error })
    }
  })

  registerHandler(CH.mcp.revealConfig, (): void => {
    shell.showItemInFolder(mcpManager.configPath())
  })
}
