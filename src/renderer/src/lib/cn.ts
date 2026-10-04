export type ClassValue = string | false | null | undefined | ClassValue[]

/** Minimal class name joiner (no dependency on tailwind-merge at runtime cost). */
export function cn(...values: ClassValue[]): string {
  const out: string[] = []
  for (const value of values) {
    if (!value) continue
    if (Array.isArray(value)) {
      const nested = cn(...value)
      if (nested) out.push(nested)
    } else {
      out.push(value)
    }
  }
  return out.join(' ')
}
