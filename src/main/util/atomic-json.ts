import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { logger, toError } from './logger'

function ensureDir(file: string): void {
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/**
 * Atomically writes JSON: content goes to a temp file first and is then renamed
 * over the target, so a crash can never leave a half written file behind.
 * The previous revision is kept next to the file as `<name>.bak`.
 */
export function writeJsonAtomicSync(file: string, data: unknown): void {
  ensureDir(file)
  const tmp = `${file}.tmp`
  const payload = `${JSON.stringify(data, null, 2)}\n`
  writeFileSync(tmp, payload, 'utf8')

  try {
    if (existsSync(file)) copyFileSync(file, `${file}.bak`)
    renameSync(tmp, file)
  } catch (error) {
    logger.warn('atomic-json', `failed to commit ${file}: ${toError(error).message}`)
    try {
      renameSync(tmp, file)
    } catch {
      /* ignore */
    }
  }
}

/** Reads JSON, transparently recovering from `<name>.bak` when the file is corrupt. */
export function readJsonSync<T>(file: string): T | null {
  const attempt = (candidate: string): T | null => {
    if (!existsSync(candidate)) return null
    try {
      const raw = readFileSync(candidate, 'utf8')
      if (raw.trim().length === 0) return null
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  const primary = attempt(file)
  if (primary !== null) return primary

  if (existsSync(file)) {
    logger.warn('atomic-json', `corrupt json detected, trying backup: ${file}`)
  }
  return attempt(`${file}.bak`)
}
