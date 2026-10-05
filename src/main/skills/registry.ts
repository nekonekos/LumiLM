import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { SkillInfo } from '@shared/types'
import { getPaths } from '../store/paths'
import { settingsStore } from '../store/settings'
import { logger, toError } from '../util/logger'
import { parseSkillJson, parseSkillMarkdown, type ParsedSkill } from './parser'

const MAX_DEPTH = 4
const MAX_RESOURCES = 64
const MAX_SKILLS = 500
const MAX_RESOURCE_BYTES = 256 * 1024
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'out', 'release', 'dist', '.cache'])

/**
 * True when `target` is `root` itself or sits inside it. Used for both skill
 * resources and the built-in workspace tools, so the check lives in one place.
 */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Resolves symlinks so a link cannot be used to escape the root. */
export function resolveInside(root: string, target: string): string | null {
  let realRoot: string
  let realTarget: string
  try {
    realRoot = realpathSync(root)
    realTarget = realpathSync(target)
  } catch {
    return null
  }
  return isInside(realRoot, realTarget) ? realTarget : null
}

/**
 * Same guarantee for a path that may not exist yet (a file about to be
 * written): the deepest existing ancestor must resolve inside the root.
 */
export function resolveForWrite(root: string, target: string): string | null {
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return null
  }

  let ancestor = dirname(target)
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) return null
    ancestor = parent
  }

  let realAncestor: string
  try {
    realAncestor = realpathSync(ancestor)
  } catch {
    return null
  }
  return isInside(realRoot, realAncestor) ? resolve(realRoot, relative(realRoot, target)) : null
}

function slug(raw: string): string {
  const value = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return value.length > 0 ? value : 'skill'
}

function hashOf(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 6)
}

function listResourceFiles(directory: string, depth = 0): string[] {
  if (depth > 2) return []
  const found: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return []
  }
  for (const entry of entries.sort()) {
    if (found.length >= MAX_RESOURCES) break
    if (entry.startsWith('.')) continue
    const full = join(directory, entry)
    let stats
    try {
      stats = statSync(full)
    } catch {
      continue
    }
    if (stats.isDirectory()) {
      if (SKIPPED_DIRS.has(entry)) continue
      found.push(...listResourceFiles(full, depth + 1))
    } else if (stats.size > 0) {
      found.push(full)
    }
  }
  return found.slice(0, MAX_RESOURCES)
}

interface Candidate {
  parsed: ParsedSkill
  sourcePath: string
  directory: string
  /** always reported even when invalid */
  explicit: boolean
}

function readSkillFile(path: string, format: 'skill-md' | 'json'): Candidate | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    logger.debug('skills', `cannot read ${path}: ${toError(error).message}`)
    return null
  }

  const fallbackName = basename(dirname(path)) || basename(path, extname(path))
  const parsed =
    format === 'skill-md' ? parseSkillMarkdown(raw, fallbackName) : parseSkillJson(raw, fallbackName)

  return { parsed, sourcePath: path, directory: dirname(path), explicit: format === 'skill-md' }
}

function walk(root: string, depth: number, out: Candidate[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_SKILLS) return

  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }

  const skillFile = entries.find((entry) => entry.toLowerCase() === 'skill.md')
  if (skillFile) {
    const candidate = readSkillFile(join(root, skillFile), 'skill-md')
    if (candidate) out.push(candidate)
    return // a skill directory owns its subtree
  }

  for (const entry of entries) {
    if (out.length >= MAX_SKILLS) return
    if (entry.startsWith('.') || SKIPPED_DIRS.has(entry)) continue
    const full = join(root, entry)

    let isDir: boolean
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }

    if (isDir) {
      walk(full, depth + 1, out)
      continue
    }

    const lower = entry.toLowerCase()
    if (!lower.endsWith('.json')) continue
    const candidate = readSkillFile(full, 'json')
    if (!candidate) continue
    // Only `.skill.json` / `skill.json` are reported when invalid, so unrelated
    // JSON files sitting in the folder do not show up as broken skills.
    const alwaysReport = lower.endsWith('.skill.json') || lower === 'skill.json'
    if (candidate.parsed.error === null || alwaysReport) out.push(candidate)
  }
}

class SkillRegistry {
  private cache: SkillInfo[] | null = null

  directories(): string[] {
    const defaults = [getPaths().skillsDir]
    const custom = settingsStore.get().skills.directories.filter((dir) => dir.trim().length > 0)
    return [...new Set([...defaults, ...custom])]
  }

  list(): SkillInfo[] {
    return this.cache ?? this.refresh()
  }

  get(id: string): SkillInfo | null {
    return this.list().find((skill) => skill.id === id) ?? null
  }

  refresh(): SkillInfo[] {
    const candidates: Candidate[] = []
    for (const directory of this.directories()) {
      if (!existsSync(directory)) continue
      walk(directory, 0, candidates)
    }

    const usedIds = new Set<string>()
    const skills: SkillInfo[] = candidates.map((candidate) => {
      let id = slug(candidate.parsed.name)
      if (usedIds.has(id)) id = `${id}-${hashOf(candidate.sourcePath)}`
      usedIds.add(id)

      const resources = listResourceFiles(candidate.directory).map(
        (file) => relative(candidate.directory, file).split(/[\\/]/).join('/')
      )

      return {
        id,
        name: candidate.parsed.name,
        description: candidate.parsed.description,
        systemPrompt: candidate.parsed.systemPrompt,
        allowedTools: candidate.parsed.allowedTools,
        format: candidate.parsed.format,
        sourcePath: candidate.sourcePath,
        directory: candidate.directory,
        error: candidate.parsed.error,
        resources
      }
    })

    skills.sort((a, b) => a.name.localeCompare(b.name))
    this.cache = skills
    logger.info('skills', `discovered ${skills.length} skill(s)`)
    return skills
  }

  invalidate(): void {
    this.cache = null
  }

  /** Reads an L3 resource, refusing anything that escapes the skill directory. */
  readResource(skillId: string, relativePath: string): string | null {
    const skill = this.get(skillId)
    if (!skill) return null

    const target = resolveInside(skill.directory, join(skill.directory, relativePath))
    if (!target) {
      logger.warn('skills', `refused out-of-tree resource read: ${relativePath}`)
      return null
    }

    try {
      const stats = statSync(target)
      if (!stats.isFile() || stats.size > MAX_RESOURCE_BYTES) return null
      return readFileSync(target, 'utf8')
    } catch (error) {
      logger.debug('skills', `resource read failed: ${toError(error).message}`)
      return null
    }
  }
}

export const skillRegistry = new SkillRegistry()
