import type { ToolRisk } from '@shared/types'

export interface BuiltinToolResult {
  content: string
  ok: boolean
}

/**
 * One built-in tool. `run` receives the workspace root it must stay inside and
 * the turn's abort signal so a long command can be cancelled.
 */
export interface BuiltinToolDef {
  toolName: string
  description: string
  inputSchema: Record<string, unknown>
  risk: ToolRisk
  run(root: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<BuiltinToolResult>
}
