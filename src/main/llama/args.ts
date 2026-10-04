import type { KvCacheType } from '@shared/types'

export interface ServerArgsInput {
  modelPath: string
  mmprojPath: string | null
  host: string
  port: number
  apiKey: string
  alias?: string | null
  gpuLayers: number
  contextSize: number
  kvCacheType: KvCacheType
  threads: number
  batchSize: number
  ubatchSize: number
  flashAttention: boolean
  useMmap: boolean
  useMlock: boolean
  /** raw additional arguments supplied by the user in the advanced settings */
  extraArgs?: string[]
}

/** Splits a raw argument string, honouring single and double quotes. */
export function splitArgs(raw: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (const char of raw) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += char
  }

  if (current.length > 0) args.push(current)
  return args
}

/**
 * Builds the llama-server command line. Flags that are always safe on the
 * pinned llama.cpp build are emitted explicitly so behaviour does not depend on
 * upstream defaults.
 */
export function buildServerArgs(input: ServerArgsInput): string[] {
  const args: string[] = [
    '--model',
    input.modelPath,
    '--host',
    input.host,
    '--port',
    String(input.port),
    '--api-key',
    input.apiKey,
    // A single slot keeps the KV cache allocation to exactly one context.
    '--parallel',
    '1',
    '--ctx-size',
    String(input.contextSize),
    '--n-gpu-layers',
    String(input.gpuLayers),
    '--threads',
    String(input.threads),
    '--batch-size',
    String(input.batchSize),
    '--ubatch-size',
    String(input.ubatchSize),
    '--cache-type-k',
    input.kvCacheType,
    '--cache-type-v',
    input.kvCacheType,
    '--flash-attn',
    input.flashAttention ? 'on' : 'off',
    // Use the chat template embedded in the GGUF file.
    '--jinja',
    // LumiLM ships its own interface.
    '--no-webui'
  ]

  if (!input.useMmap) args.push('--no-mmap')
  if (input.useMlock) args.push('--mlock')
  if (input.mmprojPath) args.push('--mmproj', input.mmprojPath)
  if (input.alias && input.alias.trim().length > 0) args.push('--alias', input.alias.trim())
  if (input.extraArgs && input.extraArgs.length > 0) args.push(...input.extraArgs)

  return args
}

/** Redacts the API key so the command line can be shown in the UI and logs. */
export function redactArgs(args: string[]): string {
  return args
    .map((arg, index) => {
      const previous = args[index - 1]
      if (previous === '--api-key') return '***'
      return /\s/.test(arg) ? `"${arg}"` : arg
    })
    .join(' ')
}
