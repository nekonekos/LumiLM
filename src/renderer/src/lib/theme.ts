import { APP_ICONS } from '@shared/app-icons'
import type { ThemeMode } from '@shared/types'

export const THEME_STORAGE_KEY = 'lumilm.theme'
export const ACCENT_STORAGE_KEY = 'lumilm.accent'
export const DEFAULT_ACCENT = '#3b82f6'

export function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') return prefersDark() ? 'dark' : 'light'
  return mode
}

function parseHex(hex: string): [number, number, number] | null {
  const normalized = hex.replace('#', '').trim()
  if (normalized.length !== 6) return null
  const value = Number.parseInt(normalized, 16)
  if (Number.isNaN(value)) return null
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function mixWithWhite(hex: string, amount: number): string {
  const rgb = parseHex(hex)
  if (!rgb) return hex
  const mixed = rgb.map((channel) => Math.round(channel + (255 - channel) * amount))
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

/** Keeps the document favicon in step with the mark shown in the title bar. */
function applyFavicon(resolved: 'light' | 'dark'): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    link.type = 'image/png'
    document.head.append(link)
  }
  link.href = APP_ICONS[resolved]
}

/** Applies the theme to the document and remembers the choice for the next launch. */
export function applyTheme(mode: ThemeMode, accent: string): 'light' | 'dark' {
  const resolved = resolveTheme(mode)
  const root = document.documentElement

  root.dataset.theme = resolved
  root.style.colorScheme = resolved

  const brand = resolved === 'dark' ? mixWithWhite(accent, 0.28) : accent
  root.style.setProperty('--color-brand', brand)
  root.style.setProperty('--lm-accent', brand)

  applyFavicon(resolved)

  try {
    localStorage.setItem(THEME_STORAGE_KEY, resolved)
    localStorage.setItem(ACCENT_STORAGE_KEY, accent)
  } catch {
    /* ignore unavailable storage */
  }

  return resolved
}
