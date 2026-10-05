/**
 * Registry of in-flight chat and agent streams. Both channels share it so an
 * abort always reaches the stream it names, whichever channel started it.
 */
const activeStreams = new Map<string, AbortController>()

export function registerStream(streamId: string, controller: AbortController): void {
  activeStreams.set(streamId, controller)
}

export function releaseStream(streamId: string): void {
  activeStreams.delete(streamId)
}

/** Returns false when the stream already finished or never existed. */
export function abortStream(streamId: string): boolean {
  const controller = activeStreams.get(streamId)
  if (!controller) return false
  controller.abort()
  return true
}

/** Called on shutdown so no stream is left waiting on a dead window. */
export function abortAllStreams(): void {
  for (const controller of activeStreams.values()) controller.abort()
  activeStreams.clear()
}
