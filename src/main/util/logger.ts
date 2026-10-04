import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import type { LogLevel } from '@shared/types'

const LEVEL_WEIGHT: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }
const MAX_LOG_BYTES = 4 * 1024 * 1024
const RING_CAPACITY = 2000

/**
 * Lightweight leveled logger. Writes to the console and, once {@link init} has
 * been called, to a rotating file inside the data directory.
 */
class Logger {
  private level: LogLevel = 'info'
  private stream: WriteStream | null = null
  private logFile: string | null = null
  private ring: string[] = []

  setLevel(level: LogLevel): void {
    this.level = level
  }

  getLevel(): LogLevel {
    return this.level
  }

  init(dir: string): void {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      this.logFile = join(dir, 'lumilm.log')
      if (existsSync(this.logFile) && statSync(this.logFile).size > MAX_LOG_BYTES) {
        renameSync(this.logFile, join(dir, 'lumilm.previous.log'))
      }
      this.stream = createWriteStream(this.logFile, { flags: 'a' })
    } catch {
      this.stream = null
    }
  }

  /** Recent log lines kept in memory, newest last. */
  recent(): string[] {
    return [...this.ring]
  }

  clear(): void {
    this.ring = []
  }

  private write(level: LogLevel, scope: string, args: unknown[]): void {
    if (LEVEL_WEIGHT[level] > LEVEL_WEIGHT[this.level]) return
    const text = args
      .map((a) => {
        if (typeof a === 'string') return a
        if (a instanceof Error) return `${a.name}: ${a.message}`
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      })
      .join(' ')
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${scope}] ${text}`

    this.ring.push(line)
    if (this.ring.length > RING_CAPACITY) this.ring.splice(0, this.ring.length - RING_CAPACITY)

    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)

    this.stream?.write(`${line}\n`)
  }

  error(scope: string, ...args: unknown[]): void {
    this.write('error', scope, args)
  }

  warn(scope: string, ...args: unknown[]): void {
    this.write('warn', scope, args)
  }

  info(scope: string, ...args: unknown[]): void {
    this.write('info', scope, args)
  }

  debug(scope: string, ...args: unknown[]): void {
    this.write('debug', scope, args)
  }
}

export const logger = new Logger()

export function toError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(typeof value === 'string' ? value : JSON.stringify(value))
}
