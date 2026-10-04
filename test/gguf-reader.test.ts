import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bitsPerWeight, detectQuantization, readGgufMetadata } from '../src/main/gguf/reader'

const DOWNLOADS_MODEL = join(
  homedir(),
  'Downloads',
  'Qwen3.5-9B-DeepSeek-V4-Flash-Q4_K_M.gguf'
)

describe('detectQuantization', () => {
  it('reads the quantisation token from the file name', () => {
    expect(detectQuantization('Qwen3.5-9B-DeepSeek-V4-Flash-Q4_K_M.gguf')).toBe('Q4_K_M')
    expect(detectQuantization('llama-3-8b-instruct-q5_k_s.gguf')).toBe('Q5_K_S')
    expect(detectQuantization('model-Q8_0.gguf')).toBe('Q8_0')
    expect(detectQuantization('model-f16.gguf')).toBe('F16')
  })

  it('ignores lookalike substrings', () => {
    // "IQ4_XS" must not be matched as "Q4_XS" inside another word is fine, but
    // an embedded token in an unrelated word must not match.
    expect(detectQuantization('noquanthere.gguf')).toBeNull()
  })
})

describe('bitsPerWeight', () => {
  it('maps the common quantisations', () => {
    expect(bitsPerWeight('Q4_K_M')).toBeCloseTo(4.85, 1)
    expect(bitsPerWeight('Q8_0')).toBeCloseTo(8.5, 1)
    expect(bitsPerWeight('F16')).toBe(16)
  })

  it('returns null for unknown or missing input', () => {
    expect(bitsPerWeight(null)).toBeNull()
    expect(bitsPerWeight('NOT_A_QUANT')).toBeNull()
  })
})

describe('readGgufMetadata', () => {
  it('rejects a file that is not a GGUF container', () => {
    expect(() => readGgufMetadata(import.meta.filename, 'reader.test.ts')).toThrow()
  })

  it.skipIf(!existsSync(DOWNLOADS_MODEL))(
    'parses the model that ships on this machine',
    () => {
      const fileName = 'Qwen3.5-9B-DeepSeek-V4-Flash-Q4_K_M.gguf'
      const metadata = readGgufMetadata(DOWNLOADS_MODEL, fileName)

      expect(metadata.ggufVersion).toBeGreaterThanOrEqual(2)
      expect(metadata.isProjector).toBe(false)
      expect(metadata.architecture).toBeTruthy()
      expect(metadata.blockCount).toBeGreaterThan(0)
      expect(metadata.embeddingLength).toBeGreaterThan(0)
      expect(metadata.contextLength).toBeGreaterThan(0)
      // Auto-tune needs these to size the KV cache.
      expect(metadata.headCount).toBeGreaterThan(0)
      expect(metadata.headCountKv).toBeGreaterThan(0)
      expect(metadata.quantization).toBe('Q4_K_M')
    }
  )
})
