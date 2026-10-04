import { BrowserWindow, app, nativeTheme, session } from 'electron'
import { logger, toError } from './util/logger'
import { ensureDataDirs, getPaths } from './store/paths'
import { settingsStore } from './store/settings'
import { applyThemeSource, createMainWindow, focusMainWindow } from './window'
import { registerAllHandlers, wireEventForwarding } from './ipc'
import { setEventTarget } from './ipc/events'
import { abortAllStreams } from './ipc/chat'
import { serverManager } from './llama/server-manager'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function enforceOfflinePolicy(): void {
  const devOrigin = process.env['ELECTRON_RENDERER_URL']

  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      let hostname: string
      try {
        hostname = new URL(details.url).hostname
      } catch {
        hostname = ''
      }

      const isLocal = LOCAL_HOSTS.has(hostname)
      const isDevServer = devOrigin ? details.url.startsWith(devOrigin) : false

      if (isLocal || isDevServer) {
        callback({})
        return
      }

      logger.warn('security', `blocked outbound request to ${hostname}`)
      callback({ cancel: true })
    }
  )

  session.defaultSession.setSpellCheckerEnabled(false)
}

async function bootstrap(): Promise<void> {
  await app.whenReady()

  app.setAppUserModelId('com.nekonekos.lumilm')

  const settings = settingsStore.load()
  const paths = getPaths()
  ensureDataDirs()
  logger.init(paths.logsDir)
  logger.setLevel(settings.advanced.logLevel)
  logger.info('app', `LumiLM ${app.getVersion()} starting (electron ${process.versions.electron})`)

  enforceOfflinePolicy()
  registerAllHandlers()
  wireEventForwarding()

  const win = createMainWindow()
  setEventTarget(win.webContents)
  applyThemeSource(settings.general.themeMode)

  nativeTheme.on('updated', () => {
    applyThemeSource(settingsStore.get().general.themeMode)
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error('app', `renderer process gone: ${details.reason}`)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const created = createMainWindow()
      setEventTarget(created.webContents)
    } else {
      focusMainWindow()
    }
  })
}

app.on('window-all-closed', () => {
  app.quit()
})

let shutdownStarted = false
app.on('before-quit', (event) => {
  if (shutdownStarted) return
  shutdownStarted = true
  event.preventDefault()

  abortAllStreams()
  void serverManager
    .shutdown()
    .catch((error) => logger.warn('app', `shutdown error: ${toError(error).message}`))
    .finally(() => {
      setEventTarget(null)
      app.exit(0)
    })
})

process.on('uncaughtException', (error) => {
  logger.error('app', `uncaught exception: ${error.stack ?? error.message}`)
})

process.on('unhandledRejection', (reason) => {
  logger.error('app', `unhandled rejection: ${String(reason)}`)
})

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => focusMainWindow())
  bootstrap().catch((error) => {
    logger.error('app', `failed to start: ${toError(error).message}`)
    app.exit(1)
  })
}
