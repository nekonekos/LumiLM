import { BrowserWindow, nativeTheme, screen, shell, type WebContents } from 'electron'
import { join } from 'node:path'
import type { ThemeMode } from '@shared/types'
import { settingsStore } from './store/settings'
import { logger } from './util/logger'

const MIN_WIDTH = 960
const MIN_HEIGHT = 640

const TITLE_BAR_COLORS = {
  light: { color: '#eef5ff', symbolColor: '#1e3a5f' },
  dark: { color: '#0b1220', symbolColor: '#dbeafe' }
} as const

function overlayColors(): { color: string; symbolColor: string } {
  return nativeTheme.shouldUseDarkColors ? TITLE_BAR_COLORS.dark : TITLE_BAR_COLORS.light
}

export function applyThemeSource(themeMode: ThemeMode): void {
  nativeTheme.themeSource = themeMode
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      window.setBackgroundColor(
        nativeTheme.shouldUseDarkColors ? TITLE_BAR_COLORS.dark.color : TITLE_BAR_COLORS.light.color
      )
      window.setTitleBarOverlay({ ...overlayColors(), height: 38 })
    } catch {
      /* titleBarOverlay is unsupported on very old Windows builds */
    }
  }
}

function isOnScreen(bounds: { x: number; y: number }, width: number, height: number): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return (
      bounds.x + width > area.x &&
      bounds.x < area.x + area.width &&
      bounds.y + height > area.y &&
      bounds.y < area.y + area.height
    )
  })
}

export function createMainWindow(): BrowserWindow {
  const { window: windowSettings, general } = settingsStore.get()
  nativeTheme.themeSource = general.themeMode

  const width = Math.max(MIN_WIDTH, windowSettings.width)
  const height = Math.max(MIN_HEIGHT, windowSettings.height)
  const hasPosition =
    windowSettings.x !== null &&
    windowSettings.y !== null &&
    isOnScreen({ x: windowSettings.x, y: windowSettings.y }, width, height)

  const win = new BrowserWindow({
    width,
    height,
    x: hasPosition ? (windowSettings.x as number) : undefined,
    y: hasPosition ? (windowSettings.y as number) : undefined,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: overlayColors().color,
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...overlayColors(), height: 38 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: true
    }
  })

  if (windowSettings.maximized) win.maximize()

  win.once('ready-to-show', () => {
    win.show()
  })

  const persistBounds = (): void => {
    if (win.isDestroyed()) return
    const maximized = win.isMaximized()
    const bounds = win.getNormalBounds()
    settingsStore.update({
      window: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        maximized
      }
    })
  }

  win.on('close', persistBounds)

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith('file://')
    if (!allowed) {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  logger.info('window', `main window created (${width}x${height})`)
  return win
}

export function windowWebContents(): WebContents | null {
  const [win] = BrowserWindow.getAllWindows()
  return win?.webContents ?? null
}

export function focusMainWindow(): void {
  const [win] = BrowserWindow.getAllWindows()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
}
