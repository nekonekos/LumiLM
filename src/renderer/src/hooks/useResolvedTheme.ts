import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/stores/settings'

/** Resolved light/dark theme, re-evaluated when the OS preference changes. */
export function useResolvedTheme(): 'light' | 'dark' {
  const mode = useSettingsStore((state) => state.settings?.general.themeMode ?? 'system')
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  )

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
