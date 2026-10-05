/**
 * The date unit the memory layer groups by.
 *
 * Occurrences are compared per *local* calendar day: 「今天加班」 said twice in one
 * evening is one instance, the same sentence the next evening is a second. Using
 * a UTC key would put anything after 08:00 local into the same bucket anyway, but
 * it would move the boundary to the middle of the evening for a UTC+8 user, so the
 * local date is the only defensible unit here.
 */
export function localDayKey(timestamp: number): string {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** `MM-DD`, for the compact forms the prompt and the library show. */
export function shortDayKey(dateKey: string): string {
  return dateKey.length >= 10 ? dateKey.slice(5) : dateKey
}
