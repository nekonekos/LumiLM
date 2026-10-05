import { CH } from '@shared/channels'
import { settingsStore } from '../store/settings'
import { serverManager } from '../llama/server-manager'
import { mcpManager } from '../mcp/manager'
import { emitMcpStatus, emitServerLog, emitServerState, emitSettingsChanged } from './events'
import { registerAgentHandlers } from './agent'
import { registerChatHandlers } from './chat'
import { registerCompanionHandlers } from './companion'
import { registerConversationHandlers } from './conversations'
import { registerMcpHandlers } from './mcp'
import { registerMemoryHandlers } from './memory'
import { registerModelHandlers } from './models'
import { registerSettingsHandlers } from './settings'
import { registerSkillHandlers } from './skills'
import { registerSystemHandlers } from './system'

export function registerAllHandlers(): void {
  registerSystemHandlers()
  registerSettingsHandlers()
  registerModelHandlers()
  registerConversationHandlers()
  registerSkillHandlers()
  registerMcpHandlers()
  registerChatHandlers()
  registerAgentHandlers()
  registerCompanionHandlers()
  registerMemoryHandlers()
}

/** Forwards main-process events to the renderer window. */
export function wireEventForwarding(): void {
  serverManager.on('state', emitServerState)
  serverManager.on('log', emitServerLog)
  settingsStore.on('changed', emitSettingsChanged)
  mcpManager.on('status', emitMcpStatus)
}

export { CH }
