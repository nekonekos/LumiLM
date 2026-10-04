import { closeSync, openSync, readSync, statSync } from 'node:fs'
import type { GgufMetadata } from '@shared/types'

const GGUF_MAGIC = 0x46554747 // "GGUF"
const CHUNK_SIZE = 1024 * 1024
const MAX_KEPT_ARRAY = 1024
const MAX_TENSORS_TO_SCAN = 200_000

const VT = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12
} as const

type Scalar = string | number | boolean | bigint

/** Approximation of bits per weight for each quantisation family. */
const BITS_PER_WEIGHT: Array<[RegExp, number]> = [
  [/^IQ1/, 1.6],
  [/^IQ2/, 2.2],
  [/^Q2_K/, 2.63],
  [/^IQ3/, 3.4],
  [/^Q3_K/, 3.4],
  [/MXFP4/, 4.25],
  [/^IQ4/, 4.25],
  [/^Q4_0/, 4.55],
  [/^Q4_1/, 5.0],
  [/^Q4_K/, 4.85],
  [/^Q5_0/, 5.54],
  [/^Q5_1/, 6.0],
  [/^Q5_K/, 5.67],
  [/^Q6_K/, 6.56],
  [/^Q8_0/, 8.5],
  [/^BF16/, 16],
  [/^F16/, 16],
  [/^F32/, 32]
]

/** Known quantisation tokens, longest first so `Q4_K_M` wins over `Q4_K`. */
const QUANT_TOKENS = [
  'IQ1_S',
  'IQ1_M',
  'IQ2_XXS',
  'IQ2_XS',
  'IQ2_S',
  'IQ2_M',
  'IQ3_XXS',
  'IQ3_XS',
  'IQ3_S',
  'IQ3_M',
  'IQ4_NL',
  'IQ4_XS',
  'MXFP4',
  'Q2_K_S',
  'Q2_K',
  'Q3_K_S',
  'Q3_K_M',
  'Q3_K_L',
  'Q3_K',
  'Q4_0',
  'Q4_1',
  'Q4_K_S',
  'Q4_K_M',
  'Q4_K',
  'Q5_0',
  'Q5_1',
  'Q5_K_S',
  'Q5_K_M',
  'Q5_K',
  'Q6_K',
  'Q8_0',
  'BF16',
  'F16',
  'F32'
]

const FILE_TYPE_NAMES: Record<number, string> = {
  0: 'F32',
  1: 'F16',
  2: 'Q4_0',
  3: 'Q4_1',
  7: 'Q8_0',
  8: 'Q5_0',
  9: 'Q5_1',
  10: 'Q2_K',
  11: 'Q3_K_S',
  12: 'Q3_K_M',
  13: 'Q3_K_L',
  14: 'Q4_K_S',
  15: 'Q4_K_M',
  16: 'Q5_K_S',
  17: 'Q5_K_M',
  18: 'Q6_K',
  19: 'IQ2_XXS',
  20: 'IQ2_XS',
  21: 'Q2_K_S',
  22: 'IQ3_XS',
  23: 'IQ3_XXS',
  24: 'IQ1_S',
  25: 'IQ4_NL',
  26: 'IQ3_S',
  27: 'IQ3_M',
  28: 'IQ2_S',
  29: 'IQ2_M',
  30: 'IQ4_XS',
  31: 'IQ1_M',
  32: 'BF16'
}

const KEPT_KEYS = new Set([
  'general.architecture',
  'general.name',
  'general.basename',
  'general.file_type',
  'tokenizer.chat_template',
  'clip.has_vision_encoder',
  'clip.has_text_encoder',
  'clip.projector_type'
])

const KEPT_SUFFIXES = [
  '.context_length',
  '.embedding_length',
  '.block_count',
  '.attention.head_count',
  '.attention.head_count_kv',
  '.attention.key_length',
  '.attention.value_length'
]

function shouldKeep(key: string): boolean {
  if (KEPT_KEYS.has(key)) return true
  return KEPT_SUFFIXES.some((suffix) => key.endsWith(suffix))
}

/**
 * Incremental little-endian reader over an open file handle. Large metadata
 * payloads (tokenizer vocabularies can be multi-megabyte string arrays) are
 * measured and skipped without ever being materialised in memory.
 */
class SyncReader {
  private readonly fd: number
  private buffer: Buffer = Buffer.alloc(0)
  private bufferStart = 0
  private cursor = 0

  constructor(filePath: string) {
    this.fd = openSync(filePath, 'r')
  }

  close(): void {
    closeSync(this.fd)
  }

  private refill(needed: number): void {
    const absolute = this.bufferStart + this.cursor
    const readSize = Math.max(needed, CHUNK_SIZE)
    const target = Buffer.allocUnsafe(readSize)
    const bytesRead = readSync(this.fd, target, 0, readSize, absolute)
    this.buffer = target.subarray(0, bytesRead)
    this.bufferStart = absolute
    this.cursor = 0
  }

  private ensure(count: number): void {
    if (this.cursor + count > this.buffer.length) this.refill(count)
    if (this.cursor + count > this.buffer.length) throw new Error('unexpected end of GGUF file')
  }

  skip(count: number): void {
    if (count <= 0) return
    if (this.cursor + count <= this.buffer.length) {
      this.cursor += count
      return
    }
    this.bufferStart += this.cursor + count
    this.cursor = 0
    this.buffer = Buffer.alloc(0)
  }

  uint8(): number {
    this.ensure(1)
    const value = this.buffer.readUInt8(this.cursor)
    this.cursor += 1
    return value
  }

  uint16(): number {
    this.ensure(2)
    const value = this.buffer.readUInt16LE(this.cursor)
    this.cursor += 2
    return value
  }

  int16(): number {
    this.ensure(2)
    const value = this.buffer.readInt16LE(this.cursor)
    this.cursor += 2
    return value
  }

  uint32(): number {
    this.ensure(4)
    const value = this.buffer.readUInt32LE(this.cursor)
    this.cursor += 4
    return value
  }

  int32(): number {
    this.ensure(4)
    const value = this.buffer.readInt32LE(this.cursor)
    this.cursor += 4
    return value
  }

  float32(): number {
    this.ensure(4)
    const value = this.buffer.readFloatLE(this.cursor)
    this.cursor += 4
    return value
  }

  float64(): number {
    this.ensure(8)
    const value = this.buffer.readDoubleLE(this.cursor)
    this.cursor += 8
    return value
  }

  uint64(): bigint {
    this.ensure(8)
    const value = this.buffer.readBigUInt64LE(this.cursor)
    this.cursor += 8
    return value
  }

  int64(): bigint {
    this.ensure(8)
    const value = this.buffer.readBigInt64LE(this.cursor)
    this.cursor += 8
    return value
  }

  bool(): boolean {
    return this.uint8() !== 0
  }

  string(): string {
    const length = Number(this.uint64())
    if (length === 0) return ''
    this.ensure(length)
    const value = this.buffer.toString('utf8', this.cursor, this.cursor + length)
    this.cursor += length
    return value
  }

  skipString(): void {
    this.skip(Number(this.uint64()))
  }

  readScalar(type: number): Scalar {
    switch (type) {
      case VT.UINT8:
        return this.uint8()
      case VT.INT8: {
        const raw = this.uint8()
        return raw > 127 ? raw - 256 : raw
      }
      case VT.UINT16:
        return this.uint16()
      case VT.INT16:
        return this.int16()
      case VT.UINT32:
        return this.uint32()
      case VT.INT32:
        return this.int32()
      case VT.FLOAT32:
        return this.float32()
      case VT.BOOL:
        return this.bool()
      case VT.STRING:
        return this.string()
      case VT.UINT64:
        return this.uint64()
      case VT.INT64:
        return this.int64()
      case VT.FLOAT64:
        return this.float64()
      default:
        throw new Error(`unsupported GGUF value type ${type}`)
    }
  }

  skipScalar(type: number): void {
    switch (type) {
      case VT.UINT8:
      case VT.INT8:
      case VT.BOOL:
        this.skip(1)
        return
      case VT.UINT16:
      case VT.INT16:
        this.skip(2)
        return
      case VT.UINT32:
      case VT.INT32:
      case VT.FLOAT32:
        this.skip(4)
        return
      case VT.UINT64:
      case VT.INT64:
      case VT.FLOAT64:
        this.skip(8)
        return
      case VT.STRING:
        this.skipString()
        return
      default:
        throw new Error(`unsupported GGUF value type ${type}`)
    }
  }

  readNumberArray(elemType: number, count: number): number[] {
    const values: number[] = []
    for (let i = 0; i < count; i += 1) {
      const raw = this.readScalar(elemType)
      values.push(typeof raw === 'bigint' ? Number(raw) : Number(raw))
    }
    return values
  }

  skipStringArray(count: number): void {
    for (let i = 0; i < count; i += 1) this.skipString()
  }
}

function lastSuffixValue(
  entries: Map<string, Scalar | number[]>,
  suffix: string
): Scalar | number[] | undefined {
  let found: Scalar | number[] | undefined
  for (const [key, value] of entries) {
    if (key.endsWith(suffix)) found = value
  }
  return found
}

function toNumber(value: Scalar | number[] | undefined): number | null {
  if (value === undefined) return null
  if (Array.isArray(value)) return value.length > 0 ? Math.max(...value) : null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function toText(value: Scalar | number[] | undefined): string | null {
  return typeof value === 'string' ? value : null
}

/** Extracts a quantisation token such as `Q4_K_M` from a model file name. */
export function detectQuantization(fileName: string): string | null {
  const upper = fileName.toUpperCase()
  for (const token of QUANT_TOKENS) {
    const pattern = new RegExp(`(^|[^A-Z0-9])${token}([^A-Z0-9]|$)`)
    if (pattern.test(upper)) return token
  }
  return null
}

export function bitsPerWeight(quant: string | null): number | null {
  if (!quant) return null
  const upper = quant.toUpperCase()
  for (const [pattern, bpw] of BITS_PER_WEIGHT) {
    if (pattern.test(upper)) return bpw
  }
  return null
}

/** Parses GGUF metadata. Throws when the file is not a readable GGUF container. */
export function readGgufMetadata(filePath: string, fileName: string): GgufMetadata {
  const reader = new SyncReader(filePath)
  try {
    const magic = reader.uint32()
    if (magic !== GGUF_MAGIC) throw new Error('not a GGUF file (bad magic)')

    const ggufVersion = reader.uint32()
    if (ggufVersion < 1 || ggufVersion > 3) {
      throw new Error(`unsupported GGUF version ${ggufVersion}`)
    }

    const uses64BitCounts = ggufVersion >= 2
    const tensorCount = uses64BitCounts ? Number(reader.uint64()) : reader.uint32()
    const kvCount = uses64BitCounts ? Number(reader.uint64()) : reader.uint32()

    const entries = new Map<string, Scalar | number[]>()

    for (let i = 0; i < kvCount; i += 1) {
      const key = reader.string()
      const type = reader.uint32()
      const keep = shouldKeep(key)

      if (type === VT.ARRAY) {
        const elemType = reader.uint32()
        const count = Number(reader.uint64())

        if (elemType === VT.ARRAY) throw new Error('nested GGUF arrays are not supported')
        if (elemType === VT.STRING) {
          reader.skipStringArray(count)
        } else if (keep && count > 0 && count <= MAX_KEPT_ARRAY) {
          entries.set(key, reader.readNumberArray(elemType, count))
        } else {
          for (let n = 0; n < count; n += 1) reader.skipScalar(elemType)
        }
        continue
      }

      if (keep) entries.set(key, reader.readScalar(type))
      else reader.skipScalar(type)
    }

    let tensorParameterCount: number | null = null
    if (tensorCount > 0 && tensorCount <= MAX_TENSORS_TO_SCAN) {
      let total = 0n
      for (let i = 0; i < tensorCount; i += 1) {
        reader.skipString()
        const dimensions = reader.uint32()
        let elements = 1n
        for (let d = 0; d < dimensions; d += 1) {
          const size = reader.uint64()
          if (size > 0n) elements *= size
        }
        reader.uint32() // ggml tensor type
        reader.uint64() // offset into the data section
        total += elements
      }
      tensorParameterCount = Number(total)
    }

    const architecture = toText(entries.get('general.architecture'))
    const embeddingLength = toNumber(lastSuffixValue(entries, '.embedding_length'))
    const headCount = toNumber(lastSuffixValue(entries, '.attention.head_count'))
    const headCountKv = toNumber(lastSuffixValue(entries, '.attention.head_count_kv'))
    const fileType = toNumber(entries.get('general.file_type'))

    let keyLength = toNumber(lastSuffixValue(entries, '.attention.key_length'))
    let valueLength = toNumber(lastSuffixValue(entries, '.attention.value_length'))
    if ((keyLength === null || valueLength === null) && embeddingLength && headCount) {
      const derived = Math.floor(embeddingLength / headCount)
      keyLength = keyLength ?? derived
      valueLength = valueLength ?? derived
    }

    const quantFromName = detectQuantization(fileName)
    const quantization =
      quantFromName ?? (fileType !== null ? (FILE_TYPE_NAMES[fileType] ?? null) : null)

    const bpw = bitsPerWeight(quantization)
    const parameterCount = tensorParameterCount ?? (bpw ? Math.round((statSync(filePath).size * 8) / bpw) : null)

    return {
      ggufVersion,
      architecture,
      name: toText(entries.get('general.name')),
      parameterCount,
      contextLength: toNumber(lastSuffixValue(entries, '.context_length')),
      embeddingLength,
      blockCount: toNumber(lastSuffixValue(entries, '.block_count')),
      headCount,
      headCountKv,
      keyLength,
      valueLength,
      quantization,
      chatTemplate: toText(entries.get('tokenizer.chat_template')),
      isProjector:
        architecture === 'clip' ||
        /mmproj/i.test(fileName) ||
        toNumber(entries.get('clip.has_vision_encoder')) === 1,
      fileType
    }
  } finally {
    reader.close()
  }
}
