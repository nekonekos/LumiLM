/** Single source of truth for IPC channel names shared by main and preload. */
export const CH = {
  app: {
    getInfo: 'app:get-info',
    getPaths: 'app:get-paths',
    openPath: 'app:open-path',
    openExternal: 'app:open-external',
    showItemInFolder: 'app:show-item-in-folder',
    exportDiagnostics: 'app:export-diagnostics'
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
    reset: 'settings:reset'
  },
  hardware: {
    detect: 'hardware:detect'
  },
  models: {
    list: 'models:list',
    addPaths: 'models:add-paths',
    addDirectory: 'models:add-directory',
    remove: 'models:remove',
    refresh: 'models:refresh',
    suggest: 'models:suggest',
    recommend: 'models:recommend',
    update: 'models:update'
  },
  server: {
    state: 'server:state',
    load: 'server:load',
    stop: 'server:stop',
    logs: 'server:logs',
    clearLogs: 'server:clear-logs',
    tokenize: 'server:tokenize'
  },
  chat: {
    send: 'chat:send',
    abort: 'chat:abort',
    approveTool: 'chat:approve-tool'
  },
  agent: {
    send: 'agent:send',
    abort: 'agent:abort',
    approveTool: 'agent:approve-tool',
    previewPrompt: 'agent:preview-prompt'
  },
  companion: {
    overview: 'companion:overview',
    send: 'companion:send',
    abort: 'companion:abort',
    previewPrompt: 'companion:preview-prompt',
    updateRelationship: 'companion:update-relationship',
    setHeartbeat: 'companion:set-heartbeat',
    heartbeatTest: 'companion:heartbeat-test',
    dreamNow: 'companion:dream-now'
  },
  memory: {
    list: 'memory:list',
    stats: 'memory:stats',
    recall: 'memory:recall',
    update: 'memory:update',
    remove: 'memory:remove',
    removeMany: 'memory:remove-many',
    approve: 'memory:approve',
    episodes: 'memory:episodes',
    forgetAll: 'memory:forget-all',
    export: 'memory:export',
    import: 'memory:import'
  },
  personas: {
    list: 'personas:list',
    save: 'personas:save',
    remove: 'personas:remove',
    import: 'personas:import',
    export: 'personas:export',
    detectImage: 'personas:detect-image',
    restoreBuiltin: 'personas:restore-builtin'
  },
  mcp: {
    list: 'mcp:list',
    configs: 'mcp:configs',
    runtime: 'mcp:runtime',
    detectRuntime: 'mcp:detect-runtime',
    save: 'mcp:save',
    remove: 'mcp:remove',
    connect: 'mcp:connect',
    disconnect: 'mcp:disconnect',
    restart: 'mcp:restart',
    tools: 'mcp:tools',
    prompts: 'mcp:prompts',
    getPrompt: 'mcp:get-prompt',
    importConfig: 'mcp:import-config',
    revealConfig: 'mcp:reveal-config'
  },
  skills: {
    list: 'skills:list',
    refresh: 'skills:refresh',
    addDirectory: 'skills:add-directory',
    removeDirectory: 'skills:remove-directory',
    openFolder: 'skills:open-folder',
    revealFile: 'skills:reveal-file'
  },
  conversations: {
    list: 'conversations:list',
    get: 'conversations:get',
    create: 'conversations:create',
    save: 'conversations:save',
    remove: 'conversations:remove',
    duplicate: 'conversations:duplicate',
    exportToFile: 'conversations:export',
    importFromFile: 'conversations:import'
  },
  presets: {
    list: 'presets:list',
    save: 'presets:save',
    remove: 'presets:remove'
  },
  dialog: {
    pickModelFiles: 'dialog:pick-model-files',
    pickDirectory: 'dialog:pick-directory',
    pickImages: 'dialog:pick-images'
  },
  fs: {
    readTextFile: 'fs:read-text-file',
    readImage: 'fs:read-image',
    saveAttachment: 'fs:save-attachment',
    exists: 'fs:exists',
    stat: 'fs:stat'
  },
  events: {
    serverState: 'event:server-state',
    serverLog: 'event:server-log',
    chatStream: 'event:chat-stream',
    agentStream: 'event:agent-stream',
    companionStream: 'event:companion-stream',
    settingsChanged: 'event:settings-changed',
    mcpStatus: 'event:mcp-status',
    heartbeat: 'event:heartbeat',
    memoryChanged: 'event:memory-changed',
    toast: 'event:toast'
  }
} as const
