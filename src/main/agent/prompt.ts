import { arch, platform, release } from 'node:os'
import type {
  AgentSettings,
  ChatRequestMessage,
  CompanionSettings,
  ConversationCompanion,
  MemoryEpisode,
  MemoryHit,
  PersonaCard,
  PromptBlockInfo,
  PromptPreview,
  PromptPreviewInput,
  RelationshipState
} from '@shared/types'
import { buildToolCatalogue, type ToolCatalogue } from './tools'
import { renderTemplate } from './template'
import { effectiveWorkspaceRoot } from '../tools/workspace'
import { estimateTokens } from './budget'
import { renderBoundaries, renderEpisodes, renderMemories, renderPersona, renderRelationship } from '../companion/persona'

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

/* ------------------------------------------------------------------ */
/* Companion prompt                                                    */
/* ------------------------------------------------------------------ */

export interface CompanionPromptInput {
  card: PersonaCard
  companion?: ConversationCompanion
  relationship: RelationshipState
  /** the L2 rolling summary of this conversation */
  summary: string
  /** the facts recall selected for this turn */
  hits: MemoryHit[]
  episodes: MemoryEpisode[]
  settings: CompanionSettings
  /** the conversation's own custom prompt, appended after the persona */
  userPrompt?: string
}

export interface ComposedCompanionPrompt {
  /**
   * The first system message. Byte-identical across turns, so llama.cpp can
   * reuse the KV cache for it.
   */
  system: string
  /**
   * The volatile block. It is appended next to the newest user message at
   * request time only — never stored with the conversation and never rendered
   * in the transcript.
   */
  injection: string
  blocks: PromptBlockInfo[]
  personaTokens: number
  injectionTokens: number
  /** true when the persona had to be cut to fit `personaTokenLimit` */
  truncated: boolean
  /** how many recalled facts survived the token budget */
  usedHits: number
}

/**
 * Builds the two halves of a companion request.
 *
 * The split is the whole point: the persona is stable and therefore cacheable,
 * while memories and the relationship change every turn and would otherwise
 * invalidate the entire prompt on each message.
 */
export function composeCompanionPrompt(input: CompanionPromptInput): ComposedCompanionPrompt {
  const { settings, card } = input

  const persona = renderPersona(card, settings.personaTemplate, settings.personaTokenLimit)
  const userPrompt = (input.userPrompt ?? '').trim()

  // Recall is capped a second time here: the caller budgets in estimated
  // tokens, but the template can add its own framing on top.
  const budget = settings.recallTokenBudget
  const kept: MemoryHit[] = []
  let spent = 0
  for (const hit of input.hits) {
    const cost = estimateTokens(hit.fact.text) + 4
    if (spent + cost > budget && kept.length > 0) break
    spent += cost
    kept.push(hit)
  }

  const memoryEnabled = input.companion?.memoryEnabled ?? settings.memoryEnabled
  const relationship = memoryEnabled ? renderRelationship(input.relationship, card.name) : ''
  const memories = memoryEnabled ? renderMemories(kept) : ''
  const boundaries = memoryEnabled ? renderBoundaries(kept) : ''
  const summary = memoryEnabled ? input.summary.trim() : ''
  const episodes =
    memoryEnabled && settings.includeEpisodes ? renderEpisodes(input.episodes) : ''

  const injection = memoryEnabled
    ? renderTemplate(settings.memoryTemplate, {
        relationship,
        memories: [boundaries, memories].filter((part) => part.length > 0).join('\n'),
        summary,
        episodes
      })
    : ''

  const system = [persona.text, userPrompt].filter((part) => part.trim().length > 0).join('\n\n')

  const blocks: PromptBlockInfo[] = [
    { id: 'persona', enabled: persona.text.length > 0, content: persona.text, tokens: persona.tokens },
    { id: 'user', enabled: userPrompt.length > 0, content: userPrompt, tokens: 0 },
    { id: 'relationship', enabled: relationship.length > 0, content: relationship, tokens: 0 },
    { id: 'memory', enabled: memories.length > 0, content: memories, tokens: 0 },
    { id: 'summary', enabled: summary.length > 0, content: summary, tokens: 0 }
  ]

  return {
    system,
    injection,
    blocks,
    personaTokens: persona.tokens,
    injectionTokens: estimateTokens(injection),
    truncated: persona.truncated,
    usedHits: kept.length
  }
}

/**
 * Puts the injection where it does the least damage to the KV cache.
 *
 * `user-suffix` appends it to the newest user message, which works with every
 * chat template; `tail-system` adds a system turn at the end, which reads
 * better but is only safe on templates that tolerate a mid-conversation system
 * message. Both change the prompt as late as possible, so the persona prefix
 * and the whole history before it stay cacheable.
 */
export function applyMemoryInjection(
  messages: ChatRequestMessage[],
  injection: string,
  mode: CompanionSettings['memoryInjectionMode']
): ChatRequestMessage[] {
  const text = injection.trim()
  if (text.length === 0) return messages

  if (mode === 'tail-system') {
    return [...messages, { role: 'system', content: text }]
  }

  const next = [...messages]
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const message = next[index]
    if (message.role !== 'user') continue
    next[index] = {
      ...message,
      content: message.content.length > 0 ? `${message.content}\n\n${text}` : text
    }
    return next
  }

  // No user message to attach to: a trailing system turn is the only option.
  return [...next, { role: 'system', content: text }]
}
