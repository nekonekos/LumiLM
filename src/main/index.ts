import { BrowserWindow, app, nativeTheme, powerMonitor, session } from 'electron'
import { logger, toError } from './util/logger'
import { ensureDataDirs, getPaths } from './store/paths'
import { settingsStore } from './store/settings'
import { applyThemeSource, createMainWindow, focusMainWindow } from './window'
import { registerAllHandlers, wireEventForwarding } from './ipc'
import { setEventTarget, emitHeartbeat, emitMemoryChanged } from './ipc/events'
import { abortAllStreams } from './ipc/streams'
import { serverManager } from './llama/server-manager'
import { mcpManager } from './mcp/manager'
import { companionService } from './companion/service'
import { heartbeatService, setHeartbeatHooks } from './companion/heartbeat'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function enforceOfflinePolicy(): void {
  const devOrigin = process.env['ELECTRON_RENDERER_URL']

  // Only the renderer's session is filtered. Main process network calls (used
  // by remote MCP transports) do not go through this hook, which is why
  // remote servers stay behind an explicit opt-in in Settings → Agent.
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

  // MCP servers are started only after the renderer can receive status events.
  void mcpManager.initialize(app.getVersion()).catch((error) => {
    logger.warn('mcp', `initialization failed: ${toError(error).message}`)
  })

  // The companion wakes up on its own timer, so it needs the window's focus
  // state and a way to bring the window forward when its notification is
  // clicked. The hooks are installed before the service starts for that reason.
  setHeartbeatHooks({
    isWindowFocused: () => BrowserWindow.getAllWindows().some((entry) => entry.isFocused()),
    isFullScreen: () => BrowserWindow.getAllWindows().some((entry) => entry.isFullScreen()),
    notificationClicked: () => {
      if (!settingsStore.get().companion.focusOnNotification) return
      focusMainWindow()
    },
    onGreeting: (event) => emitHeartbeat(event)
  })

  companionService.start(() => {
    try {
      emitMemoryChanged(companionService.overview())
    } catch (error) {
      logger.warn('companion', `failed to broadcast memory change: ${toError(error).message}`)
    }
  })

  powerMonitor.on('suspend', () => heartbeatService.suspend())
  powerMonitor.on('resume', () => heartbeatService.resume())
  powerMonitor.on('lock-screen', () => heartbeatService.suspend())
  powerMonitor.on('unlock-screen', () => heartbeatService.resume())
  // A returning user is not "idle", so the idle clock effectively restarts.
  powerMonitor.on('user-did-become-active', () => heartbeatService.resume())

  if (settingsStore.get().companion.heartbeatEnabled) heartbeatService.start()

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
  heartbeatService.stop()
  companionService.shutdown()
  void Promise.allSettled([serverManager.shutdown(), mcpManager.shutdown()])
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
