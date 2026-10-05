import type { AgentOverrides, SkillInfo, ToolRisk } from '@shared/types'
import { settingsStore } from '../store/settings'
import { mcpManager } from '../mcp/manager'
import {
  BUILTIN_TOOL_PREFIX,
  assignFunctionNames,
  toOpenAiTool,
  truncateMiddle,
  type OpenAiTool
} from '../mcp/registry'
import { skillRegistry } from '../skills/registry'
import { WORKSPACE_TOOL_DEFS } from '../tools/workspace'

export const SKILL_LOAD_TOOL = 'builtin__skills_load'
export const SKILL_RESOURCE_TOOL = 'builtin__skills_read_resource'

const MAX_SKILL_BODY_CHARS = 20_000

export interface ToolExecution {
  content: string
  ok: boolean
  truncated: boolean
}

export interface ResolvedTool {
  /** the function name handed to the model */
  name: string
  kind: 'mcp' | 'skill' | 'workspace'
  serverId: string | null
  toolName: string
  description: string
  risk: ToolRisk
  riskReason: string
  schema: Record<string, unknown>
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecution>
}

export interface EnabledServerInfo {
  id: string
  name: string
  instructions: string | null
}

export interface ToolCatalogue {
  tools: ResolvedTool[]
  openAiTools: OpenAiTool[]
  /** the enabled skills, in the order the prompt index should list them */
  skills: SkillInfo[]
  servers: EnabledServerInfo[]
  isKnownName(name: string): boolean
}

/** Supports the `mcp__filesystem__*` style patterns used by `allowed-tools`. */
import { matchesPattern } from './patterns'

function enabledSkills(overrides: AgentOverrides | undefined): SkillInfo[] {
  const settings = settingsStore.get()
  const ids = overrides?.enabledSkillIds ?? settings.skills.defaultEnabledIds
  if (ids.length === 0) return []

  const wanted = new Set(ids)
  return skillRegistry
    .list()
    .filter((skill) => wanted.has(skill.id) && skill.error === null)
}

function enabledServerIds(overrides: AgentOverrides | undefined): Set<string> | null {
  const ids = overrides?.enabledServerIds
  return ids && ids.length > 0 ? new Set(ids) : null
}

/**
 * Assembles everything the model may call during one turn, applying the
 * per-conversation overrides and any `allowed-tools` restriction declared by
 * the enabled skills.
 */
export function buildToolCatalogue(overrides: AgentOverrides | undefined): ToolCatalogue {
  const settings = settingsStore.get()
  const skills = enabledSkills(overrides)
  const serverFilter = enabledServerIds(overrides)

  const mcpTools = mcpManager
    .listTools()
    .filter((tool) => tool.enabled && mcpManager.isConnected(tool.serverId))
    .filter((tool) => serverFilter === null || serverFilter.has(tool.serverId))

  const names = assignFunctionNames(
    mcpTools.map((tool) => ({ serverId: tool.serverId, toolName: tool.toolName }))
  )

  const tools: ResolvedTool[] = mcpTools.map((tool, index) => {
    const name = names[index] ?? tool.name
    return {
      name,
      kind: 'mcp',
      serverId: tool.serverId,
      toolName: tool.toolName,
      description: tool.description,
      risk: tool.risk,
      riskReason: tool.riskReason,
      schema: tool.inputSchema,
      async execute(args, signal) {
        const result = await mcpManager.callTool(tool.serverId, tool.toolName, args, signal)
        return result
      }
    }
  })

  if (skills.length > 0) {
    const catalogue = skills.map((skill) => `${skill.name}: ${skill.description}`).join('\n')
    tools.push({
      name: SKILL_LOAD_TOOL,
      kind: 'skill',
      serverId: null,
      toolName: 'skills_load',
      description: `Load the full instructions of one of the available skills.\nAvailable skills:\n${catalogue}`,
      risk: 'read-only',
      riskReason: 'built-in skill reader',
      schema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Skill name from the list' } },
        required: ['name']
      },
      async execute(args) {
        const requested = typeof args.name === 'string' ? args.name : ''
        const skill = skills.find(
          (candidate) => candidate.id === requested || candidate.name === requested
        )
        if (!skill) {
          return {
            content: `Unknown skill "${requested}". Available: ${skills.map((s) => s.name).join(', ')}`,
            ok: false,
            truncated: false
          }
        }
        const { text, truncated } = truncateMiddle(skill.systemPrompt, MAX_SKILL_BODY_CHARS)
        return { content: text, ok: true, truncated }
      }
    })

    const withResources = skills.filter((skill) => skill.resources.length > 0)
    if (withResources.length > 0) {
      const listing = withResources
        .map((skill) => `${skill.name}: ${skill.resources.join(', ')}`)
        .join('\n')
      tools.push({
        name: SKILL_RESOURCE_TOOL,
        kind: 'skill',
        serverId: null,
        toolName: 'skills_read_resource',
        description: `Read a bundled file that belongs to a skill.\nBundled files:\n${listing}`,
        risk: 'read-only',
        riskReason: 'built-in skill reader',
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Skill name' },
            path: { type: 'string', description: 'Relative path of the bundled file' }
          },
          required: ['name', 'path']
        },
        async execute(args) {
          const requested = typeof args.name === 'string' ? args.name : ''
          const path = typeof args.path === 'string' ? args.path : ''
          const skill = skills.find(
            (candidate) => candidate.id === requested || candidate.name === requested
          )
          if (!skill) return { content: `Unknown skill "${requested}"`, ok: false, truncated: false }
          const content = skillRegistry.readResource(skill.id, path)
          if (content === null) {
            return { content: `Cannot read "${path}" from skill ${skill.name}`, ok: false, truncated: false }
          }
          const { text, truncated } = truncateMiddle(content, MAX_SKILL_BODY_CHARS)
          return { content: text, ok: true, truncated }
        }
      })
    }
  }

  if (settings.agent.workspaceToolsEnabled && settings.agent.workspaceRoot) {
    const root = settings.agent.workspaceRoot
    for (const def of WORKSPACE_TOOL_DEFS) {
      tools.push({
        name: `${BUILTIN_TOOL_PREFIX}${def.toolName}`,
        kind: 'workspace',
        serverId: null,
        toolName: def.toolName,
        description: def.description,
        risk: def.risk,
        riskReason: 'built-in workspace tool',
        schema: def.inputSchema,
        async execute(args) {
          const result = await def.run(root, args)
          const { text, truncated } = truncateMiddle(result.content, settings.agent.maxToolResultChars)
          return { content: result.ok ? text : `[tool error]\n${text}`, ok: result.ok, truncated }
        }
      })
    }
  }

  const allowed = collectAllowedPatterns(skills)
  const visible =
    allowed === null
      ? tools
      : tools.filter(
          (tool) =>
            tool.kind === 'skill' || allowed.some((pattern) => matchesPattern(pattern, tool.name))
        )

  return {
    tools: visible,
    openAiTools: visible.map((tool) => toOpenAiTool(tool.name, tool.description, tool.schema)),
    skills,
    servers: collectServers(serverFilter),
    isKnownName: (name) => visible.some((tool) => tool.name === name)
  }
}

/**
 * A skill that declares `allowed-tools` narrows what the model can see. With
 * several such skills the patterns are unioned rather than intersected, which
 * matches "each skill brings its own tools" more closely than the alternative.
 */
function collectAllowedPatterns(skills: SkillInfo[]): string[] | null {
  const patterns = skills.filter((skill) => skill.allowedTools.length > 0).flatMap((s) => s.allowedTools)
  return patterns.length > 0 ? [...new Set(patterns)] : null
}

function collectServers(filter: Set<string> | null): EnabledServerInfo[] {
  const states = mcpManager.listStates()
  return states
    .filter((state) => state.status === 'ready')
    .filter((state) => filter === null || filter.has(state.id))
    .map((state) => ({
      id: state.id,
      name: state.serverName ?? state.id,
      instructions: state.instructions
    }))
}
