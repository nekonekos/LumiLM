import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import type { ToolRisk } from '@shared/types'
import { resolveForWrite, resolveInside } from '../skills/registry'

const MAX_READ_BYTES = 1024 * 1024
const MAX_WRITE_BYTES = 1024 * 1024
const MAX_LIST_ENTRIES = 500
const MAX_SEARCH_FILES = 2000
const MAX_SEARCH_HITS = 100
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'out', 'release', 'dist', '.cache'])

export interface WorkspaceToolResult {
  content: string
  ok: boolean
}

export interface WorkspaceToolDef {
  toolName: string
  description: string
  inputSchema: Record<string, unknown>
  risk: ToolRisk
  run(root: string, args: Record<string, unknown>): Promise<WorkspaceToolResult>
}

function asString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Returns the resolved absolute path, or a refusal message. */
function target(root: string, raw: string, mustExist: boolean): { path: string } | { error: string } {
  const absolute = resolve(root, raw)
  const resolved = mustExist ? resolveInside(root, absolute) : resolveForWrite(root, absolute)
  if (!resolved) {
    return { error: `refused: "${raw}" is outside the workspace root` }
  }
  if (mustExist && !existsSync(resolved)) {
    return { error: `not found: ${raw}` }
  }
  return { path: resolved }
}

export const WORKSPACE_TOOL_DEFS: WorkspaceToolDef[] = [
  {
    toolName: 'read_file',
    description: 'Read a UTF-8 text file from the workspace. Paths are relative to the workspace root.',
    risk: 'read-only',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root' }
      },
      required: ['path']
    },
    async run(root, args) {
      const raw = asString(args, 'path')
      if (!raw) return { content: 'missing required argument: path', ok: false }
      const resolved = target(root, raw, true)
      if ('error' in resolved) return { content: resolved.error, ok: false }

      const stats = statSync(resolved.path)
      if (!stats.isFile()) return { content: `${raw} is not a file`, ok: false }
      if (stats.size > MAX_READ_BYTES) {
        return { content: `${raw} is too large (${stats.size} bytes, limit ${MAX_READ_BYTES})`, ok: false }
      }
      return { content: readFileSync(resolved.path, 'utf8'), ok: true }
    }
  },
  {
    toolName: 'write_file',
    description:
      'Create or overwrite a UTF-8 text file in the workspace. Parent directories must already exist.',
    risk: 'destructive',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root' },
        content: { type: 'string', description: 'Full file content to write' }
      },
      required: ['path', 'content']
    },
    async run(root, args) {
      const raw = asString(args, 'path')
      const content = typeof args.content === 'string' ? args.content : null
      if (!raw || content === null) return { content: 'missing required arguments: path, content', ok: false }
      if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
        return { content: `refused: content exceeds ${MAX_WRITE_BYTES} bytes`, ok: false }
      }

      const resolved = target(root, raw, false)
      if ('error' in resolved) return { content: resolved.error, ok: false }
      if (!existsSync(dirname(resolved.path))) {
        return { content: `refused: parent directory of ${raw} does not exist`, ok: false }
      }

      writeFileSync(resolved.path, content, 'utf8')
      return { content: `wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${raw}`, ok: true }
    }
  },
  {
    toolName: 'list_dir',
    description: 'List the entries of a workspace directory.',
    risk: 'read-only',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to the root, or "." for the root' }
      },
      required: ['path']
    },
    async run(root, args) {
      const raw = asString(args, 'path') ?? '.'
      const resolved = target(root, raw, true)
      if ('error' in resolved) return { content: resolved.error, ok: false }
      if (!statSync(resolved.path).isDirectory()) return { content: `${raw} is not a directory`, ok: false }

      const entries = readdirSync(resolved.path).sort().slice(0, MAX_LIST_ENTRIES)
      const lines = entries.map((entry) => {
        try {
          return statSync(join(resolved.path, entry)).isDirectory() ? `${entry}/` : entry
        } catch {
          return entry
        }
      })
      return { content: lines.length > 0 ? lines.join('\n') : '(empty directory)', ok: true }
    }
  },
  {
    toolName: 'search_files',
    description:
      'Search file names and text content inside the workspace. Returns matching lines with their paths.',
    risk: 'read-only',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive text to look for' },
        path: { type: 'string', description: 'Directory to search, relative to the root (default ".")' }
      },
      required: ['query']
    },
    async run(root, args) {
      const query = asString(args, 'query')
      if (!query) return { content: 'missing required argument: query', ok: false }
      const startRaw = asString(args, 'path') ?? '.'
      const resolved = target(root, startRaw, true)
      if ('error' in resolved) return { content: resolved.error, ok: false }

      const needle = query.toLowerCase()
      const hits: string[] = []
      let scanned = 0

      const visit = (directory: string): void => {
        if (scanned >= MAX_SEARCH_FILES || hits.length >= MAX_SEARCH_HITS) return
        let entries: string[]
        try {
          entries = readdirSync(directory)
        } catch {
          return
        }
        for (const entry of entries) {
          if (scanned >= MAX_SEARCH_FILES || hits.length >= MAX_SEARCH_HITS) return
          if (entry.startsWith('.') || SKIPPED_DIRS.has(entry)) continue
          const full = join(directory, entry)
          const shown = relative(root, full).split(/[\\/]/).join('/')

          let stats
          try {
            stats = statSync(full)
          } catch {
            continue
          }

          if (stats.isDirectory()) {
            visit(full)
            continue
          }
          if (stats.size > MAX_READ_BYTES) continue
          scanned += 1

          if (entry.toLowerCase().includes(needle)) hits.push(`[name] ${shown}`)
          try {
            const text = readFileSync(full, 'utf8')
            text.split(/\r?\n/).forEach((line, index) => {
              if (hits.length < MAX_SEARCH_HITS && line.toLowerCase().includes(needle)) {
                hits.push(`${shown}:${index + 1}: ${line.trim().slice(0, 200)}`)
              }
            })
          } catch {
            /* binary or unreadable */
          }
        }
      }

      visit(resolved.path)
      const suffix =
        scanned >= MAX_SEARCH_FILES ? `\n… stopped after scanning ${MAX_SEARCH_FILES} files` : ''
      return {
        content: hits.length > 0 ? `${hits.join('\n')}${suffix}` : `no matches for "${query}"${suffix}`,
        ok: true
      }
    }
  }
]
