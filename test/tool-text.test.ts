import { describe, expect, it } from 'vitest'
import { extractTextToolCalls } from '../src/main/agent/tool-text'

const KNOWN = new Set(['mcp__fs__read_file', 'builtin__skills_load'])
const isKnown = (name: string): boolean => KNOWN.has(name)

describe('extractTextToolCalls', () => {
  it('recovers a fenced call that names a real tool', () => {
    const content = ['Let me look.', '```json', '{"name":"mcp__fs__read_file","arguments":{"path":"a.txt"}}', '```'].join('\n')
    const result = extractTextToolCalls(content, isKnown)
    expect(result.calls).toEqual([
      { name: 'mcp__fs__read_file', args: { path: 'a.txt' } }
    ])
    expect(result.cleaned).not.toContain('mcp__fs__read_file')
  })

  it('keeps surrounding prose in the cleaned content', () => {
    const content = ['Intro.', '```json', '{"name":"builtin__skills_load","arguments":{"name":"x"}}', '```', 'Outro.'].join('\n')
    const result = extractTextToolCalls(content, isKnown)
    expect(result.cleaned).toContain('Intro.')
    expect(result.cleaned).toContain('Outro.')
  })

  it('accepts arguments given as a JSON string', () => {
    const content = '```json\n{"name":"builtin__skills_load","arguments":"{\\"name\\":\\"x\\"}"}\n```'
    expect(extractTextToolCalls(content, isKnown).calls[0]?.args).toEqual({ name: 'x' })
  })

  it('accepts a bare object when the whole reply is the call', () => {
    const result = extractTextToolCalls('{"name":"builtin__skills_load","arguments":{}}', isKnown)
    expect(result.calls).toHaveLength(1)
    expect(result.cleaned).toBe('')
  })

  it('ignores a call naming a tool that does not exist', () => {
    const content = '```json\n{"name":"nope","arguments":{}}\n```'
    const result = extractTextToolCalls(content, isKnown)
    expect(result.calls).toEqual([])
    expect(result.cleaned).toBe(content)
  })

  it('does not mistake an ordinary code sample for a call', () => {
    const content = [
      'Here is the config shape you asked about:',
      '```json',
      '{"name": "my-app", "version": "1.0.0"}',
      '```'
    ].join('\n')
    expect(extractTextToolCalls(content, isKnown).calls).toEqual([])
  })

  it('does not treat a JSON object in prose without a fence as a call', () => {
    const content = 'The object {"name":"builtin__skills_load"} is used for loading.'
    expect(extractTextToolCalls(content, isKnown).calls).toEqual([])
  })

  it('ignores a fence whose body is not JSON at all', () => {
    const content = '```\nnot json\n```'
    expect(extractTextToolCalls(content, isKnown).calls).toEqual([])
  })

  it('recovers several calls from one reply', () => {
    const content = [
      '```json',
      '{"name":"builtin__skills_load","arguments":{"name":"a"}}',
      '```',
      '```json',
      '{"name":"mcp__fs__read_file","arguments":{"path":"b"}}',
      '```'
    ].join('\n')
    expect(extractTextToolCalls(content, isKnown).calls).toHaveLength(2)
  })

  it('rejects a fenced call with no arguments object', () => {
    const content = '```json\n{"name":"builtin__skills_load","arguments":"not json"}\n```'
    expect(extractTextToolCalls(content, isKnown).calls).toEqual([])
  })
})
