import { createHash } from 'node:crypto'
import type { McpToolInfo, ToolRisk } from '@shared/types'

export const MCP_TOOL_PREFIX = 'mcp__'
/** OpenAI function names must match ^[a-zA-Z0-9_-]{1,64}$. */
export const MAX_FUNCTION_NAME = 64
/** Built-in and skill tools are reserved under this prefix. */
export const BUILTIN_TOOL_PREFIX = 'builtin__'

const SCHEMA_NOISE = new Set(['$schema', '$id', '$comment'])

/** Keeps a name fragment inside the function-name character set. */
export function sanitizeSegment(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function namespaceTool(serverId: string, toolName: string): string {
  const namespace = `${MCP_TOOL_PREFIX}${sanitizeSegment(serverId)}__${sanitizeSegment(toolName)}`
  if (namespace.length <= MAX_FUNCTION_NAME) return namespace
  const digest = createHash('sha1').update(namespace).digest('hex').slice(0, 6)
  return `${namespace.slice(0, MAX_FUNCTION_NAME - digest.length - 1)}_${digest}`
}

/**
 * Builds the function name for every discovered tool, appending a short hash
 * when two different tools collapse onto the same name.
 */
export function assignFunctionNames(tools: Array<{ serverId: string; toolName: string }>): string[] {
  const used = new Set<string>()
  return tools.map((tool) => {
    const base = namespaceTool(tool.serverId, tool.toolName)
    if (!used.has(base)) {
      used.add(base)
      return base
    }
    const digest = createHash('sha1')
      .update(`${tool.serverId}::${tool.toolName}`)
      .digest('hex')
      .slice(0, 6)
    const unique = `${base.slice(0, MAX_FUNCTION_NAME - digest.length - 1)}_${digest}`
    used.add(unique)
    return unique
  })
}

/**
 * MCP servers send full JSON Schema. Only the keys llama.cpp chokes on are
 * removed — everything else is forwarded verbatim so `$ref`, `enum` and
 * `oneOf` keep working.
 */
export function toOpenAiParameters(schema: unknown): Record<string, unknown> {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return { type: 'object', properties: {} }
  }
  const source = schema as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (SCHEMA_NOISE.has(key)) continue
    result[key] = value
  }
  if (result.type !== 'object') result.type = 'object'
  if (typeof result.properties !== 'object' || result.properties === null) result.properties = {}
  return result
}

export interface OpenAiTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export function toOpenAiTool(name: string, description: string, inputSchema: unknown): OpenAiTool {
  return {
    type: 'function',
    function: {
      name,
      // llama.cpp rejects an empty description in some templates, so pad it.
      description: description.trim().length > 0 ? description : name,
      parameters: toOpenAiParameters(inputSchema)
    }
  }
}

/** Tool names that look like they mutate something. */
const RISKY_NAME =
  /(write|edit|delete|remove|move|rename|create|exec|run|shell|kill|install|chmod|patch|put|post|upload|mkdir|rmdir|touch|append|truncate)/i

/**
 * Annotations win when the server provides them. Otherwise the name decides,
 * which keeps the default `ask-risky` policy practical: an unannotated
 * `read_file` runs without a prompt while an unannotated `delete_file` does not.
 */
export function classifyToolRisk(
  toolName: string,
  readOnlyHint: boolean | null,
  destructiveHint: boolean | null
): { risk: ToolRisk; reason: string } {
  if (destructiveHint === true) return { risk: 'destructive', reason: 'server marked it destructive' }
  if (readOnlyHint === true) return { risk: 'read-only', reason: 'server marked it read-only' }
  if (readOnlyHint === false) {
    return { risk: 'destructive', reason: 'server marked it as not read-only' }
  }
  if (RISKY_NAME.test(toolName)) {
    return { risk: 'destructive', reason: 'no annotations and the name looks destructive' }
  }
  return { risk: 'read-only', reason: 'no annotations and the name looks read-only' }
}

export function truncateMiddle(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0 || text.length <= maxChars) return { text, truncated: false }
  const marker = `\n… [${text.length - maxChars} characters omitted] …\n`
  const budget = Math.max(0, maxChars - marker.length)
  const head = Math.ceil(budget * 0.6)
  const tail = budget - head
  return {
    text: `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(text.length - tail) : ''}`,
    truncated: true
  }
}

interface McpContentItem {
  type?: string
  text?: string
  data?: string
  mimeType?: string
  uri?: string
  name?: string
  resource?: { uri?: string; mimeType?: string; text?: string }
}

/**
 * Flattens MCP content blocks into the plain text that gets written back as a
 * `tool` message. Images become placeholders on purpose: putting binary parts
 * into a tool message breaks most chat templates.
 */
export function normalizeToolResult(
  result: unknown,
  maxChars: number
): { content: string; ok: boolean; truncated: boolean } {
  const payload = (result ?? {}) as { content?: unknown; isError?: boolean }
  const items = Array.isArray(payload.content) ? (payload.content as McpContentItem[]) : []
  const parts: string[] = []

  for (const item of items) {
    if (typeof item?.text === 'string') {
      parts.push(item.text)
      continue
    }
    if (item?.type === 'image') parts.push(`[image: ${item.mimeType ?? 'image/*'}]`)
    else if (item?.type === 'audio') parts.push(`[audio: ${item.mimeType ?? 'audio/*'}]`)
    else if (item?.type === 'resource') {
      const uri = item.resource?.uri ?? item.uri ?? 'unknown'
      parts.push(
        typeof item.resource?.text === 'string'
          ? `[resource ${uri}]\n${item.resource.text}`
          : `[resource ${uri}]`
      )
    } else if (item?.type === 'resource_link') {
      parts.push(`[resource link ${item.uri ?? 'unknown'}]`)
    } else if (typeof item?.data === 'string') {
      parts.push(`[binary: ${item.mimeType ?? 'application/octet-stream'}]`)
    }
  }

  if (parts.length === 0) parts.push('(the tool returned no content)')

  const ok = payload.isError !== true
  const joined = parts.join('\n')
  const { text, truncated } = truncateMiddle(joined, maxChars)
  return { content: ok ? text : `[tool error]\n${text}`, ok, truncated }
}

/** Leaves headroom for the per-message wrapper the model sees. */
export function toolInfoToDescriptor(tool: McpToolInfo): string {
  const description = tool.description.trim().length > 0 ? tool.description : '(no description)'
  return `- ${tool.name}: ${description}`
}
