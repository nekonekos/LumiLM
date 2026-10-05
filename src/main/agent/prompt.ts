import { arch, platform, release } from 'node:os'
import type {
  AgentSettings,
  PromptBlockInfo,
  PromptPreview,
  PromptPreviewInput
} from '@shared/types'
import { buildToolCatalogue, type ToolCatalogue } from './tools'
import { renderTemplate } from './template'
import { effectiveWorkspaceRoot } from '../tools/workspace'

export { renderTemplate }

/** Token counter injected by the caller so this module stays testable. */
export type Tokenize = (text: string) => Promise<number>

export function describeTools(catalogue: ToolCatalogue): string {
  return catalogue.tools
    .map((tool) => {
      const description = tool.description.trim().split('\n')[0] ?? ''
      return `- ${tool.name}: ${description}`
    })
    .join('\n')
}

export function describeSkills(catalogue: ToolCatalogue): string {
  return catalogue.skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')
}

export function describeServers(catalogue: ToolCatalogue): string {
  return catalogue.servers
    .map((server) =>
      server.instructions ? `- ${server.name}: ${server.instructions}` : `- ${server.name}`
    )
    .join('\n')
}

export interface ComposedPrompt {
  text: string
  blocks: PromptBlockInfo[]
  injectionDisabled: boolean
}

/**
 * Builds the exact system message for one turn.
 *
 * In chat mode nothing is added: the text is the user's own prompt, which is
 * what shipped before the extension system existed.
 */
export function composePrompt(
  input: PromptPreviewInput,
  catalogue: ToolCatalogue,
  settings: AgentSettings
): ComposedPrompt {
  const isAgent = input.mode === 'agent'
  const inject = input.agent?.injectPrompt ?? settings.injectPrompt
  const injectionDisabled = isAgent && inject === false

  const template = input.agent?.preambleOverride?.trim() || settings.preambleTemplate || ''

  const skills = describeSkills(catalogue)
  const servers = describeServers(catalogue)
  const tools = describeTools(catalogue)

  const preamble =
    isAgent && !injectionDisabled
      ? renderTemplate(template, {
          tools,
          skills,
          servers,
          os: `${platform()} ${release()} (${arch()})`,
          cwd: effectiveWorkspaceRoot(input.agent?.workspaceRoot ?? settings.workspaceRoot)
        })
      : ''

  const userBlock: PromptBlockInfo = {
    id: 'user',
    enabled: input.systemPrompt.trim().length > 0,
    content: input.systemPrompt,
    tokens: 0
  }

  const agentBlocks: PromptBlockInfo[] = isAgent
    ? [
        { id: 'preamble', enabled: preamble.length > 0, content: preamble, tokens: 0 },
        {
          id: 'skills',
          enabled: skills.length > 0 && !injectionDisabled,
          content: skills,
          tokens: 0
        },
        {
          id: 'servers',
          enabled: servers.length > 0 && !injectionDisabled,
          content: servers,
          tokens: 0
        }
      ]
    : []

  const blocks = [userBlock, ...agentBlocks]
  const parts = blocks
    .filter((block) => block.enabled && block.content.trim().length > 0)
    .map((block) => block.content.trim())

  return { text: parts.join('\n\n'), blocks, injectionDisabled }
}

export async function buildPromptPreview(
  input: PromptPreviewInput,
  tokenize: Tokenize,
  settings: AgentSettings
): Promise<PromptPreview> {
  const catalogue = buildToolCatalogue(input.agent)
  const { text, blocks, injectionDisabled } = composePrompt(input, catalogue, settings)

  const filled: PromptBlockInfo[] = []
  for (const block of blocks) {
    filled.push({ ...block, tokens: block.enabled ? await tokenize(block.content) : 0 })
  }

  // Chat mode sends no `tools` field at all, so reporting the catalogue size
  // here would misrepresent what the model actually receives.
  const tools = input.mode === 'agent' ? catalogue.openAiTools : []
  const toolsTokens = tools.length > 0 ? await tokenize(JSON.stringify(tools)) : 0

  return {
    text,
    blocks: filled,
    toolsCount: tools.length,
    toolsTokens,
    totalTokens: filled.reduce((sum, block) => sum + block.tokens, 0),
    injectionDisabled
  }
}
