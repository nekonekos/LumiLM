/**
 * Shared domain types used by the main process, preload bridge and renderer.
 * Keep this module free of Node.js and DOM APIs.
 */

/* ------------------------------------------------------------------ */
/* Basic helpers                                                       */
/* ------------------------------------------------------------------ */

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[]
    ? U[]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K]
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export type ThemeMode = 'system' | 'light' | 'dark'
export type BackendKind = 'auto' | 'cpu' | 'vulkan' | 'cuda'
export type ConcreteBackend = 'cpu' | 'vulkan' | 'cuda'
export type PerfPreset = 'low-vram' | 'balanced' | 'performance'
export type KvCacheType = 'f16' | 'q8_0' | 'q4_0'
export type ChatLayout = 'bubble' | 'document'
export type MessageDensity = 'comfortable' | 'compact'
export type Locale = 'zh-CN' | 'en-US'
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

export interface GeneralSettings {
  locale: Locale
  themeMode: ThemeMode
  accent: string
  /** custom data directory, null means the default userData location */
  dataDir: string | null
  confirmOnDelete: boolean
}

export interface AppearanceSettings {
  fontSize: number
  density: MessageDensity
  layout: ChatLayout
  showReasoning: boolean
  /** render markdown tables with full width and horizontal scrolling */
  wideTables: boolean
}

export interface InferenceSettings {
  backend: BackendKind
  perfPreset: PerfPreset
  gpuLayers: number | 'auto'
  contextSize: number | 'auto'
  kvCacheType: KvCacheType | 'auto'
  threads: number | 'auto'
  batchSize: number | 'auto'
  flashAttention: boolean | 'auto'
  useMmap: boolean
  useMlock: boolean
  /** VRAM kept free for the OS / other apps, in MiB */
  vramReserveMb: number
  /** stop the llama-server process after N minutes of inactivity, 0 = never */
  idleUnloadMinutes: number
  extraArgs: string
}

export interface ModelSettings {
  directories: string[]
  activeModelId: string | null
  mmprojEnabled: boolean
}

export interface AdvancedSettings {
  logLevel: LogLevel
  /** no network request is ever made unless this is enabled */
  updateCheck: boolean
}

export interface UiSettings {
  sidebarWidth: number
  sidebarCollapsed: boolean
  inspectorCollapsed: boolean
}

export interface WindowSettings {
  width: number
  height: number
  x: number | null
  y: number | null
  maximized: boolean
}

export interface AppSettings {
  version: number
  general: GeneralSettings
  appearance: AppearanceSettings
  inference: InferenceSettings
  models: ModelSettings
  advanced: AdvancedSettings
  ui: UiSettings
  window: WindowSettings
}

/* ------------------------------------------------------------------ */
/* Hardware                                                            */
/* ------------------------------------------------------------------ */

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'other' | 'unknown'

export interface GpuInfo {
  index: number
  name: string
  vramBytes: number | null
  vendor: GpuVendor
  source: 'nvidia-smi' | 'registry' | 'wmi'
}

export interface BackendProbe {
  kind: ConcreteBackend
  /** the backend binary exists inside the application resources */
  present: boolean
  /** the backend reported at least one usable compute device */
  available: boolean
  devices: string[]
  version: string | null
  error: string | null
}

export interface HardwareInfo {
  cpuModel: string
  physicalCores: number
  logicalCores: number
  totalRamBytes: number
  freeRamBytes: number
  gpus: GpuInfo[]
  os: string
  arch: string
  backends: BackendProbe[]
  /** backend that will be used given the current settings */
  selectedBackend: ConcreteBackend | null
  probedAt: number
}

/* ------------------------------------------------------------------ */
/* GGUF / models                                                       */
/* ------------------------------------------------------------------ */

export interface GgufMetadata {
  ggufVersion: number
  architecture: string | null
  name: string | null
  parameterCount: number | null
  contextLength: number | null
  embeddingLength: number | null
  blockCount: number | null
  headCount: number | null
  headCountKv: number | null
  keyLength: number | null
  valueLength: number | null
  quantization: string | null
  chatTemplate: string | null
  isProjector: boolean
  /** file type enum from the GGUF header when present */
  fileType: number | null
}

export interface RecommendedParams {
  backend: ConcreteBackend
  gpuLayers: number
  totalLayers: number
  contextSize: number
  kvCacheType: KvCacheType
  threads: number
  batchSize: number
  ubatchSize: number
  flashAttention: boolean
  useMmap: boolean
  useMlock: boolean
  estimatedVramBytes: number
  estimatedRamBytes: number
  fitsFullyInVram: boolean
  /** i18n keys explaining the recommendation */
  notes: string[]
}

export interface ModelInfo {
  id: string
  path: string
  fileName: string
  sizeBytes: number
  addedAt: number
  lastUsedAt: number | null
  metadata: GgufMetadata | null
  metadataError: string | null
  mmprojPath: string | null
  mmprojMissing: boolean
  recommended: RecommendedParams | null
  defaultSampling: SamplingParams | null
  backendOverride: BackendKind | null
}

export interface ModelSuggestion {
  candidates: Array<{ modelPath: string; mmprojPath: string | null; sizeBytes: number }>
  searchedDirs: string[]
}

/* ------------------------------------------------------------------ */
/* Chat / conversations                                                */
/* ------------------------------------------------------------------ */

export type MessageRole = 'system' | 'user' | 'assistant'

export interface Attachment {
  id: string
  kind: 'image' | 'text'
  name: string
  mimeType: string
  sizeBytes: number
  /** absolute path on disk */
  path: string
}

export interface MessageStats {
  ttftMs?: number
  tokensPerSecond?: number
  promptTokens?: number
  completionTokens?: number
  durationMs?: number
}

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  reasoning?: string
  createdAt: number
  updatedAt?: number
  attachments?: Attachment[]
  modelId?: string
  stats?: MessageStats
  error?: string | null
  stopped?: boolean
}

export interface SamplingParams {
  temperature: number
  topP: number
  topK: number
  minP: number
  repeatPenalty: number
  repeatLastN: number
  presencePenalty: number
  frequencyPenalty: number
  /** -1 means unlimited */
  maxTokens: number
  /** -1 means random */
  seed: number
  stop: string[]
}

export const DEFAULT_SAMPLING: SamplingParams = {
  temperature: 0.7,
  topP: 0.95,
  topK: 40,
  minP: 0.05,
  repeatPenalty: 1.05,
  repeatLastN: 64,
  presencePenalty: 0,
  frequencyPenalty: 0,
  maxTokens: -1,
  seed: -1,
  stop: []
}

/** LumiLM ships no preset prompts: every conversation starts empty. */
export const EMPTY_SYSTEM_PROMPT = ''

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  archived: boolean
  modelId: string | null
  systemPrompt: string
  sampling: SamplingParams
  messages: ChatMessage[]
}

export interface ConversationMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  archived: boolean
  modelId: string | null
  messageCount: number
  preview: string
}

export interface PromptPreset {
  id: string
  name: string
  description: string
  systemPrompt: string
  sampling: Partial<SamplingParams> | null
  createdAt: number
  updatedAt: number
}

/* ------------------------------------------------------------------ */
/* llama-server                                                        */
/* ------------------------------------------------------------------ */

export type ServerStatus = 'idle' | 'starting' | 'loading' | 'ready' | 'stopping' | 'error'

export interface RuntimeMetrics {
  ttftMs: number | null
  tokensPerSecond: number | null
  promptTokens: number | null
  completionTokens: number | null
  contextUsedTokens: number | null
  contextSize: number | null
  /** prompt ingestion rate parsed from llama-server logs */
  promptPerSecond: number | null
  lastUpdated: number
}

export interface ServerState {
  status: ServerStatus
  modelId: string | null
  modelPath: string | null
  modelName: string | null
  mmprojPath: string | null
  backend: ConcreteBackend | null
  port: number | null
  pid: number | null
  contextSize: number | null
  gpuLayers: number | null
  totalLayers: number | null
  kvCacheType: KvCacheType | null
  startedAt: number | null
  error: string | null
  /** 0..1 when the loader reports progress */
  progress: number | null
  /** how many automatic degradation retries already happened */
  degradedRetries: number
  commandLine: string | null
  metrics: RuntimeMetrics | null
}

export interface LoadOptions {
  modelId?: string
  backend?: BackendKind
  perfPreset?: PerfPreset
  gpuLayers?: number | 'auto'
  contextSize?: number | 'auto'
  kvCacheType?: KvCacheType | 'auto'
  threads?: number | 'auto'
  batchSize?: number | 'auto'
  flashAttention?: boolean | 'auto'
  useMmap?: boolean
  useMlock?: boolean
  vramReserveMb?: number
  mmprojEnabled?: boolean
  extraArgs?: string
}

/* ------------------------------------------------------------------ */
/* Chat streaming                                                      */
/* ------------------------------------------------------------------ */

export interface ChatRequestMessage {
  role: MessageRole
  content: string
  /**
   * Absolute image file paths when sent from the renderer. The main process
   * converts them to base64 data URLs before calling llama-server.
   */
  images?: string[]
}

export interface ChatRequest {
  streamId: string
  conversationId: string
  modelId: string | null
  systemPrompt: string
  messages: ChatRequestMessage[]
  sampling: SamplingParams
}

export type ChatStreamEvent =
  | { type: 'start'; streamId: string; model: string | null }
  | { type: 'delta'; streamId: string; content?: string; reasoning?: string }
  | { type: 'metrics'; streamId: string; metrics: Partial<RuntimeMetrics> }
  | { type: 'done'; streamId: string; stats: MessageStats; finishReason: string | null }
  | { type: 'error'; streamId: string; message: string; detail?: string }
  | { type: 'aborted'; streamId: string }

/* ------------------------------------------------------------------ */
/* App info / paths                                                    */
/* ------------------------------------------------------------------ */

export interface LlamaBackendInfo {
  kind: ConcreteBackend
  present: boolean
  version: string | null
  path: string | null
}

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  v8: string
  platform: string
  arch: string
  isPackaged: boolean
  llamaVersion: string | null
  llamaBackends: LlamaBackendInfo[]
}

export interface AppPaths {
  userData: string
  dataDir: string
  modelsDir: string
  conversationsDir: string
  /** pasted and dropped images are copied here before they are sent */
  attachmentsDir: string
  presetsFile: string
  settingsFile: string
  logsDir: string
  llamaRoot: string | null
}

export interface ToastPayload {
  kind: 'info' | 'success' | 'warning' | 'error'
  message: string
  detail?: string
}

/* ------------------------------------------------------------------ */
/* IPC contract                                                        */
/* ------------------------------------------------------------------ */

export type Unsubscribe = () => void

export interface LumiLMApi {
  app: {
    getInfo(): Promise<AppInfo>
    getPaths(): Promise<AppPaths>
    openPath(target: string): Promise<void>
    openExternal(url: string): Promise<boolean>
    showItemInFolder(target: string): Promise<void>
    exportDiagnostics(): Promise<string | null>
  }
  settings: {
    get(): Promise<AppSettings>
    update(patch: DeepPartial<AppSettings>): Promise<AppSettings>
    reset(): Promise<AppSettings>
  }
  hardware: {
    detect(force?: boolean): Promise<HardwareInfo>
  }
  models: {
    list(): Promise<ModelInfo[]>
    addPaths(paths: string[]): Promise<ModelInfo[]>
    addDirectory(dir: string): Promise<ModelInfo[]>
    remove(id: string, deleteFile?: boolean): Promise<void>
    refresh(id?: string): Promise<ModelInfo[]>
    suggest(): Promise<ModelSuggestion>
    recommend(modelId: string, preset?: PerfPreset, backend?: BackendKind): Promise<RecommendedParams>
    update(
      id: string,
      patch: { defaultSampling?: SamplingParams | null; backendOverride?: BackendKind | null }
    ): Promise<ModelInfo | null>
  }
  server: {
    state(): Promise<ServerState>
    load(options: LoadOptions): Promise<ServerState>
    stop(): Promise<ServerState>
    logs(): Promise<string[]>
    clearLogs(): Promise<void>
    tokenize(text: string): Promise<number>
  }
  chat: {
    send(request: ChatRequest): Promise<void>
    abort(streamId: string): Promise<void>
  }
  conversations: {
    list(): Promise<ConversationMeta[]>
    get(id: string): Promise<Conversation | null>
    create(init?: { modelId?: string | null; title?: string }): Promise<Conversation>
    save(conversation: Conversation): Promise<void>
    remove(id: string): Promise<void>
    duplicate(id: string): Promise<Conversation | null>
    exportToFile(id: string, format: 'md' | 'json'): Promise<string | null>
    importFromFile(): Promise<Conversation | null>
  }
  presets: {
    list(): Promise<PromptPreset[]>
    save(preset: PromptPreset): Promise<PromptPreset[]>
    remove(id: string): Promise<PromptPreset[]>
  }
  dialog: {
    pickModelFiles(): Promise<string[]>
    pickDirectory(): Promise<string | null>
    pickImages(): Promise<string[]>
  }
  fs: {
    readTextFile(path: string): Promise<{ path: string; name: string; content: string } | null>
    readImageAsDataUrl(path: string): Promise<string | null>
    saveAttachment(fileName: string, dataUrl: string): Promise<string | null>
    exists(path: string): Promise<boolean>
    stat(path: string): Promise<{ sizeBytes: number; isDirectory: boolean } | null>
  }
  events: {
    onServerState(cb: (state: ServerState) => void): Unsubscribe
    onServerLog(cb: (line: string) => void): Unsubscribe
    onChatStream(cb: (event: ChatStreamEvent) => void): Unsubscribe
    onSettingsChanged(cb: (settings: AppSettings) => void): Unsubscribe
    onToast(cb: (toast: ToastPayload) => void): Unsubscribe
  }
}

declare global {
  interface Window {
    lumilm: LumiLMApi
  }
}
