import { create } from 'zustand'
import type {
  McpPromptInfo,
  McpRuntimeInfo,
  McpServerConfig,
  McpServerState,
  McpToolInfo
} from '@shared/types'

interface McpState {
  servers: McpServerState[]
  configs: McpServerConfig[]
  tools: McpToolInfo[]
  prompts: McpPromptInfo[]
  runtime: McpRuntimeInfo | null
  loading: boolean

  setServers: (servers: McpServerState[]) => void
  refresh: () => Promise<void>
  refreshCapabilities: () => Promise<void>
  save: (config: McpServerConfig) => Promise<void>
  remove: (id: string) => Promise<void>
  connect: (id: string) => Promise<void>
  disconnect: (id: string) => Promise<void>
  restart: (id: string) => Promise<void>
  detectRuntime: () => Promise<void>
  importConfig: () => Promise<McpServerConfig[] | null>
  getPrompt: (
    serverId: string,
    name: string,
    args: Record<string, string>
  ) => Promise<string | null>
}

export const useMcpStore = create<McpState>((set, get) => ({
  servers: [],
  configs: [],
  tools: [],
  prompts: [],
  runtime: null,
  loading: false,

  setServers: (servers) => set({ servers }),

  refresh: async () => {
    set({ loading: true })
    try {
      const [servers, configs, tools, prompts, runtime] = await Promise.all([
        window.lumilm.mcp.list(),
        window.lumilm.mcp.configs(),
        window.lumilm.mcp.tools(),
        window.lumilm.mcp.prompts(),
        window.lumilm.mcp.runtime()
      ])
      set({ servers, configs, tools, prompts, runtime })
    } finally {
      set({ loading: false })
    }
  },

  refreshCapabilities: async () => {
    const [servers, configs, tools, prompts] = await Promise.all([
      window.lumilm.mcp.list(),
      window.lumilm.mcp.configs(),
      window.lumilm.mcp.tools(),
      window.lumilm.mcp.prompts()
    ])
    set({ servers, configs, tools, prompts })
  },

  save: async (config) => {
    const servers = await window.lumilm.mcp.save(config)
    set({ servers })
    await get().refreshCapabilities()
  },

  remove: async (id) => {
    const servers = await window.lumilm.mcp.remove(id)
    set({ servers })
    await get().refreshCapabilities()
  },

  connect: async (id) => {
    const servers = await window.lumilm.mcp.connect(id)
    set({ servers })
    await get().refreshCapabilities()
  },

  disconnect: async (id) => {
    const servers = await window.lumilm.mcp.disconnect(id)
    set({ servers })
    await get().refreshCapabilities()
  },

  restart: async (id) => {
    const servers = await window.lumilm.mcp.restart(id)
    set({ servers })
    await get().refreshCapabilities()
  },

  detectRuntime: async () => {
    set({ runtime: await window.lumilm.mcp.detectRuntime() })
  },

  importConfig: () => window.lumilm.mcp.importConfig(),

  getPrompt: (serverId, name, args) => window.lumilm.mcp.getPrompt(serverId, name, args)
}))
