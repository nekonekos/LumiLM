import { CH } from '@shared/channels'
import type {
  BackendKind,
  HardwareInfo,
  ModelInfo,
  ModelSuggestion,
  PerfPreset,
  RecommendedParams,
  SamplingParams
} from '@shared/types'
import { modelLibrary } from '../gguf/scanner'
import { detectHardware } from '../llama/hardware'
import { registerHandler } from './register'

export function registerModelHandlers(): void {
  registerHandler(CH.hardware.detect, (_event, force?: boolean): Promise<HardwareInfo> =>
    detectHardware(force === true)
  )

  registerHandler(CH.models.list, (): Promise<ModelInfo[]> => modelLibrary.list())

  registerHandler(CH.models.addPaths, (_event, paths: string[]): Promise<ModelInfo[]> =>
    modelLibrary.addPaths(Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : [])
  )

  registerHandler(CH.models.addDirectory, (_event, dir: string): Promise<ModelInfo[]> => {
    if (typeof dir !== 'string' || dir.length === 0) return modelLibrary.list()
    return modelLibrary.addDirectory(dir)
  })

  registerHandler(CH.models.remove, (_event, id: string, deleteFile?: boolean): void => {
    if (typeof id !== 'string') return
    modelLibrary.remove(id, deleteFile === true)
  })

  registerHandler(CH.models.refresh, (_event, id?: string): Promise<ModelInfo[]> =>
    modelLibrary.refresh(typeof id === 'string' ? id : undefined)
  )

  registerHandler(CH.models.suggest, (): ModelSuggestion => modelLibrary.suggest())

  registerHandler(
    CH.models.recommend,
    (_event, id: string, preset?: PerfPreset, backend?: BackendKind): Promise<RecommendedParams | null> =>
      modelLibrary.recommend(id, preset, backend)
  )

  registerHandler(
    CH.models.update,
    (
      _event,
      id: string,
      patch: { defaultSampling?: SamplingParams | null; backendOverride?: BackendKind | null }
    ): Promise<ModelInfo | null> => {
      if (typeof id !== 'string') return Promise.resolve(null)
      return modelLibrary.update(id, patch ?? {})
    }
  )
}
