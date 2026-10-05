import type { ServerState } from '@shared/types'

/** Renderer-side mirror of the main process' initial server state. */
export function createInitialServerState(): ServerState {
  return {
    status: 'idle',
    modelId: null,
    modelPath: null,
    modelName: null,
    mmprojPath: null,
    backend: null,
    port: null,
    pid: null,
    contextSize: null,
    gpuLayers: null,
    totalLayers: null,
    kvCacheType: null,
    startedAt: null,
    error: null,
    progress: null,
    degradedRetries: 0,
    commandLine: null,
    supportsTools: null,
    metrics: null
  }
}
