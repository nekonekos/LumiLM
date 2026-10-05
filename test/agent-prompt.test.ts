import { describe, expect, it } from 'vitest'
import type { AgentSettings, PromptPreviewInput, SkillInfo } from '@shared/types'
import { DEFAULT_AGENT_PREAMBLE } from '@shared/types'
import { composePrompt, describeSkills, describeServers, describeTools } from '../src/main/agent/prompt'
import { renderTemplate } from '../src/main/agent/template'
import { matchesPattern } from '../src/main/agent/patterns'
import type { ToolCatalogue } from '../src/main/agent/tools'

const AGENT_SETTINGS: AgentSettings = {
  defaultMode: 'chat',
  permission: 'ask-risky',
  thinking: 'unlimited',
  maxIterations: 6,
  maxToolResultChars: 8000,
  toolSchemaTokenWarn: 1500,
  injectPrompt: true,
  preambleTemplate: DEFAULT_AGENT_PREAMBLE,
  parseTextToolCalls: true,
  fileToolsEnabled: false,
  shellToolsEnabled: false,
  workspaceRoot: null,
  allowRemoteMcp: false
}

function skill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    id: 'pdf',
    name: 'pdf-tools',
    description: 'Split and merge PDFs',
    systemPrompt: 'Full body',
    allowedTools: [],
    format: 'skill-md',
    sourcePath: '/skills/pdf/SKILL.md',
    directory: '/skills/pdf',
    error: null,
    resources: [],
    ...overrides
  }
}

function catalogue(overrides: Partial<ToolCatalogue> = {}): ToolCatalogue {
  const tools = overrides.tools ?? []
  return {
    tools,
    openAiTools: overrides.openAiTools ?? [],
    skills: overrides.skills ?? [],
    servers: overrides.servers ?? [],
    isKnownName: overrides.isKnownName ?? (() => false)
  }
}

function input(overrides: Partial<PromptPreviewInput> = {}): PromptPreviewInput {
  return { systemPrompt: '', mode: 'chat', ...overrides }
}

describe('renderTemplate', () => {
  it('substitutes variables', () => {
    expect(renderTemplate('hi {{name}}', { name: 'Lumi' })).toBe('hi Lumi')
  })

  it('replaces an unknown variable with nothing', () => {
    expect(renderTemplate('a{{missing}}b', {})).toBe('ab')
  })

  it('keeps a section when the value is present', () => {
    expect(renderTemplate('{{#x}}kept {{x}}{{/x}}', { x: 'v' })).toBe('kept v')
  })

  it('drops a section entirely when the value is empty or missing', () => {
    expect(renderTemplate('a{{#x}}gone{{/x}}b', { x: '' })).toBe('ab')
    expect(renderTemplate('a{{#x}}gone{{/x}}b', {})).toBe('ab')
  })

  it('collapses the blank lines a dropped section leaves behind', () => {
    expect(renderTemplate('a\n\n{{#x}}z\n\n{{/x}}', { x: '' })).toBe('a')
  })

  it('handles the default preamble with every optional part empty', () => {
    const rendered = renderTemplate(DEFAULT_AGENT_PREAMBLE, {
      tools: '',
      skills: '',
      servers: '',
      os: 'win32',
      cwd: '/w'
    })
    expect(rendered).not.toContain('## Tools')
    expect(rendered).not.toContain('## Skills')
    expect(rendered).toContain('## Environment')
  })
})

describe('composePrompt', () => {
  it('injects nothing at all in chat mode', () => {
    const result = composePrompt(input({ mode: 'chat' }), catalogue(), AGENT_SETTINGS)
    expect(result.text).toBe('')
    expect(result.injectionDisabled).toBe(false)
    expect(result.blocks.map((block) => block.id)).toEqual(['user'])
  })

  it('sends only the users own prompt in chat mode', () => {
    const result = composePrompt(
      input({ mode: 'chat', systemPrompt: 'be terse' }),
      catalogue(),
      AGENT_SETTINGS
    )
    expect(result.text).toBe('be terse')
  })

  it('adds the preamble in agent mode', () => {
    const result = composePrompt(input({ mode: 'agent' }), catalogue(), AGENT_SETTINGS)
    expect(result.text).toContain('You are an autonomous assistant')
    expect(result.blocks.map((block) => block.id)).toContain('preamble')
  })

  it('keeps the users prompt ahead of the generated preamble', () => {
    const result = composePrompt(
      input({ mode: 'agent', systemPrompt: 'be terse' }),
      catalogue(),
      AGENT_SETTINGS
    )
    expect(result.text.startsWith('be terse')).toBe(true)
  })

  it('stops injecting the agent prompt when the conversation disables it', () => {
    const result = composePrompt(
      input({ mode: 'agent', systemPrompt: 'mine', agent: { injectPrompt: false } }),
      catalogue(),
      AGENT_SETTINGS
    )
    expect(result.injectionDisabled).toBe(true)
    expect(result.text).toBe('mine')
  })

  it('honours the global injection switch', () => {
    const result = composePrompt(
      input({ mode: 'agent' }),
      catalogue(),
      { ...AGENT_SETTINGS, injectPrompt: false }
    )
    expect(result.injectionDisabled).toBe(true)
    expect(result.text).toBe('')
  })

  it('prefers a per conversation preamble override', () => {
    const result = composePrompt(
      input({ mode: 'agent', agent: { preambleOverride: 'CUSTOM {{os}}' } }),
      catalogue(),
      AGENT_SETTINGS
    )
    expect(result.text.startsWith('CUSTOM')).toBe(true)
  })

  it('lists the enabled skills in the preamble', () => {
    const result = composePrompt(
      input({ mode: 'agent' }),
      catalogue({ skills: [skill()] }),
      AGENT_SETTINGS
    )
    expect(result.text).toContain('pdf-tools')
    expect(result.text).toContain('## Skills')
  })

  it('drops the skill section when no skill is enabled', () => {
    const result = composePrompt(input({ mode: 'agent' }), catalogue(), AGENT_SETTINGS)
    expect(result.text).not.toContain('## Skills')
  })
})

describe('descriptions', () => {
  it('describes tools by their namespaced name', () => {
    const text = describeTools(
      catalogue({
        tools: [
          {
            name: 'mcp__fs__read_file',
            kind: 'mcp',
            serverId: 'fs',
            toolName: 'read_file',
            description: 'Read a file\nsecond line',
            risk: 'read-only',
            riskReason: 'r',
            schema: {},
            execute: async () => ({ content: '', ok: true, truncated: false })
          }
        ]
      })
    )
    expect(text).toBe('- mcp__fs__read_file: Read a file')
  })

  it('describes a skill by name and description', () => {
    expect(describeSkills(catalogue({ skills: [skill()] }))).toBe(
      '- pdf-tools: Split and merge PDFs'
    )
  })

  it('includes server instructions when the server provided them', () => {
    const text = describeServers(
      catalogue({ servers: [{ id: 's', name: 'docs', instructions: 'Use sparingly' }] })
    )
    expect(text).toBe('- docs: Use sparingly')
  })
})

describe('matchesPattern', () => {
  it('matches an exact name', () => {
    expect(matchesPattern('mcp__fs__read', 'mcp__fs__read')).toBe(true)
  })

  it('matches a wildcard pattern', () => {
    expect(matchesPattern('mcp__fs__*', 'mcp__fs__read')).toBe(true)
    expect(matchesPattern('mcp__*__read', 'mcp__fs__read')).toBe(true)
  })

  it('does not match across the wildcard boundary', () => {
    expect(matchesPattern('mcp__fs__*', 'mcp__other__read')).toBe(false)
  })

  it('treats a pattern without a wildcard as exact', () => {
    expect(matchesPattern('read', 'read_file')).toBe(false)
  })
})
