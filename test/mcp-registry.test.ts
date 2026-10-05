import { describe, expect, it } from 'vitest'
import {
  assignFunctionNames,
  classifyToolRisk,
  MAX_FUNCTION_NAME,
  namespaceTool,
  normalizeToolResult,
  sanitizeSegment,
  toOpenAiParameters,
  toOpenAiTool,
  truncateMiddle
} from '../src/main/mcp/registry'

describe('tool naming', () => {
  it('strips characters that OpenAI function names reject', () => {
    expect(sanitizeSegment('read.file')).toBe('read_file')
    expect(sanitizeSegment('a b/c')).toBe('a_b_c')
  })

  it('namespaces a tool under its server', () => {
    expect(namespaceTool('filesystem', 'read_file')).toBe('mcp__filesystem__read_file')
  })

  it('keeps every generated name within the 64 character limit', () => {
    const name = namespaceTool('a'.repeat(60), 'b'.repeat(60))
    expect(name.length).toBeLessThanOrEqual(MAX_FUNCTION_NAME)
    expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  })

  it('resolves collisions between different tools deterministically', () => {
    const names = assignFunctionNames([
      { serverId: 'a.b', toolName: 'read' },
      { serverId: 'a b', toolName: 'read' }
    ])
    expect(new Set(names).size).toBe(2)
    expect(assignFunctionNames([{ serverId: 'a.b', toolName: 'read' }])[0]).toBe(names[0])
  })
})

describe('schema conversion', () => {
  it('drops only the keywords llama.cpp chokes on', () => {
    const converted = toOpenAiParameters({
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: 'x',
      $comment: 'c',
      type: 'object',
      properties: { path: { type: 'string' }, mode: { enum: ['a', 'b'] } },
      required: ['path']
    })
    expect(converted).not.toHaveProperty('$schema')
    expect(converted).not.toHaveProperty('$id')
    expect(converted).not.toHaveProperty('$comment')
    expect(converted.required).toEqual(['path'])
    expect(converted).toHaveProperty('properties.mode.enum')
  })

  it('keeps $ref and $defs so references still resolve', () => {
    const converted = toOpenAiParameters({
      type: 'object',
      properties: { a: { $ref: '#/$defs/a' } },
      $defs: { a: { type: 'string' } }
    })
    expect(converted).toHaveProperty('$defs')
  })

  it('repairs a missing or non-object schema', () => {
    expect(toOpenAiParameters(undefined)).toEqual({ type: 'object', properties: {} })
    expect(toOpenAiParameters({ type: 'string' })).toMatchObject({ type: 'object' })
  })

  it('pads an empty description because some templates reject it', () => {
    expect(toOpenAiTool('t', '   ', {}).function.description).toBe('t')
  })
})

describe('result normalization', () => {
  it('joins text blocks and keeps isError out of the content', () => {
    const result = normalizeToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, 1000)
    expect(result.content).toBe('a\nb')
    expect(result.ok).toBe(true)
  })

  it('marks an error result and prefixes the content', () => {
    const result = normalizeToolResult({ content: [{ type: 'text', text: 'boom' }], isError: true }, 1000)
    expect(result.ok).toBe(false)
    expect(result.content).toContain('[tool error]')
  })

  it('replaces image blocks with a text placeholder', () => {
    const result = normalizeToolResult({ content: [{ type: 'image', mimeType: 'image/png' }] }, 1000)
    expect(result.content).toBe('[image: image/png]')
  })

  it('never returns an empty string', () => {
    expect(normalizeToolResult({ content: [] }, 1000).content.length).toBeGreaterThan(0)
  })

  it('truncates a long result and reports it', () => {
    const result = normalizeToolResult({ content: [{ type: 'text', text: 'x'.repeat(500) }] }, 120)
    expect(result.truncated).toBe(true)
    expect(result.content).toContain('omitted')
    expect(result.content.length).toBeLessThanOrEqual(130)
  })

  it('leaves a short result untouched', () => {
    expect(truncateMiddle('hello', 100)).toEqual({ text: 'hello', truncated: false })
  })
})

describe('risk classification', () => {
  it('trusts an explicit destructive hint', () => {
    expect(classifyToolRisk('read_file', true, true).risk).toBe('destructive')
  })

  it('trusts an explicit read-only hint', () => {
    expect(classifyToolRisk('delete_file', true, null).risk).toBe('read-only')
  })

  it('treats a declared non-read-only tool as destructive', () => {
    expect(classifyToolRisk('anything', false, null).risk).toBe('destructive')
  })

  it('falls back to the name when there are no annotations', () => {
    expect(classifyToolRisk('read_file', null, null).risk).toBe('read-only')
    expect(classifyToolRisk('write_file', null, null).risk).toBe('destructive')
    expect(classifyToolRisk('run_shell', null, null).risk).toBe('destructive')
  })

  it('is cautious about an unrecognisable name only when no hint exists', () => {
    expect(classifyToolRisk('summarize', null, null).risk).toBe('read-only')
  })
})
