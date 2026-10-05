import type { WebContents } from 'electron'
import { CH } from '@shared/channels'
import type {
  ChatStreamEvent,
  McpServerState,
  ServerState,
  AppSettings,
  ToastPayload
} from '@shared/types'

let target: WebContents | null = null

export function setEventTarget(contents: WebContents | null): void {
  target = contents
}

function send(channel: string, payload: unknown): void {
  if (!target || target.isDestroyed()) return
  target.send(channel, payload)
}

export function emitServerState(state: ServerState): void {
  send(CH.events.serverState, state)
}

export function emitServerLog(line: string): void {
  send(CH.events.serverLog, line)
}

export function emitChatStream(event: ChatStreamEvent): void {
  send(CH.events.chatStream, event)
}

export function emitSettingsChanged(settings: AppSettings): void {
  send(CH.events.settingsChanged, settings)
}

export function emitMcpStatus(servers: McpServerState[]): void {
  send(CH.events.mcpStatus, servers)
}

export function emitToast(toast: ToastPayload): void {
  send(CH.events.toast, toast)
}
