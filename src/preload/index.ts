import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CH } from '@shared/channels'
import type {
  AppInfo,
  AppPaths,
  AppSettings,
  ApprovalDecision,
  BackendKind,
  ChatRequest,
  ChatStreamEvent,
  Conversation,
  ConversationMeta,
  DeepPartial,
  HardwareInfo,
  LoadOptions,
  LumiLMApi,
  McpPromptInfo,
  McpRuntimeInfo,
  McpServerConfig,
  McpServerState,
  McpToolInfo,
  ModelInfo,
  ModelSuggestion,
  PerfPreset,
  PromptPreview,
  PromptPreviewInput,
  PromptPreset,
  RecommendedParams,
  SamplingParams,
  ServerState,
  SkillInfo,
  ToastPayload,
  Unsubscribe
} from '@shared/types'

function subscribe<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: LumiLMApi = {
  app: {
    getInfo: () => ipcRenderer.invoke(CH.app.getInfo) as Promise<AppInfo>,
    getPaths: () => ipcRenderer.invoke(CH.app.getPaths) as Promise<AppPaths>,
    openPath: (target: string) => ipcRenderer.invoke(CH.app.openPath, target) as Promise<void>,
    openExternal: (url: string) => ipcRenderer.invoke(CH.app.openExternal, url) as Promise<boolean>,
    showItemInFolder: (target: string) =>
      ipcRenderer.invoke(CH.app.showItemInFolder, target) as Promise<void>,
    exportDiagnostics: () => ipcRenderer.invoke(CH.app.exportDiagnostics) as Promise<string | null>
  },
  settings: {
    get: () => ipcRenderer.invoke(CH.settings.get) as Promise<AppSettings>,
    update: (patch: DeepPartial<AppSettings>) =>
      ipcRenderer.invoke(CH.settings.update, patch) as Promise<AppSettings>,
    reset: () => ipcRenderer.invoke(CH.settings.reset) as Promise<AppSettings>
  },
  hardware: {
    detect: (force?: boolean) => ipcRenderer.invoke(CH.hardware.detect, force) as Promise<HardwareInfo>
  },
  models: {
    list: () => ipcRenderer.invoke(CH.models.list) as Promise<ModelInfo[]>,
    addPaths: (paths: string[]) => ipcRenderer.invoke(CH.models.addPaths, paths) as Promise<ModelInfo[]>,
    addDirectory: (dir: string) =>
      ipcRenderer.invoke(CH.models.addDirectory, dir) as Promise<ModelInfo[]>,
    remove: (id: string, deleteFile?: boolean) =>
      ipcRenderer.invoke(CH.models.remove, id, deleteFile) as Promise<void>,
    refresh: (id?: string) => ipcRenderer.invoke(CH.models.refresh, id) as Promise<ModelInfo[]>,
    suggest: () => ipcRenderer.invoke(CH.models.suggest) as Promise<ModelSuggestion>,
    recommend: (modelId: string, preset?: PerfPreset, backend?: BackendKind) =>
      ipcRenderer.invoke(CH.models.recommend, modelId, preset, backend) as Promise<RecommendedParams>,
    update: (
      id: string,
      patch: { defaultSampling?: SamplingParams | null; backendOverride?: BackendKind | null }
    ) => ipcRenderer.invoke(CH.models.update, id, patch) as Promise<ModelInfo | null>
  },
  server: {
    state: () => ipcRenderer.invoke(CH.server.state) as Promise<ServerState>,
    load: (options: LoadOptions) => ipcRenderer.invoke(CH.server.load, options) as Promise<ServerState>,
    stop: () => ipcRenderer.invoke(CH.server.stop) as Promise<ServerState>,
    logs: () => ipcRenderer.invoke(CH.server.logs) as Promise<string[]>,
    clearLogs: () => ipcRenderer.invoke(CH.server.clearLogs) as Promise<void>,
    tokenize: (text: string) => ipcRenderer.invoke(CH.server.tokenize, text) as Promise<number>
  },
  chat: {
    send: (request: ChatRequest) => ipcRenderer.invoke(CH.chat.send, request) as Promise<void>,
    abort: (streamId: string) => ipcRenderer.invoke(CH.chat.abort, streamId) as Promise<void>,
    approveToolCall: (streamId: string, callId: string, decision: ApprovalDecision) =>
      ipcRenderer.invoke(CH.chat.approveTool, streamId, callId, decision) as Promise<void>
  },
  agent: {
    send: (request: ChatRequest) => ipcRenderer.invoke(CH.agent.send, request) as Promise<void>,
    abort: (streamId: string) => ipcRenderer.invoke(CH.agent.abort, streamId) as Promise<void>,
    approveToolCall: (streamId: string, callId: string, decision: ApprovalDecision) =>
      ipcRenderer.invoke(CH.agent.approveTool, streamId, callId, decision) as Promise<void>,
    previewPrompt: (input: PromptPreviewInput) =>
      ipcRenderer.invoke(CH.agent.previewPrompt, input) as Promise<PromptPreview>
  },
  mcp: {
    list: () => ipcRenderer.invoke(CH.mcp.list) as Promise<McpServerState[]>,
    configs: () => ipcRenderer.invoke(CH.mcp.configs) as Promise<McpServerConfig[]>,
    runtime: () => ipcRenderer.invoke(CH.mcp.runtime) as Promise<McpRuntimeInfo>,
    detectRuntime: () => ipcRenderer.invoke(CH.mcp.detectRuntime) as Promise<McpRuntimeInfo>,
    save: (config: McpServerConfig) =>
      ipcRenderer.invoke(CH.mcp.save, config) as Promise<McpServerState[]>,
    remove: (id: string) => ipcRenderer.invoke(CH.mcp.remove, id) as Promise<McpServerState[]>,
    connect: (id: string) => ipcRenderer.invoke(CH.mcp.connect, id) as Promise<McpServerState[]>,
    disconnect: (id: string) =>
      ipcRenderer.invoke(CH.mcp.disconnect, id) as Promise<McpServerState[]>,
    restart: (id: string) => ipcRenderer.invoke(CH.mcp.restart, id) as Promise<McpServerState[]>,
    tools: () => ipcRenderer.invoke(CH.mcp.tools) as Promise<McpToolInfo[]>,
    prompts: () => ipcRenderer.invoke(CH.mcp.prompts) as Promise<McpPromptInfo[]>,
    getPrompt: (serverId: string, name: string, args: Record<string, string>) =>
      ipcRenderer.invoke(CH.mcp.getPrompt, serverId, name, args) as Promise<string | null>,
    importConfig: () => ipcRenderer.invoke(CH.mcp.importConfig) as Promise<McpServerConfig[] | null>,
    revealConfig: () => ipcRenderer.invoke(CH.mcp.revealConfig) as Promise<void>
  },
  skills: {
    list: () => ipcRenderer.invoke(CH.skills.list) as Promise<SkillInfo[]>,
    refresh: () => ipcRenderer.invoke(CH.skills.refresh) as Promise<SkillInfo[]>,
    addDirectory: () => ipcRenderer.invoke(CH.skills.addDirectory) as Promise<string | null>,
    removeDirectory: (dir: string) =>
      ipcRenderer.invoke(CH.skills.removeDirectory, dir) as Promise<void>,
    openFolder: (dir: string) => ipcRenderer.invoke(CH.skills.openFolder, dir) as Promise<void>,
    revealFile: (path: string) => ipcRenderer.invoke(CH.skills.revealFile, path) as Promise<void>
  },
  conversations: {
    list: () => ipcRenderer.invoke(CH.conversations.list) as Promise<ConversationMeta[]>,
    get: (id: string) => ipcRenderer.invoke(CH.conversations.get, id) as Promise<Conversation | null>,
    create: (init?: { modelId?: string | null; title?: string }) =>
      ipcRenderer.invoke(CH.conversations.create, init) as Promise<Conversation>,
    save: (conversation: Conversation) =>
      ipcRenderer.invoke(CH.conversations.save, conversation) as Promise<void>,
    remove: (id: string) => ipcRenderer.invoke(CH.conversations.remove, id) as Promise<void>,
    duplicate: (id: string) =>
      ipcRenderer.invoke(CH.conversations.duplicate, id) as Promise<Conversation | null>,
    exportToFile: (id: string, format: 'md' | 'json') =>
      ipcRenderer.invoke(CH.conversations.exportToFile, id, format) as Promise<string | null>,
    importFromFile: () =>
      ipcRenderer.invoke(CH.conversations.importFromFile) as Promise<Conversation | null>
  },
  presets: {
    list: () => ipcRenderer.invoke(CH.presets.list) as Promise<PromptPreset[]>,
    save: (preset: PromptPreset) => ipcRenderer.invoke(CH.presets.save, preset) as Promise<PromptPreset[]>,
    remove: (id: string) => ipcRenderer.invoke(CH.presets.remove, id) as Promise<PromptPreset[]>
  },
  dialog: {
    pickModelFiles: () => ipcRenderer.invoke(CH.dialog.pickModelFiles) as Promise<string[]>,
    pickDirectory: () => ipcRenderer.invoke(CH.dialog.pickDirectory) as Promise<string | null>,
    pickImages: () => ipcRenderer.invoke(CH.dialog.pickImages) as Promise<string[]>
  },
  fs: {
    readTextFile: (path: string) =>
      ipcRenderer.invoke(CH.fs.readTextFile, path) as Promise<{
        path: string
        name: string
        content: string
      } | null>,
    readImageAsDataUrl: (path: string) =>
      ipcRenderer.invoke(CH.fs.readImage, path) as Promise<string | null>,
    saveAttachment: (fileName: string, dataUrl: string) =>
      ipcRenderer.invoke(CH.fs.saveAttachment, fileName, dataUrl) as Promise<string | null>,
    exists: (path: string) => ipcRenderer.invoke(CH.fs.exists, path) as Promise<boolean>,
    stat: (path: string) =>
      ipcRenderer.invoke(CH.fs.stat, path) as Promise<{
        sizeBytes: number
        isDirectory: boolean
      } | null>
  },
  events: {
    onServerState: (cb: (state: ServerState) => void) => subscribe(CH.events.serverState, cb),
    onServerLog: (cb: (line: string) => void) => subscribe(CH.events.serverLog, cb),
    onChatStream: (cb: (event: ChatStreamEvent) => void) => subscribe(CH.events.chatStream, cb),
    onAgentStream: (cb: (event: ChatStreamEvent) => void) => subscribe(CH.events.agentStream, cb),
    onSettingsChanged: (cb: (settings: AppSettings) => void) =>
      subscribe(CH.events.settingsChanged, cb),
    onMcpStatus: (cb: (servers: McpServerState[]) => void) => subscribe(CH.events.mcpStatus, cb),
    onToast: (cb: (toast: ToastPayload) => void) => subscribe(CH.events.toast, cb)
  }
}

contextBridge.exposeInMainWorld('lumilm', api)
