import { describe, expect, it } from 'vitest'
import { buildServerArgs, redactArgs, splitArgs, type ServerArgsInput } from '../src/main/llama/args'

const BASE: ServerArgsInput = {
  modelPath: 'C:\\models\\qwen.gguf',
  mmprojPath: null,
  host: '127.0.0.1',
  port: 8080,
  apiKey: 'secret-token',
  gpuLayers: 33,
  contextSize: 4096,
  kvCacheType: 'q4_0',
  threads: 8,
  batchSize: 512,
  ubatchSize: 128,
  flashAttention: true,
  useMmap: true,
  useMlock: false
}

function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

describe('splitArgs', () => {
  it('splits on whitespace', () => {
    expect(splitArgs('--no-context-shift --seed 42')).toEqual([
      '--no-context-shift',
      '--seed',
      '42'
    ])
  })

  it('keeps quoted groups together', () => {
    expect(splitArgs('--alias "my model" --stop "<|end|>"')).toEqual([
      '--alias',
      'my model',
      '--stop',
      '<|end|>'
    ])
  })

  it('ignores repeated and trailing whitespace', () => {
    expect(splitArgs('   --foo    bar   ')).toEqual(['--foo', 'bar'])
    expect(splitArgs('')).toEqual([])
  })
})

describe('buildServerArgs', () => {
  it('always pins the mandatory flags', () => {
    const args = buildServerArgs(BASE)

    expect(valueOf(args, '--model')).toBe(BASE.modelPath)
    expect(valueOf(args, '--host')).toBe('127.0.0.1')
    expect(valueOf(args, '--port')).toBe('8080')
    expect(valueOf(args, '--api-key')).toBe('secret-token')
    // One slot keeps the KV cache at exactly one context worth of memory.
    expect(valueOf(args, '--parallel')).toBe('1')
    expect(valueOf(args, '--ctx-size')).toBe('4096')
    expect(valueOf(args, '--n-gpu-layers')).toBe('33')
    expect(valueOf(args, '--cache-type-k')).toBe('q4_0')
    expect(valueOf(args, '--cache-type-v')).toBe('q4_0')
    expect(valueOf(args, '--flash-attn')).toBe('on')
    expect(args).toContain('--jinja')
    expect(args).toContain('--no-webui')
  })

  it('omits --no-mmap and --mlock by default', () => {
    const args = buildServerArgs(BASE)
    expect(args).not.toContain('--no-mmap')
    expect(args).not.toContain('--mlock')
  })

  it('turns off mmap and on mlock when requested', () => {
    const args = buildServerArgs({ ...BASE, useMmap: false, useMlock: true })
    expect(args).toContain('--no-mmap')
    expect(args).toContain('--mlock')
  })

  it('adds the projector only when one is configured', () => {
    expect(buildServerArgs(BASE)).not.toContain('--mmproj')
    const withProjector = buildServerArgs({ ...BASE, mmprojPath: 'C:\\models\\mmproj.gguf' })
    expect(valueOf(withProjector, '--mmproj')).toBe('C:\\models\\mmproj.gguf')
  })

  it('skips a blank alias but keeps a real one', () => {
    expect(buildServerArgs({ ...BASE, alias: '   ' })).not.toContain('--alias')
    expect(valueOf(buildServerArgs({ ...BASE, alias: ' qwen ' }), '--alias')).toBe('qwen')
  })

  it('appends user supplied arguments last so they win', () => {
    const args = buildServerArgs({ ...BASE, extraArgs: ['--seed', '7'] })
    expect(args.slice(-2)).toEqual(['--seed', '7'])
  })

  it('emits flash attention off when disabled', () => {
    expect(valueOf(buildServerArgs({ ...BASE, flashAttention: false }), '--flash-attn')).toBe('off')
  })
})

describe('redactArgs', () => {
  it('hides the api key', () => {
    const args = buildServerArgs(BASE)
    const line = redactArgs(args)
    expect(line).not.toContain('secret-token')
    expect(line).toContain('--api-key ***')
  })

  it('quotes arguments containing spaces', () => {
    expect(redactArgs(['--alias', 'my model'])).toBe('--alias "my model"')
  })
})
