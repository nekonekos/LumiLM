export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : digits)} ${units[unit]}`
}

export function formatGigabytes(bytes: number | null | undefined): string {
  if (!bytes) return '—'
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })
}

export function formatParameterCount(count: number | null | undefined): string {
  if (!count) return '—'
  if (count >= 1e12) return `${(count / 1e12).toFixed(1)}T`
  if (count >= 1e9) return `${(count / 1e9).toFixed(1)}B`
  if (count >= 1e6) return `${(count / 1e6).toFixed(0)}M`
  return formatNumber(count)
}

export function formatSpeed(tokensPerSecond: number | null | undefined): string {
  if (tokensPerSecond === null || tokensPerSecond === undefined || !Number.isFinite(tokensPerSecond)) {
    return '—'
  }
  return `${tokensPerSecond.toFixed(1)} tok/s`
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

export function formatRelativeTime(timestamp: number, locale: string): string {
  const delta = Date.now() - timestamp
  const minutes = Math.round(delta / 60_000)
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })

  if (minutes < 1) return formatter.format(0, 'minute')
  if (minutes < 60) return formatter.format(-minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours < 24) return formatter.format(-hours, 'hour')
  const days = Math.round(hours / 24)
  if (days < 30) return formatter.format(-days, 'day')
  return new Date(timestamp).toLocaleDateString(locale)
}

export function formatDateTime(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function truncate(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized
}
