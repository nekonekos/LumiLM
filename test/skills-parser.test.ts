import { describe, expect, it } from 'vitest'
import { parseSkillJson, parseSkillMarkdown, splitFrontmatter } from '../src/main/skills/parser'

describe('splitFrontmatter', () => {
  it('splits a leading block from the body', () => {
    const { front, body } = splitFrontmatter('---\nname: a\n---\nbody text')
    expect(front).toBe('name: a')
    expect(body).toBe('body text')
  })

  it('returns the whole text as body when there is no frontmatter', () => {
    const { front, body } = splitFrontmatter('# just markdown')
    expect(front).toBeNull()
    expect(body).toBe('# just markdown')
  })

  it('tolerates a BOM and CRLF line endings', () => {
    const { front, body } = splitFrontmatter('\uFEFF---\r\nname: a\r\n---\r\nbody')
    expect(front).toContain('name: a')
    expect(body).toBe('body')
  })
})

describe('parseSkillMarkdown', () => {
  const VALID = ['---', 'name: pdf-tools', 'description: Split and merge PDFs', '---', '', 'Do the thing.'].join('\n')

  it('reads name, description and body', () => {
    const skill = parseSkillMarkdown(VALID, 'fallback')
    expect(skill.error).toBeNull()
    expect(skill.name).toBe('pdf-tools')
    expect(skill.description).toBe('Split and merge PDFs')
    expect(skill.systemPrompt).toBe('Do the thing.')
    expect(skill.format).toBe('skill-md')
  })

  it('accepts allowed-tools as a YAML list', () => {
    const skill = parseSkillMarkdown(
      ['---', 'description: d', 'allowed-tools:', '  - mcp__fs__read', '  - mcp__fs__list', '---', 'body'].join('\n'),
      'x'
    )
    expect(skill.allowedTools).toEqual(['mcp__fs__read', 'mcp__fs__list'])
  })

  it('accepts allowed-tools as a comma separated string', () => {
    const skill = parseSkillMarkdown(
      ['---', 'description: d', 'allowedTools: a, b', '---', 'body'].join('\n'),
      'x'
    )
    expect(skill.allowedTools).toEqual(['a', 'b'])
  })

  it('falls back to the folder name when name is missing', () => {
    const skill = parseSkillMarkdown(['---', 'description: d', '---', 'body'].join('\n'), 'folder')
    expect(skill.name).toBe('folder')
    expect(skill.error).toBeNull()
  })

  it('rejects a skill without a description', () => {
    const skill = parseSkillMarkdown(['---', 'name: x', '---', 'body'].join('\n'), 'folder')
    expect(skill.error).toContain('description')
  })

  it('rejects a skill without frontmatter', () => {
    expect(parseSkillMarkdown('no frontmatter here', 'folder').error).toContain('frontmatter')
  })

  it('reports invalid YAML instead of throwing', () => {
    const skill = parseSkillMarkdown(['---', 'description: [unclosed', '---', 'body'].join('\n'), 'folder')
    expect(skill.error).toContain('YAML')
  })

  it('rejects frontmatter that is not a mapping', () => {
    const skill = parseSkillMarkdown(['---', '- a', '- b', '---', 'body'].join('\n'), 'folder')
    expect(skill.error).toContain('mapping')
  })
})

describe('parseSkillJson', () => {
  it('reads a valid object', () => {
    const skill = parseSkillJson(
      JSON.stringify({ name: 'n', description: 'd', systemPrompt: 'body', allowedTools: ['t'] }),
      'fallback'
    )
    expect(skill.error).toBeNull()
    expect(skill.name).toBe('n')
    expect(skill.systemPrompt).toBe('body')
    expect(skill.allowedTools).toEqual(['t'])
    expect(skill.format).toBe('json')
  })

  it('rejects invalid JSON', () => {
    expect(parseSkillJson('{ oops', 'f').error).toContain('invalid JSON')
  })

  it('rejects a non-object payload', () => {
    expect(parseSkillJson('["a"]', 'f').error).toContain('JSON object')
  })

  it('rejects a missing description', () => {
    expect(parseSkillJson('{"name":"x"}', 'f').error).toContain('description')
  })
})
