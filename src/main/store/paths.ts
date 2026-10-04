import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AppPaths } from '@shared/types'

let dataDirOverride: string | null = null

export function setDataDirOverride(dir: string | null): void {
  dataDirOverride = dir && dir.trim().length > 0 ? dir : null
}

export function getDataDirOverride(): string | null {
  return dataDirOverride
}

export function getPaths(): AppPaths {
  const userData = app.getPath('userData')
  const dataDir = dataDirOverride ?? userData

  return {
    userData,
    dataDir,
    modelsDir: join(dataDir, 'models'),
    conversationsDir: join(dataDir, 'conversations'),
    attachmentsDir: join(dataDir, 'attachments'),
    presetsFile: join(dataDir, 'presets.json'),
    settingsFile: join(dataDir, 'settings.json'),
    logsDir: join(dataDir, 'logs'),
    llamaRoot: resolveLlamaRoot()
  }
}

/**
 * llama.cpp binaries live outside the asar archive: they are shipped through
 * `extraResources` when packaged and read from the repository in development.
 */
export function resolveLlamaRoot(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'llama')]
    : [join(app.getAppPath(), 'resources', 'llama')]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function ensureDataDirs(): void {
  const paths = getPaths()
  for (const dir of [
    paths.dataDir,
    paths.modelsDir,
    paths.conversationsDir,
    paths.attachmentsDir,
    paths.logsDir
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}
