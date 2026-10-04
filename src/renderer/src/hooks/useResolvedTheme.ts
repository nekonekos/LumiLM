import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/stores/settings'

/** Resolved light/dark theme, re-evaluated when the OS preference changes. */
export function useResolvedTheme(): 'light' | 'dark' {
  const mode = useSettingsStore((state) => state.settings?.general.themeMode ?? 'system')
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => {
    // The pre-paint script already resolved the stored preference, so trust it
    // until the settings arrive to avoid flashing the wrong icon.
    const applied = document.documentElement.dataset.theme
    if (applied === 'dark') return true
    if (applied === 'light') return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  useEffect(() => {
    if (mode !== 'system') return

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (): void => setSystemPrefersDark(media.matches)
    media.addEventListener('change', handler)
    return () => media.removeEventListener('change', handler)
  }, [mode])

  if (mode !== 'system') return mode
  return systemPrefersDark ? 'dark' : 'light'
}
