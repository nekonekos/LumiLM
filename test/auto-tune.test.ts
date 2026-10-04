import { describe, expect, it } from 'vitest'
import type { HardwareInfo, ModelInfo } from '@shared/types'
import { computeRecommendation, degradeRecommendation, presetDefaults } from '../src/main/llama/auto-tune'

const GIB = 1024 ** 3
const MIB = 1024 ** 2

/** A 9B Q4_K_M model shaped like the Qwen3.5 9B the project targets. */
function qwenModel(): ModelInfo {
  return {
    id: 'model-1',
    path: 'C:\\models\\qwen.gguf',
    fileName: 'Qwen3.5-9B-DeepSeek-V4-Flash-Q4_K_M.gguf',
    sizeBytes: 5.24 * GIB,
    addedAt: 0,
    lastUsedAt: null,
    metadata: {
      ggufVersion: 3,
      architecture: 'qwen3',
      name: 'Qwen3.5 9B',
      parameterCount: 9_000_000_000,
      contextLength: 32768,
      embeddingLength: 4096,
      blockCount: 48,
      headCount: 32,
      headCountKv: 8,
      keyLength: 128,
      valueLength: 128,
      quantization: 'Q4_K_M',
      chatTemplate: null,
      isProjector: false,
      fileType: 15
    },
    metadataError: null,
    mmprojPath: null,
    mmprojMissing: false,
    recommended: null,
    defaultSampling: null,
    backendOverride: null
  }
}

function hardware(vramBytes: number, totalRamBytes: number, physicalCores = 8): HardwareInfo {
  return {
    cpuModel: 'test cpu',
    physicalCores,
    logicalCores: physicalCores * 2,
    totalRamBytes,
    freeRamBytes: totalRamBytes * 0.5,
    gpus: vramBytes > 0
      ? [{ index: 0, name: 'NVIDIA GeForce RTX 4060', vramBytes, vendor: 'nvidia', source: 'nvidia-smi' }]
      : [],
    os: 'win32',
    arch: 'x64',
    backends: [],
    selectedBackend: vramBytes > 0 ? 'cuda' : 'cpu',
    probedAt: 0
  }
}

describe('computeRecommendation', () => {
  it('fully offloads a model that fits in a 8 GB card', () => {
    const result = computeRecommendation({
      model: qwenModel(),
      hardware: hardware(8 * GIB, 32 * GIB),
      preset: 'balanced',
      backend: 'cuda',
      vramReserveMb: 512,
      mmprojEnabled: false
    })

    expect(result.totalLayers).toBe(49)
    expect(result.gpuLayers).toBe(result.totalLayers)
    expect(result.fitsFullyInVram).toBe(true)
    expect(result.contextSize).toBe(4096)
    expect(result.notes).not.toContain('tune.notes.partialOffload')
  })

  it('partially offloads when VRAM is tight and says so', () => {
    const result = computeRecommendation({
      model: qwenModel(),
      hardware: hardware(4 * GIB, 32 * GIB),
      preset: 'balanced',
      backend: 'cuda',
      vramReserveMb: 512,
      mmprojEnabled: false
    })

    expect(result.gpuLayers).toBeGreaterThan(0)
    expect(result.gpuLayers).toBeLessThan(result.totalLayers)
    expect(result.fitsFullyInVram).toBe(false)
    expect(result.notes).toContain('tune.notes.partialOffload')
    // A partial offload must never claim more VRAM than the card has.
    expect(result.estimatedVramBytes).toBeLessThanOrEqual(4 * GIB)
  })

  it('falls back to the CPU when there is no GPU', () => {
    const result = computeRecommendation({
      model: qwenModel(),
      hardware: hardware(0, 16 * GIB),
      preset: 'balanced',
      backend: 'cpu',
      vramReserveMb: 512,
      mmprojEnabled: false
    })

    expect(result.gpuLayers).toBe(0)
    expect(result.estimatedVramBytes).toBe(0)
    expect(result.notes).toContain('tune.notes.cpuOnly')
    // The whole model then has to fit in system memory.
    expect(result.estimatedRamBytes).toBeGreaterThan(qwenModel().sizeBytes * 0.9)
  })

  it('never exceeds the context advertised by the model', () => {
    const small = qwenModel()
    small.metadata = { ...small.metadata!, contextLength: 1024 }

    const result = computeRecommendation({
      model: small,
      hardware: hardware(8 * GIB, 32 * GIB),
      preset: 'performance',
      backend: 'cuda',
      vramReserveMb: 512,
      mmprojEnabled: false
    })

    expect(result.contextSize).toBeLessThanOrEqual(1024)
  })

  it('shrinks the context when system memory is the limiting factor', () => {
    const result = computeRecommendation({
      model: qwenModel(),
      hardware: hardware(0, 8 * GIB),
      preset: 'performance',
      backend: 'cpu',
      vramReserveMb: 512,
      mmprojEnabled: false
    })

    expect(result.contextSize).toBeLessThan(presetDefaults('performance').preferredContext)
    expect(result.notes).toContain('tune.notes.contextLimitedByRam')
  })

  it('accounts for the projector when images are enabled', () => {
    const withoutProjector = computeRecommendation({
      model: qwenModel(),
      hardware: hardware(8 * GIB, 32 * GIB),
      preset: 'balanced',
      backend: 'cuda',
      vramReserveMb: 512,
      mmprojEnabled: true
    })

    const withProjector = computeRecommendation({
      model: qwenModel(),
      hardware: hardware(8 * GIB, 32 * GIB),
      preset: 'balanced',
      backend: 'cuda',
      vramReserveMb: 512,
      mmprojEnabled: true,
      mmprojBytes: GIB
    })

    expect(withProjector.estimatedVramBytes).toBeGreaterThan(0)
    expect(withoutProjector.estimatedVramBytes).toBeGreaterThan(0)
    expect(withProjector.gpuLayers).toBeLessThanOrEqual(withoutProjector.gpuLayers)
  })

  it('caps threads on low memory machines', () => {
    const result = computeRecommendation({
      model: qwenModel(),
      hardware: hardware(0, 6 * GIB, 16),
      preset: 'balanced',
      backend: 'cpu',
      vramReserveMb: 512,
      mmprojEnabled: false
    })

    expect(result.threads).toBeLessThanOrEqual(4)
    expect(result.notes).toContain('tune.notes.lowRam')
  })

  it('quantises the KV cache with the low-vram preset', () => {
    const result = computeRecommendation({
      model: qwenModel(),
      hardware: hardware(8 * GIB, 32 * GIB),
      preset: 'low-vram',
      backend: 'cuda',
      vramReserveMb: 512,
      mmprojEnabled: false
    })

    expect(result.kvCacheType).toBe('q4_0')
    expect(result.contextSize).toBe(2048)
  })
})

describe('degradeRecommendation', () => {
  const base = computeRecommendation({
    model: qwenModel(),
    hardware: hardware(4 * GIB, 32 * GIB),
    preset: 'balanced',
    backend: 'cuda',
    vramReserveMb: 512,
    mmprojEnabled: false
  })

  it('halves the offload on the first step', () => {
    const next = degradeRecommendation(base, 1)
    expect(next.gpuLayers).toBeLessThan(base.gpuLayers)
    expect(next.contextSize).toBeLessThan(base.contextSize)
    expect(next.kvCacheType).toBe('q4_0')
    expect(next.fitsFullyInVram).toBe(false)
    expect(next.notes).toContain('tune.notes.degraded1')
  })

  it('runs fully on the CPU on the third step', () => {
    const next = degradeRecommendation(base, 3)
    expect(next.gpuLayers).toBe(0)
    expect(next.contextSize).toBeGreaterThanOrEqual(512)
    expect(next.notes).toContain('tune.notes.degraded3')
  })

  it('never drops the context below one block', () => {
    let current = base
    for (let step = 1; step <= 3; step += 1) current = degradeRecommendation(current, step)
    expect(current.contextSize).toBeGreaterThanOrEqual(512)
  })

  it('is a no-op for step zero', () => {
    expect(degradeRecommendation(base, 0)).toBe(base)
  })
})

describe('presetDefaults', () => {
  it('keeps the memory presets ordered by footprint', () => {
    const low = presetDefaults('low-vram')
    const balanced = presetDefaults('balanced')
    const performance = presetDefaults('performance')

    expect(low.preferredContext).toBeLessThan(balanced.preferredContext)
    expect(balanced.preferredContext).toBeLessThan(performance.preferredContext)
    expect(low.reserveMultiplier).toBeGreaterThan(performance.reserveMultiplier)
  })

  it('keeps ubatch below batch for every preset', () => {
    for (const preset of ['low-vram', 'balanced', 'performance'] as const) {
      const defaults = presetDefaults(preset)
      expect(defaults.ubatchSize).toBeLessThanOrEqual(defaults.batchSize)
    }
  })

  it('estimates VRAM in MiB units consistently', () => {
    const result = computeRecommendation({
      model: qwenModel(),
      hardware: hardware(8 * GIB, 32 * GIB),
      preset: 'balanced',
      backend: 'cuda',
      vramReserveMb: 1024,
      mmprojEnabled: false
    })
    // 1 GiB of reserved VRAM must be honoured, so the estimate cannot exceed 7 GiB.
    expect(result.estimatedVramBytes).toBeLessThanOrEqual(7 * GIB + 64 * MIB)
  })
})
