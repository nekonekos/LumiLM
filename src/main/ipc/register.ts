import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { logger, toError } from '../util/logger'

/**
 * Wraps `ipcMain.handle` so handler failures are logged and surfaced to the
 * renderer as a plain Error message instead of an opaque rejection.
 */
export function registerHandler<Args extends unknown[], Result>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    try {
      return await handler(event, ...(args as Args))
    } catch (error) {
      const cause = toError(error)
      logger.error('ipc', `${channel} failed: ${cause.message}`)
      throw new Error(cause.message, { cause: error })
    }
  })
}
