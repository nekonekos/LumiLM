import { describe, expect, it } from 'vitest'
import { extractTextToolCalls, normalizeJsonish } from '../src/main/agent/tool-text'

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
    // Text after a real call is dropped: that is where a model invents a result.
    expect(result.cleaned).not.toContain('Outro.')
    expect(result.cleaned).not.toContain('```')
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

  it('accepts "tool" as the name key', () => {
    const content = '```json\n{"tool":"builtin__skills_load","args":{"name":"x"}}\n```'
    expect(extractTextToolCalls(content, isKnown).calls).toEqual([
      { name: 'builtin__skills_load', args: { name: 'x' } }
    ])
  })

  it('accepts an OpenAI style nested function object', () => {
    const content =
      '```json\n{"function":{"name":"mcp__fs__read_file","arguments":{"path":"a"}}}\n```'
    expect(extractTextToolCalls(content, isKnown).calls[0]?.name).toBe('mcp__fs__read_file')
  })

  it('accepts "input" as the arguments key', () => {
    const content = '```json\n{"name":"builtin__skills_load","input":{"name":"x"}}\n```'
    expect(extractTextToolCalls(content, isKnown).calls[0]?.args).toEqual({ name: 'x' })
  })

  it('reports a call-shaped block that names no loaded tool', () => {
    const content = '```json\n{"tool":"file_list","args":{"path":"."}}\n```'
    const result = extractTextToolCalls(content, isKnown)
    expect(result.calls).toEqual([])
    expect(result.unknown).toEqual(['file_list'])
    // The block stays visible: it is the only clue the user gets.
    expect(result.cleaned).toBe(content)
  })

  it('lists each unknown name once', () => {
    const content = [
      '```json',
      '{"tool":"file_list","args":{}}',
      '```',
      '```json',
      '{"tool":"file_list","args":{}}',
      '```'
    ].join('\n')
    expect(extractTextToolCalls(content, isKnown).unknown).toEqual(['file_list'])
  })

  it('does not report an ordinary object with a name but no arguments', () => {
    const content = '```json\n{"name":"my-app","version":"1.0.0"}\n```'
    expect(extractTextToolCalls(content, isKnown).unknown).toEqual([])
  })
})

describe('lenient JSON', () => {
  // A real reply from a local model: a comment after a value plus a trailing comma.
  it('recovers the shape a local model actually emits', () => {
    const content = [
      '```json',
      '{',
      '  "tool": "mcp__fs__read_file",',
      '  "args": {',
      '    "path": ".", // 当前目录，即工作区根目录',
      '  }',
      '}',
      '```'
    ].join('\n')
    const result = extractTextToolCalls(content, isKnown)
    expect(result.calls).toEqual([{ name: 'mcp__fs__read_file', args: { path: '.' } }])
    expect(result.unknown).toEqual([])
  })

  it('recovers a call that only has a trailing comma', () => {
    const content = '```json\n{"tool":"builtin__skills_load","args":{"name":"x",},}\n```'
    expect(extractTextToolCalls(content, isKnown).calls[0]?.args).toEqual({ name: 'x' })
  })

  it('recovers a call that only has a comment', () => {
    const content = '```json\n{"tool":"builtin__skills_load","args":{"name":"x"}} // load it\n```'
    expect(extractTextToolCalls(content, isKnown).calls[0]?.name).toBe('builtin__skills_load')
  })

  it('strips block comments', () => {
    const content = '```json\n{/* why */"tool":"builtin__skills_load","args":{}}\n```'
    expect(extractTextToolCalls(content, isKnown).calls).toHaveLength(1)
  })

  it('leaves a // inside a string value alone', () => {
    const content = '```json\n{"tool":"mcp__fs__read_file","args":{"path":"http://x/y"}}\n```'
    expect(extractTextToolCalls(content, isKnown).calls[0]?.args).toEqual({ path: 'http://x/y' })
  })

  it('does not turn a commented code sample into a call', () => {
    const content = [
      '```json',
      '{',
      '  "name": "my-app", // the app name',
      '  "version": "1.0.0",',
      '}',
      '```'
    ].join('\n')
    const result = extractTextToolCalls(content, isKnown)
    expect(result.calls).toEqual([])
    expect(result.unknown).toEqual([])
  })

  it('still reports an unknown tool written with a comment', () => {
    const content = '```json\n{"tool":"file_list","args":{}} // guess\n```'
    const result = extractTextToolCalls(content, isKnown)
    expect(result.unknown).toEqual(['file_list'])
    expect(result.cleaned).toBe(content)
  })
})

describe('the shape a local model actually invents', () => {
  // Straight from a real reply: "action" as the name key, the parameters
  // flattened next to it, then a made-up run of the tool.
  const invented = [
    'Then run `python bubble_sort.py`.',
    '',
    'Here are the steps:',
    '',
    '```json',
    '{',
    '  "action": "builtin__skills_load",',
    '  "name": "pdf",',
    '}',
    '```',
    '',
    'This writes the code.',
    '',
    '```json',
    '{"action":"builtin__skills_load","name":"pdf"}',
    '```',
    '',
    'Now, let me simulate the output. The script will print:',
    '',
    '```',
    'original array: [64, 34, 25]',
    '```'
  ].join('\n')

  it('accepts "action" as the name key', () => {
    const content = '```json\n{"action":"builtin__skills_load","args":{"name":"x"}}\n```'
    expect(extractTextToolCalls(content, isKnown).calls).toEqual([
      { name: 'builtin__skills_load', args: { name: 'x' } }
    ])
  })

  it('collects parameters that sit next to the name', () => {
    const content = '```json\n{"action":"builtin__skills_load","name":"pdf"}\n```'
    expect(extractTextToolCalls(content, isKnown).calls[0]?.args).toEqual({ name: 'pdf' })
  })

  it('does not treat the name key itself as an argument', () => {
    const content = '```json\n{"action":"builtin__skills_load","args":{}}\n```'
    expect(extractTextToolCalls(content, isKnown).calls[0]?.args).toEqual({})
  })

  it('drops everything the model wrote after the call', () => {
    const result = extractTextToolCalls(invented, isKnown)
    expect(result.calls).toHaveLength(2)
    expect(result.cleaned).toBe('Then run `python bubble_sort.py`.\n\nHere are the steps:')
    expect(result.cleaned).not.toContain('simulate')
    expect(result.cleaned).not.toContain('original array')
    expect(result.cleaned).not.toContain('```json')
  })

  it('keeps a reply that merely describes a tool without calling one', () => {
    const content = 'I would use `builtin__list_files` to look around.'
    expect(extractTextToolCalls(content, isKnown).cleaned).toBe(content)
  })

  it('keeps prose that follows an unknown-tool block, since nothing ran', () => {
    const content = 'Let me look.\n```json\n{"action":"file_list","path":"."}\n```\nDone.'
    const result = extractTextToolCalls(content, isKnown)
    expect(result.calls).toEqual([])
    expect(result.unknown).toEqual(['file_list'])
    expect(result.cleaned).toBe(content)
  })
})

describe('normalizeJsonish', () => {
  it('is a no-op for strict JSON', () => {
    const strict = '{"a":[1,2],"b":"//not a comment"}'
    expect(normalizeJsonish(strict)).toBe(strict)
  })

  it('drops a trailing comma before a bracket', () => {
    expect(normalizeJsonish('{"a":[1,2,],}')).toBe('{"a":[1,2]}')
  })
})
