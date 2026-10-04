import type {
  ConcreteBackend,
  HardwareInfo,
  KvCacheType,
  ModelInfo,
  PerfPreset,
  RecommendedParams
} from '@shared/types'
import { primaryVramBytes } from './hardware'

const MIB = 1024 * 1024
const GIB = 1024 * MIB

/** Bytes per KV cache element, including the block scale overhead for quantised types. */
const BYTES_PER_KV_ELEMENT: Record<KvCacheType, number> = {
  f16: 2,
  q8_0: 1.0625,
  q4_0: 0.5625
}

/** Runtime overhead beyond weights and KV cache: CUDA context, graph buffers, cuBLAS workspace. */
const COMPUTE_BUFFER_BYTES: Record<ConcreteBackend, number> = {
  cuda: 640 * MIB,
  vulkan: 512 * MIB,
  cpu: 0
}

export interface PresetDefaults {
  preferredContext: number
  kvCacheType: KvCacheType
  reserveMultiplier: number
  maxThreads: number
  batchSize: number
  ubatchSize: number
}

const PRESETS: Record<PerfPreset, PresetDefaults> = {
  'low-vram': {
    preferredContext: 2048,
    kvCacheType: 'q4_0',
    reserveMultiplier: 1.5,
    maxThreads: 6,
    batchSize: 256,
    ubatchSize: 64
  },
  balanced: {
    preferredContext: 4096,
    kvCacheType: 'q4_0',
    reserveMultiplier: 1.0,
    maxThreads: 8,
    batchSize: 512,
    ubatchSize: 128
  },
  performance: {
    preferredContext: 8192,
    kvCacheType: 'f16',
    reserveMultiplier: 0.5,
    maxThreads: 16,
    batchSize: 1024,
    ubatchSize: 256
  }
}

export function presetDefaults(preset: PerfPreset): PresetDefaults {
  return PRESETS[preset]
}

export interface TuneInput {
  model: ModelInfo
  hardware: HardwareInfo
  preset: PerfPreset
  backend: ConcreteBackend
  /** MiB of VRAM to keep free for the OS and other applications */
  vramReserveMb: number
  /** the multimodal projector is loaded alongside the model when enabled */
  mmprojEnabled: boolean
  /** projector file size in bytes, when known */
  mmprojBytes?: number
}

interface ModelShape {
  totalLayers: number
  kvHeads: number
  headDim: number
  kvBytesPerToken: (kv: KvCacheType) => number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function roundDownToMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.floor(value / multiple) * multiple)
}

function resolveShape(model: ModelInfo): ModelShape {
  const meta = model.metadata
  const blockCount = meta?.blockCount ?? 32
  const totalLayers = Math.max(1, blockCount + 1)

  const headCount = meta?.headCount ?? 32
  const kvHeads = Math.max(1, meta?.headCountKv ?? headCount)
  const headDim =
    meta?.keyLength ??
    (meta?.embeddingLength ? Math.max(1, Math.floor(meta.embeddingLength / headCount)) : 128)

  return {
    totalLayers,
    kvHeads,
    headDim,
    kvBytesPerToken: (kv) => 2 * totalLayers * kvHeads * headDim * BYTES_PER_KV_ELEMENT[kv]
  }
}

/**
 * Computes conservative llama.cpp parameters for the current machine.
 *
 * The heuristic keeps a safety margin on VRAM, quantises the KV cache on
 * low-end GPUs and falls back to a smaller context when the model must run
 * partly or fully on the CPU.
 */
export function computeRecommendation(input: TuneInput): RecommendedParams {
  const { model, hardware, backend } = input
  const preset = PRESETS[input.preset]
  const notes: string[] = []

  const shape = resolveShape(model)
  const weightsBytes = model.sizeBytes
  const modelContextLimit = model.metadata?.contextLength ?? preset.preferredContext

  const projectorBytes =
    input.mmprojEnabled && input.mmprojBytes && input.mmprojBytes > 0 ? input.mmprojBytes : 0

  const vramBytes = primaryVramBytes(hardware)
  const hasGpu = backend !== 'cpu' && vramBytes > 0

  const kvCacheType: KvCacheType = preset.kvCacheType
  let contextSize = Math.min(preset.preferredContext, modelContextLimit)

  const reserveBytes = Math.round(input.vramReserveMb * preset.reserveMultiplier) * MIB
  const computeBuffer = COMPUTE_BUFFER_BYTES[backend]

  let gpuLayers = 0
  let estimatedVramBytes = 0

  if (hasGpu) {
    const kvBytes = shape.kvBytesPerToken(kvCacheType) * contextSize
    const available = vramBytes - reserveBytes - computeBuffer - kvBytes - projectorBytes
    const perLayer = weightsBytes / shape.totalLayers

    if (available >= perLayer) {
      gpuLayers = clamp(Math.floor(available / perLayer), 1, shape.totalLayers)
    } else {
      gpuLayers = 0
    }

    estimatedVramBytes = Math.min(weightsBytes, gpuLayers * perLayer) + kvBytes + computeBuffer
  } else {
    notes.push('tune.notes.cpuOnly')
  }

  const fitsFullyInVram = gpuLayers >= shape.totalLayers
  if (hasGpu && !fitsFullyInVram && gpuLayers > 0) {
    notes.push('tune.notes.partialOffload')
  }
  if (hasGpu && gpuLayers > 0 && gpuLayers < shape.totalLayers / 4) {
    notes.push('tune.notes.tooFewLayers')
  }

  // When the model (partly) runs on the CPU the KV cache also lives in RAM, so
  // the context has to fit into system memory as well.
  const cpuShareBytes = weightsBytes * (1 - gpuLayers / shape.totalLayers)
  const kvPerToken = shape.kvBytesPerToken(kvCacheType)
  const ramBudget = hardware.totalRamBytes * 0.7 - cpuShareBytes
  if (kvPerToken > 0) {
    const maxContextByRam = Math.floor(ramBudget / kvPerToken)
    if (Number.isFinite(maxContextByRam) && maxContextByRam < contextSize) {
      contextSize = Math.max(512, roundDownToMultiple(maxContextByRam, 256))
      notes.push('tune.notes.contextLimitedByRam')
    }
  }
  contextSize = clamp(contextSize, 512, modelContextLimit)

  const totalRam = hardware.totalRamBytes
  const threadCap = totalRam < 8 * GIB ? 4 : preset.maxThreads
  const threads = clamp(hardware.physicalCores, 1, threadCap)

  let batchSize = preset.batchSize
  let ubatchSize = preset.ubatchSize
  if (totalRam < 8 * GIB) {
    batchSize = Math.min(batchSize, 256)
    ubatchSize = Math.min(ubatchSize, 64)
    notes.push('tune.notes.lowRam')
  }

  const flashAttention = kvCacheType !== 'f16' || hasGpu
  const useMmap = true

  const estimatedRamBytes =
    cpuShareBytes + (gpuLayers < shape.totalLayers ? kvPerToken * contextSize : 0)

  if (vramBytes > 0 && !hasGpu) {
    notes.push('tune.notes.gpuBackendUnavailable')
  }

  return {
    backend,
    gpuLayers,
    totalLayers: shape.totalLayers,
    contextSize,
    kvCacheType,
    threads,
    batchSize,
    ubatchSize,
    flashAttention,
    useMmap,
    useMlock: false,
    estimatedVramBytes,
    estimatedRamBytes,
    fitsFullyInVram,
    notes
  }
}

/**
 * The degradation ladder used when the server fails to start because of an out
 * of memory condition. Step 1 halves the offloaded layers, step 2 shrinks the
 * context and forces a 4 bit KV cache, step 3 runs fully on the CPU.
 */
export function degradeRecommendation(
  current: RecommendedParams,
  step: number
): RecommendedParams {
  if (step <= 0) return current

  const next: RecommendedParams = {
    ...current,
    notes: [...current.notes, `tune.notes.degraded${step}`]
  }

  if (step === 1) {
    next.gpuLayers = Math.max(1, Math.floor(current.gpuLayers / 2))
    next.contextSize = Math.max(1024, Math.floor(current.contextSize / 2))
    next.kvCacheType = 'q4_0'
    next.fitsFullyInVram = false
    next.estimatedVramBytes = Math.round(current.estimatedVramBytes * 0.6)
    return next
  }

  if (step === 2) {
    next.gpuLayers = Math.max(1, Math.floor(current.gpuLayers / 4))
    next.contextSize = 1024
    next.kvCacheType = 'q4_0'
    next.batchSize = Math.min(current.batchSize, 256)
    next.ubatchSize = Math.min(current.ubatchSize, 64)
    next.fitsFullyInVram = false
    next.estimatedVramBytes = Math.round(current.estimatedVramBytes * 0.3)
    return next
  }

  next.gpuLayers = 0
  next.contextSize = Math.min(current.contextSize, 2048)
  next.kvCacheType = 'q4_0'
  next.fitsFullyInVram = false
  next.estimatedVramBytes = 0
  return next
}
