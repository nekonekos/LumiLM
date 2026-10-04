import { BrowserWindow, nativeImage, nativeTheme, type NativeImage } from 'electron'
import { APP_ICONS, type AppIconTheme } from '@shared/app-icons'
import { logger } from './util/logger'

const cache = new Map<AppIconTheme, NativeImage>()
let loggedTheme: AppIconTheme | null = null

/** The theme the operating system chrome should use right now. */
export function currentIconTheme(): AppIconTheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/** Decodes the inlined mark once per theme and reuses the result. */
export function appIcon(theme: AppIconTheme): NativeImage {
  const cached = cache.get(theme)
  if (cached) return cached

  const image = nativeImage.createFromDataURL(APP_ICONS[theme])
  if (image.isEmpty()) logger.warn('window', `the ${theme} app icon could not be decoded`)

  cache.set(theme, image)
  return image
}

/** Applies the matching mark to every open window (taskbar, Alt-Tab, title bar). */
export function applyWindowIcon(): void {
  const theme = currentIconTheme()
  const icon = appIcon(theme)
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setIcon(icon)
  }

  if (loggedTheme !== theme) {
    loggedTheme = theme
    logger.info('window', `window icon set to the ${theme} mark (${icon.getSize().width}px)`)
  }
}
