import { execFileSync } from 'node:child_process'
import type { McpErrorCode, McpRuntimeInfo, McpServerConfig } from '@shared/types'
import { logger } from '../util/logger'

let cached: McpRuntimeInfo | null = null

/** Where a stdio MCP server should be launched from. */
export interface ResolvedSpawn {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  shell: boolean
}

export type SpawnResolution =
  | { ok: true; spawn: ResolvedSpawn }
  | { ok: false; errorCode: McpErrorCode }

/**
 * `.cmd` / `.bat` shims (npm, npx) cannot be spawned directly on Windows:
 * Node refuses with EINVAL unless a shell is involved. The release script hit
 * exactly the same problem, so the rule lives here once for both callers.
 */
export function needsShell(command: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
}

function which(command: string): string | null {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which'
  try {
    const output = execFileSync(probe, [command], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    })
    return (
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? null
    )
  } catch {
    return null
  }
}

function nodeVersion(nodePath: string | null): string | null {
  if (!nodePath) return null
  try {
    return execFileSync(nodePath, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      shell: needsShell(nodePath)
    }).trim()
  } catch {
    return null
  }
}

/**
 * The Electron binary doubles as a Node runtime when `ELECTRON_RUN_AS_NODE=1`
 * is set, so a machine without a system Node can still run plain `.js` servers.
 * It cannot replace npx, which needs the real npm installation.
 */
export function detectRuntimeInfo(force = false): McpRuntimeInfo {
  if (cached && !force) return cached

  const node = which('node')
  const npx = which('npx')
  const effectiveNode = node ?? process.execPath

  cached = {
    nodePath: effectiveNode,
    npxPath: npx,
    nodeVersion: nodeVersion(effectiveNode),
    /** at least the Electron-provided node fallback always exists */
    available: true
  }

  logger.info(
    'mcp',
    `runtime detected: node=${effectiveNode}${node ? '' : ' (electron fallback)'}, npx=${npx ?? 'missing'}`
  )
  return cached
}

/**
 * Maps a configured `command` onto something spawnable, substituting the
 * Electron-provided runtime when the user asked for `node` but the machine has
 * no Node installation.
 */
export function resolveStdioSpawn(
  config: McpServerConfig,
  runtime: McpRuntimeInfo = detectRuntimeInfo()
): SpawnResolution {
  const command = config.command.trim()
  if (command.length === 0) return { ok: false, errorCode: 'SPAWN_FAILED' }

  const env: NodeJS.ProcessEnv = { ...process.env, ...config.env }

  const base = command.replace(/\\/g, '/').split('/').pop() ?? ''
  const bare = base.replace(/\.(cmd|bat|exe)$/i, '').toLowerCase()

  if (bare === 'node') {
    if (!runtime.nodePath) return { ok: false, errorCode: 'RUNTIME_MISSING' }
    return {
      ok: true,
      spawn: {
        command: runtime.nodePath,
        args: config.args,
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        shell: needsShell(runtime.nodePath)
      }
    }
  }

  if (bare === 'npx' || bare === 'npm') {
    if (!runtime.npxPath) return { ok: false, errorCode: 'RUNTIME_MISSING' }
    return {
      ok: true,
      spawn: {
        command: runtime.npxPath,
        args: config.args,
        env,
        shell: needsShell(runtime.npxPath)
      }
    }
  }

  return {
    ok: true,
    spawn: { command, args: config.args, env, shell: needsShell(command) }
  }
}

/** Test seam: clears the memoized detection result. */
export function resetRuntimeCache(): void {
  cached = null
}
