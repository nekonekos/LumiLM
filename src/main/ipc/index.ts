import { CH } from '@shared/channels'
import { settingsStore } from '../store/settings'
import { serverManager } from '../llama/server-manager'
import { emitServerLog, emitServerState, emitSettingsChanged } from './events'
import { registerChatHandlers } from './chat'
import { registerConversationHandlers } from './conversations'
import { registerModelHandlers } from './models'
import { registerSettingsHandlers } from './settings'
import { registerSystemHandlers } from './system'

export function registerAllHandlers(): void {
  registerSystemHandlers()
  registerSettingsHandlers()
  registerModelHandlers()
  registerConversationHandlers()
  registerChatHandlers()
}

/** Forwards main-process events to the renderer window. */
export function wireEventForwarding(): void {
  serverManager.on('state', emitServerState)
  serverManager.on('log', emitServerLog)
  settingsStore.on('changed', emitSettingsChanged)
}

export { CH }
