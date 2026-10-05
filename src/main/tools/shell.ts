import { spawn } from 'node:child_process'
import type { BuiltinToolDef, BuiltinToolResult } from './types'

const MAX_COMMAND_CHARS = 2000
const TIMEOUT_MS = 60_000
const MAX_OUTPUT_CHARS = 64_000

/**
 * A last line of defence, not a sandbox: a shell command can always escape the
 * workspace root. These are the commands that are never the intent of a task
 * and cannot be undone, so they are refused before the approval prompt.
 */
const BLOCKED: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b/i, reason: 'formats a filesystem' },
  { pattern: /\bdiskpart\b/i, reason: 'partitions a disk' },
  { pattern: /\bformat\s+[a-z]:/i, reason: 'formats a drive' },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\//i, reason: 'writes to a raw device' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: 'changes the power state' },
  { pattern: /:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/, reason: 'is a fork bomb' },
  {
    pattern: /\brm\s+(-[a-z-]+\s+)*-[a-z]*[rf][a-z]*\s+(-[a-z]+\s+)*(\/|~|\$HOME)(\s|$)/i,
    reason: 'deletes the filesystem root or the home directory'
  }
]

function denial(command: string): string | null {
  for (const { pattern, reason } of BLOCKED) {
    if (pattern.test(command)) return `refused: this command ${reason}`
  }
  return null
}

/**
 * cmd.exe on a CJK Windows writes GBK, so a plain UTF-8 decode turns the output
 * into replacement characters. Fall back only when that actually happened.
 */
function decode(buffer: Buffer): string {
  const utf8 = buffer.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buffer)
  } catch {
    return utf8
  }
}

/** Killing the shell alone leaves its children holding the pipes open. */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

async function runCommand(
  root: string,
  command: string,
  signal: AbortSignal | undefined
): Promise<BuiltinToolResult> {
  if (command.length > MAX_COMMAND_CHARS) {
    return { content: `refused: command exceeds ${MAX_COMMAND_CHARS} characters`, ok: false }
  }
  const blocked = denial(command)
  if (blocked) return { content: blocked, ok: false }

  return new Promise<BuiltinToolResult>((resolve) => {
    const child = spawn(command, {
      cwd: root,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32'
    })

    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    const finish = (content: string, ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ content, ok })
    }

    const collect = (chunk: Buffer): void => {
      if (size >= MAX_OUTPUT_CHARS) return
      chunks.push(chunk)
      size += chunk.length
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    const stop = (): void => {
      if (child.pid !== undefined) killTree(child.pid)
    }
    const timer = setTimeout(() => {
      stop()
      finish(`[timed out after ${TIMEOUT_MS / 1000}s]\n${decode(Buffer.concat(chunks))}`, false)
    }, TIMEOUT_MS)

    const onAbort = (): void => {
      stop()
      finish('[cancelled]', false)
    }
    if (signal?.aborted) {
      stop()
      finish('[cancelled]', false)
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (error) => finish(`failed to run: ${error.message}`, false))

    child.on('close', (code) => {
      const output = decode(Buffer.concat(chunks)).slice(0, MAX_OUTPUT_CHARS)
      finish(code === 0 ? output || '(no output)' : `[exit ${code ?? '?'}]\n${output}`, code === 0)
    })
  })
}

export const SHELL_TOOL_DEFS: BuiltinToolDef[] = [
  {
    toolName: 'run_command',
    description:
      'Run one shell command in the workspace root and return its output. Windows cmd syntax on Windows, one command per call.',
    risk: 'destructive',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command']
    },
    async run(root, args, signal) {
      const command = typeof args.command === 'string' ? args.command.trim() : ''
      if (command.length === 0) return { content: 'missing required argument: command', ok: false }
      return runCommand(root, command, signal)
    }
  }
]
