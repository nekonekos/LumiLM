import { useCallback } from 'react'
import type { Locale } from '@shared/types'
import { useSettingsStore } from '@/stores/settings'
import { messages, type MessageKey } from './messages'

export type TranslateVars = Record<string, string | number>
export type TranslateFn = (key: MessageKey, vars?: TranslateVars) => string

export function translate(locale: Locale, key: MessageKey, vars?: TranslateVars): string {
  const dictionary = messages[locale] ?? messages['zh-CN']
  let text: string = dictionary[key] ?? key

  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value))
    }
  }
  return text
}

export function useLocale(): Locale {
  return useSettingsStore((state) => state.settings?.general.locale ?? 'zh-CN')
}

export function useT(): TranslateFn {
  const locale = useLocale()
  return useCallback<TranslateFn>((key, vars) => translate(locale, key, vars), [locale])
}

/**
 * Like {@link useT} but accepts an arbitrary string, which is useful for keys
 * produced by the main process (for example auto-tune notes).
 */
export function useDynamicT(): (key: string, vars?: TranslateVars) => string {
  const locale = useLocale()
  return useCallback(
    (key: string, vars?: TranslateVars) => translate(locale, key as MessageKey, vars),
    [locale]
  )
}

export { messages }
export type { MessageKey }
