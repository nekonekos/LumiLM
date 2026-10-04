import { useEffect, useState } from 'react'

const cache = new Map<string, string>()
const pending = new Map<string, Promise<string | null>>()

/**
 * Loads a local image through the main process and returns a data URL.
 * Results are cached for the lifetime of the renderer, so a cached image is
 * available synchronously during render.
 */
export function useImageDataUrl(path: string | undefined | null): string | null {
  const [loaded, setLoaded] = useState<{ path: string; url: string } | null>(null)

  useEffect(() => {
    if (!path || cache.has(path)) return

    let cancelled = false
    let request = pending.get(path)
    if (!request) {
      request = window.lumilm.fs.readImageAsDataUrl(path).then((data) => {
        pending.delete(path)
        if (data) cache.set(path, data)
        return data
      })
      pending.set(path, request)
    }

    void request.then((data) => {
      if (!cancelled && data) setLoaded({ path, url: data })
    })

    return () => {
      cancelled = true
    }
  }, [path])

  if (!path) return null
  return cache.get(path) ?? (loaded?.path === path ? loaded.url : null)
}
