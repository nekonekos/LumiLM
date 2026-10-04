import { app, dialog, shell, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { CH } from '@shared/channels'
import type { AppInfo, AppPaths, ConcreteBackend, LlamaBackendInfo } from '@shared/types'
import { readJsonSync } from '../util/atomic-json'
import { logger } from '../util/logger'
import { getPaths } from '../store/paths'
import { settingsStore } from '../store/settings'
import { modelLibrary } from '../gguf/scanner'
import { serverManager } from '../llama/server-manager'
import { detectHardware } from '../llama/hardware'
import { registerHandler } from './register'

const SERVER_EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_BYTES = 16 * 1024 * 1024

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

interface LlamaVersionFile {
  version?: string
  tag?: string
  fetchedAt?: string
  backends?: string[]
}

function llamaBackends(): { version: string | null; backends: LlamaBackendInfo[] } {
  const paths = getPaths()
  const root = paths.llamaRoot
  const meta = root ? readJsonSync<LlamaVersionFile>(join(root, 'VERSION.json')) : null

  const kinds: ConcreteBackend[] = ['cpu', 'vulkan', 'cuda']
  const backends = kinds.map((kind) => {
    const directory = root ? join(root, kind) : null
    const executable = directory ? join(directory, SERVER_EXE) : null
    const present = Boolean(executable && existsSync(executable))
    return {
      kind,
      present,
      version: meta?.version ?? null,
      path: present ? executable : null
    }
  })

  return { version: meta?.version ?? null, backends }
}

export function buildAppInfo(): AppInfo {
  const { version, backends } = llamaBackends()
  return {
    version: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown',
    v8: process.versions.v8 ?? 'unknown',
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    llamaVersion: version,
    llamaBackends: backends
  }
}

export function registerSystemHandlers(): void {
  registerHandler(CH.app.getInfo, (): AppInfo => buildAppInfo())

  registerHandler(CH.app.getPaths, (): AppPaths => getPaths())

  registerHandler(CH.app.openPath, async (_event, target: string) => {
    if (typeof target !== 'string' || target.length === 0) return
    if (!existsSync(target)) throw new Error(`Path does not exist: ${target}`)
    await shell.openPath(target)
  })

  registerHandler(CH.app.openExternal, async (_event, url: string) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false
    await shell.openExternal(url)
    return true
  })

  registerHandler(CH.app.showItemInFolder, (_event, target: string) => {
    if (typeof target !== 'string' || target.length === 0) return
    shell.showItemInFolder(target)
  })

  registerHandler(CH.app.exportDiagnostics, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const result = await dialog.showSaveDialog(window as BrowserWindow, {
      title: 'Export LumiLM diagnostics',
      defaultPath: join(app.getPath('downloads'), `lumilm-diagnostics-${stamp}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return null

    const payload = {
      generatedAt: new Date().toISOString(),
      app: buildAppInfo(),
      paths: getPaths(),
      settings: settingsStore.get(),
      hardware: await detectHardware(true),
      server: serverManager.getState(),
      models: (await modelLibrary.list()).map((model) => ({
        fileName: model.fileName,
        path: model.path,
        sizeBytes: model.sizeBytes,
        metadata: model.metadata,
        recommended: model.recommended
      })),
      logs: serverManager.getLogs().slice(-500),
      appLogs: logger.recent().slice(-500)
    }

    writeFileSync(result.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    return result.filePath
  })

  registerHandler(CH.dialog.pickModelFiles, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(window as BrowserWindow, {
      title: 'Select GGUF model files',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'GGUF models', extensions: ['gguf'] }]
    })
    return result.canceled ? [] : result.filePaths
  })

  registerHandler(CH.dialog.pickDirectory, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(window as BrowserWindow, {
      title: 'Select a model folder',
      properties: ['openDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  registerHandler(CH.dialog.pickImages, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(window as BrowserWindow, {
      title: 'Select images',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    })
    return result.canceled ? [] : result.filePaths
  })

  registerHandler(CH.fs.readTextFile, (_event, filePath: string) => {
    if (typeof filePath !== 'string' || !existsSync(filePath)) return null
    const stats = statSync(filePath)
    if (!stats.isFile() || stats.size > MAX_TEXT_FILE_BYTES) return null
    const content = readFileSync(filePath, 'utf8')
    return { path: filePath, name: basename(filePath), content }
  })

  registerHandler(CH.fs.readImage, (_event, filePath: string) => {
    if (typeof filePath !== 'string' || !existsSync(filePath)) return null
    const stats = statSync(filePath)
    if (!stats.isFile() || stats.size > MAX_IMAGE_BYTES) return null
    const mime = MIME_BY_EXTENSION[extname(filePath).toLowerCase()] ?? 'image/png'
    return `data:${mime};base64,${readFileSync(filePath).toString('base64')}`
  })

  registerHandler(CH.fs.saveAttachment, (_event, fileName: string, dataUrl: string) => {
    if (typeof dataUrl !== 'string') return null
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
    if (!match || !match[1] || !match[2]) return null

    const extension = extname(typeof fileName === 'string' ? fileName : '').toLowerCase() || '.png'
    const safeExtension = /^\.[a-z0-9]{2,5}$/.test(extension) ? extension : '.png'
    const buffer = Buffer.from(match[2], 'base64')
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) return null

    const directory = getPaths().attachmentsDir
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })

    const target = join(directory, `${randomUUID()}${safeExtension}`)
    writeFileSync(target, buffer)
    return target
  })

  registerHandler(CH.fs.exists, (_event, target: string) =>
    typeof target === 'string' ? existsSync(target) : false
  )

  registerHandler(CH.fs.stat, (_event, target: string) => {
    if (typeof target !== 'string' || !existsSync(target)) return null
    try {
      const stats = statSync(target)
      return { sizeBytes: stats.size, isDirectory: stats.isDirectory() }
    } catch {
      return null
    }
  })
}
