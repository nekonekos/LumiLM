import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { isInside, resolveForWrite, resolveInside } from '../skills/registry'
import type { BuiltinToolDef } from './types'

const MAX_READ_BYTES = 1024 * 1024
const MAX_WRITE_BYTES = 1024 * 1024
const MAX_LIST_ENTRIES = 500
const MAX_SEARCH_FILES = 2000
const MAX_SEARCH_HITS = 100
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'out', 'release', 'dist', '.cache'])

/**
 * The directory the built-in tools operate on. Enabling a group without picking
 * a folder would otherwise leave the model with no tools at all, which reads as
 * "the model cannot use tools" rather than "nothing is configured".
 */
export function effectiveWorkspaceRoot(configured: string | null | undefined): string {
  return configured && configured.trim().length > 0 ? resolve(configured) : homedir()
}

function asString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Returns the resolved absolute path, or a refusal message. */
function target(root: string, raw: string, mustExist: boolean): { path: string } | { error: string } {
  const absolute = resolve(root, raw)
  // Reject a lexical escape before touching the disk, so a missing path inside
  // the root is reported as missing rather than as a sandbox violation.
  if (!isInside(root, absolute)) {
    return { error: `refused: "${raw}" is outside the workspace root` }
  }
  if (mustExist && !existsSync(absolute)) {
    return { error: `not found: ${raw}` }
  }

  // Resolves symlinks, so a link inside the root cannot point outside it.
  const resolved = mustExist ? resolveInside(root, absolute) : resolveForWrite(root, absolute)
  if (!resolved) {
    return { error: `refused: "${raw}" is outside the workspace root` }
  }
  return { path: resolved }
}

/**
 * The four read/write tools. Descriptions stay one line and the schemas carry
 * no per-property help text: a local 8B model has a small context and picks a
 * tool from its name far more reliably than from prose.
 */
export const FILE_TOOL_DEFS: BuiltinToolDef[] = [
  {
    toolName: 'read_file',
    description: 'Read a UTF-8 text file. Paths are relative to the workspace root.',
    risk: 'read-only',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
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
        return {
          content: `${raw} is too large (${stats.size} bytes, limit ${MAX_READ_BYTES})`,
          ok: false
        }
      }
      return { content: readFileSync(resolved.path, 'utf8'), ok: true }
    }
  },
  {
    toolName: 'write_file',
    description: 'Create or overwrite a UTF-8 text file. Parent directories must already exist.',
    risk: 'destructive',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content']
    },
    async run(root, args) {
      const raw = asString(args, 'path')
      const content = typeof args.content === 'string' ? args.content : null
      if (!raw || content === null) {
        return { content: 'missing required arguments: path, content', ok: false }
      }
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
    toolName: 'list_files',
    description: 'List the entries of a directory. Directories are suffixed with "/".',
    risk: 'read-only',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    },
    async run(root, args) {
      const raw = asString(args, 'path') ?? '.'
      const resolved = target(root, raw, true)
      if ('error' in resolved) return { content: resolved.error, ok: false }
      if (!statSync(resolved.path).isDirectory()) {
        return { content: `${raw} is not a directory`, ok: false }
      }

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
    description: 'Search file names and text content. Matches are returned as "path:line: text".',
    risk: 'read-only',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string', description: 'Directory to search, default "."' }
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
        content:
          hits.length > 0 ? `${hits.join('\n')}${suffix}` : `no matches for "${query}"${suffix}`,
        ok: true
      }
    }
  }
]
