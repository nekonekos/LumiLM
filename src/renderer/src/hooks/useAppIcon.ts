import { APP_ICONS } from '@shared/app-icons'
import { useResolvedTheme } from './useResolvedTheme'

/**
 * The LumiLM mark as a data URL, matching the window icon the main process
 * applies for the current theme.
 */
export function useAppIcon(): string {
  return APP_ICONS[useResolvedTheme()]
}
