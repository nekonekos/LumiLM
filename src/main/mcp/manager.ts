import { EventEmitter } from 'node:events'
import { watch, type FSWatcher } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  McpErrorCode,
  McpPromptInfo,
  McpServerConfig,
  McpServerState,
  McpToolInfo
} from '@shared/types'
import { logger, toError } from '../util/logger'
import { getPaths } from '../store/paths'
import { settingsStore } from '../store/settings'
import { readServers, writeServers } from './config'
import { detectRuntimeInfo, resolveStdioSpawn } from './runtime'
import { classifyToolRisk, normalizeToolResult } from './registry'

const RECONNECT_DELAYS_MS = [1000, 3000, 8000]
const HANDSHAKE_TIMEOUT_MS = 30_000

interface ToolPage {
  tools: Array<{
    name: string
    description?: string
    inputSchema?: unknown
    annotations?: {
      readOnlyHint?: boolean
      destructiveHint?: boolean
    }
  }>
  nextCursor?: string
}

interface PromptPage {
  prompts: Array<{
    name: string
    title?: string
    description?: string
    arguments?: Array<{ name: string; description?: string; required?: boolean }>
  }>
  nextCursor?: string
}

interface Connection {
  config: McpServerConfig
  client: Client
  transport: Transport
  toolNames: string[]
}

function emptyState(config: McpServerConfig): McpServerState {
  return {
    id: config.id,
    status: 'disconnected',
    error: null,
    errorCode: null,
    serverName: null,
    serverVersion: null,
    instructions: null,
    toolCount: 0,
    promptCount: 0,
    connectedAt: null
  }
}

/** Drops `undefined` values so the SDK receives a clean Record<string,string>. */
function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') result[key] = value
  }
  return result
}

/** Adds fixed headers to the EventSource GET that SSE uses for the stream. */
function withHeaders(headers: Record<string, string>): (url: string | URL, init?: RequestInit) => Promise<Response> {
  return (url, init) =>
    fetch(url as string, {
      ...init,
      headers: { ...((init?.headers as Record<string, string>) ?? {}), ...headers }
    })
}

/**
 * Owns every MCP client: configuration, connections, capabilities and child
 * process cleanup. One instance lives in the main process.
 */
class McpManager extends EventEmitter {
  private configs = new Map<string, McpServerConfig>()
  private states = new Map<string, McpServerState>()
  private connections = new Map<string, Connection>()
  private toolCache = new Map<string, McpToolInfo[]>()
  private promptCache = new Map<string, McpPromptInfo[]>()
  private watcher: FSWatcher | null = null
  private reloadTimer: NodeJS.Timeout | null = null
  private ignoreWatchUntil = 0
  private shuttingDown = false
  private version = '0.0.0'
  private reconnectAttempts = new Map<string, number>()

  /* ---------------------------------------------------------------- */
  /* Configuration                                                     */
  /* ---------------------------------------------------------------- */

  configPath(): string {
    return getPaths().mcpConfigFile
  }

  listConfigs(): McpServerConfig[] {
    return [...this.configs.values()]
  }

  getConfig(id: string): McpServerConfig | null {
    return this.configs.get(id) ?? null
  }

  /** Loads mcp.json and reconciles connections with it. */
  async reloadConfigs(): Promise<void> {
    const next = new Map(readServers().map((server) => [server.id, server]))

    for (const id of [...this.configs.keys()]) {
      const incoming = next.get(id)
      if (!incoming) {
        // Removed from the file while the app was running.
        await this.disconnect(id)
        this.configs.delete(id)
        this.states.delete(id)
        continue
      }
      // Reconnect when the endpoint changed or the server was switched off.
      const previous = this.configs.get(id)
      if (previous && (!sameEndpoint(previous, incoming) || !incoming.enabled)) {
        await this.disconnect(id)
      }
    }

    for (const [id, config] of next) {
      this.configs.set(id, config)
      if (!this.states.has(id)) this.states.set(id, emptyState(config))
    }

    this.emitStatus()
  }

  saveConfig(config: McpServerConfig): void {
    this.ignoreWatchUntil = Date.now() + 1500
    writeServers([...this.listConfigs().filter((server) => server.id !== config.id), config])
    this.configs.set(config.id, config)
    if (!this.states.has(config.id)) this.states.set(config.id, emptyState(config))
    this.emitStatus()
  }

  removeConfig(id: string): void {
    void this.disconnect(id)
    this.ignoreWatchUntil = Date.now() + 1500
    writeServers(this.listConfigs().filter((server) => server.id !== id))
    this.configs.delete(id)
    this.states.delete(id)
    this.toolCache.delete(id)
    this.promptCache.delete(id)
    this.emitStatus()
  }

  watchConfig(): void {
    if (this.watcher) return
    try {
      this.watcher = watch(getPaths().mcpConfigFile, () => {
        if (Date.now() < this.ignoreWatchUntil) return
        if (this.reloadTimer) clearTimeout(this.reloadTimer)
        this.reloadTimer = setTimeout(() => {
          this.reloadTimer = null
          void this.reloadConfigs()
        }, 250)
      })
    } catch {
      // The file may not exist yet; it is created on first save.
      logger.debug('mcp', 'mcp.json is not watchable yet')
    }
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  async initialize(version: string): Promise<void> {
    this.version = version
    await this.reloadConfigs()
    this.watchConfig()

    const settings = settingsStore.get()
    if (!settings.mcp.autoConnect) return

    for (const config of this.listConfigs()) {
      if (!config.enabled || !config.autoConnect) continue
      void this.connect(config.id)
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.watcher?.close()
    this.watcher = null
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)))
  }

  listStates(): McpServerState[] {
    return this.listConfigs().map(
      (config) => this.states.get(config.id) ?? emptyState(config)
    )
  }

  private setState(id: string, patch: Partial<McpServerState>): void {
    const config = this.configs.get(id)
    const current = this.states.get(id) ?? (config ? emptyState(config) : null)
    if (!current) return
    this.states.set(id, { ...current, ...patch })
    this.emitStatus()
  }

  private emitStatus(): void {
    this.emit('status', this.listStates())
  }

  /* ---------------------------------------------------------------- */
  /* Connections                                                       */
  /* ---------------------------------------------------------------- */

  private createTransport(config: McpServerConfig): Transport {
    if (config.transport !== 'stdio') {
      const url = new URL(config.url ?? '')
      const headers = Object.keys(config.headers).length > 0 ? config.headers : null
      if (config.transport === 'sse') {
        // `eventSourceInit` is typed by the `eventsource` package, which is not
        // a direct dependency here, so the options object is cast at the edge.
        const options = {
          requestInit: headers ? { headers } : undefined,
          eventSourceInit: headers ? { fetch: withHeaders(headers) } : undefined
        }
        return new SSEClientTransport(
          url,
          options as ConstructorParameters<typeof SSEClientTransport>[1]
        ) as Transport
      }
      return new StreamableHTTPClientTransport(url, {
        requestInit: headers ? { headers } : undefined
      }) as Transport
    }

    const resolution = resolveStdioSpawn(config, detectRuntimeInfo())
    if (!resolution.ok) {
      const error = new Error(resolution.errorCode)
      error.name = resolution.errorCode
      throw error
    }
    const { spawn } = resolution
    return new StdioClientTransport({
      command: spawn.command,
      args: spawn.args,
      // getDefaultEnvironment() forwards only the variables servers actually
      // need, so unrelated secrets in the parent process are not leaked.
      env: { ...getDefaultEnvironment(), ...cleanEnv(spawn.env) },
      cwd: config.cwd ?? undefined,
      stderr: 'pipe'
    }) as Transport
  }

  async connect(id: string): Promise<void> {
    const config = this.configs.get(id)
    if (!config || !config.enabled) return

    if (config.transport !== 'stdio' && !settingsStore.get().agent.allowRemoteMcp) {
      this.setState(id, {
        status: 'error',
        errorCode: 'REMOTE_DISABLED',
        error: 'Remote MCP transports are disabled in Settings → Agent'
      })
      return
    }

    await this.disconnect(id)
    this.setState(id, { status: 'connecting', error: null, errorCode: null })
    this.emitStatus()

    let transport: Transport
    try {
      transport = this.createTransport(config)
    } catch (error) {
      const cause = toError(error)
      const code: McpErrorCode = cause.name === 'RUNTIME_MISSING' ? 'RUNTIME_MISSING' : 'SPAWN_FAILED'
      this.setState(id, {
        status: 'error',
        errorCode: code,
        error: code === 'RUNTIME_MISSING' ? 'Node.js (npx) is required but was not found' : cause.message
      })
      return
    }

    const client = new Client({ name: 'lumilm', version: this.version }, { capabilities: {} })

    transport.onerror = (error: Error) => {
      logger.warn('mcp', `${id}: transport error: ${error.message}`)
    }

    try {
      await withTimeout(client.connect(transport), HANDSHAKE_TIMEOUT_MS, 'handshake timed out')
    } catch (error) {
      const cause = toError(error)
      logger.warn('mcp', `${id}: connect failed: ${cause.message}`)
      this.setState(id, { status: 'error', errorCode: 'HANDSHAKE_FAILED', error: cause.message })
      try {
        await transport.close()
      } catch {
        /* already gone */
      }
      this.scheduleReconnect(id)
      return
    }

    const connection: Connection = { config, client, transport, toolNames: [] }
    this.connections.set(id, connection)
    this.reconnectAttempts.set(id, 0)

    const serverVersion = client.getServerVersion()
    this.setState(id, {
      status: 'ready',
      error: null,
      errorCode: null,
      serverName: serverVersion?.name ?? config.name,
      serverVersion: serverVersion?.version ?? null,
      instructions: client.getInstructions() ?? null,
      connectedAt: Date.now()
    })

    // Capabilities are part of "connected": callers expect the tool list to be
    // populated as soon as connect() resolves.
    await this.refreshCapabilities(id)
  }

  private scheduleReconnect(id: string): void {
    const config = this.configs.get(id)
    if (!config || this.shuttingDown || !config.enabled) return
    const attempt = this.reconnectAttempts.get(id) ?? 0
    if (attempt >= RECONNECT_DELAYS_MS.length) return
    this.reconnectAttempts.set(id, attempt + 1)
    const delay = RECONNECT_DELAYS_MS[attempt] ?? 8000
    logger.info('mcp', `${id}: retrying in ${delay}ms (attempt ${attempt + 1})`)
    const timer = setTimeout(() => {
      if (this.shuttingDown) return
      void this.connect(id)
    }, delay)
    timer.unref()
  }

  async disconnect(id: string): Promise<void> {
    const connection = this.connections.get(id)
    this.connections.delete(id)
    this.toolCache.delete(id)
    this.promptCache.delete(id)
    if (connection) {
      try {
        await connection.client.close()
      } catch (error) {
        logger.debug('mcp', `${id}: close failed: ${toError(error).message}`)
      }
      try {
        await connection.transport.close()
      } catch {
        /* transport already closed */
      }
    }
    if (this.states.has(id)) {
      this.setState(id, {
        status: 'disconnected',
        toolCount: 0,
        promptCount: 0,
        connectedAt: null
      })
    }
    this.emitStatus()
  }

  async restart(id: string): Promise<void> {
    this.reconnectAttempts.set(id, 0)
    await this.disconnect(id)
    await this.connect(id)
  }

  /* ---------------------------------------------------------------- */
  /* Capabilities                                                      */
  /* ---------------------------------------------------------------- */

  private async refreshCapabilities(id: string): Promise<void> {
    const connection = this.connections.get(id)
    if (!connection) return

    const tools: McpToolInfo[] = []
    try {
      let cursor: string | undefined
      do {
        const page = (await connection.client.listTools(cursor ? { cursor } : {})) as ToolPage
        for (const tool of page.tools ?? []) {
          const readOnlyHint = tool.annotations?.readOnlyHint ?? null
          const destructiveHint = tool.annotations?.destructiveHint ?? null
          const { risk, reason } = classifyToolRisk(tool.name, readOnlyHint, destructiveHint)
          tools.push({
            name: tool.name,
            serverId: id,
            toolName: tool.name,
            description: tool.description ?? '',
            inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
            risk,
            riskReason: reason,
            readOnlyHint,
            destructiveHint,
            enabled: isToolEnabled(connection.config, tool.name)
          })
        }
        cursor = page.nextCursor
      } while (cursor)
    } catch (error) {
      logger.warn('mcp', `${id}: tools/list failed: ${toError(error).message}`)
    }

    const prompts: McpPromptInfo[] = []
    try {
      let cursor: string | undefined
      do {
        const page = (await connection.client.listPrompts(cursor ? { cursor } : {})) as PromptPage
        for (const prompt of page.prompts ?? []) {
          prompts.push({
            serverId: id,
            name: prompt.name,
            command: `${id}__${prompt.name}`,
            title: prompt.title ?? prompt.name,
            description: prompt.description ?? '',
            arguments: (prompt.arguments ?? []).map((argument) => ({
              name: argument.name,
              description: argument.description ?? '',
              required: argument.required === true
            }))
          })
        }
        cursor = page.nextCursor
      } while (cursor)
    } catch (error) {
      // A server without the prompts capability is perfectly normal.
      logger.debug('mcp', `${id}: prompts/list unavailable: ${toError(error).message}`)
    }

    this.toolCache.set(id, tools)
    this.promptCache.set(id, prompts)
    connection.toolNames = tools.map((tool) => tool.name)
    this.setState(id, { toolCount: tools.length, promptCount: prompts.length })
  }

  listTools(): McpToolInfo[] {
    return [...this.toolCache.values()].flat()
  }

  listPrompts(): McpPromptInfo[] {
    return [...this.promptCache.values()].flat()
  }

  isConnected(id: string): boolean {
    return this.connections.has(id)
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ content: string; ok: boolean; truncated: boolean }> {
    const connection = this.connections.get(serverId)
    if (!connection) throw new Error('MCP server is not connected')

    const timeout = settingsStore.get().mcp.callTimeoutMs
    const result = await connection.client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { signal, timeout, resetTimeoutOnProgress: true }
    )

    const maxChars = settingsStore.get().agent.maxToolResultChars
    return normalizeToolResult(result, maxChars)
  }

  async getPrompt(
    serverId: string,
    name: string,
    args: Record<string, string>
  ): Promise<string | null> {
    const connection = this.connections.get(serverId)
    if (!connection) return null
    const result = await connection.client.getPrompt({ name, arguments: args })
    const messages = (result as { messages?: Array<{ content?: unknown }> }).messages ?? []
    const parts: string[] = []
    for (const message of messages) {
      const content = message.content as { type?: string; text?: string } | undefined
      if (typeof content?.text === 'string') parts.push(content.text)
    }
    return parts.length > 0 ? parts.join('\n\n') : null
  }
}

function sameEndpoint(a: McpServerConfig, b: McpServerConfig): boolean {
  return (
    a.transport === b.transport &&
    a.command === b.command &&
    a.url === b.url &&
    a.args.join('\u0000') === b.args.join('\u0000') &&
    a.cwd === b.cwd
  )
}

export function isToolEnabled(config: McpServerConfig, toolName: string): boolean {
  if (config.toolDenylist.includes(toolName)) return false
  if (config.toolAllowlist.length > 0) return config.toolAllowlist.includes(toolName)
  return true
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const mcpManager = new McpManager()
