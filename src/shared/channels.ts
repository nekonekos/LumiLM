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
    abort: 'chat:abort'
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
    settingsChanged: 'event:settings-changed',
    toast: 'event:toast'
  }
} as const
