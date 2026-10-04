import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BackendKind, BackendProbe, ConcreteBackend } from '@shared/types'
import { getPaths } from '../store/paths'
import { logger } from '../util/logger'

const SERVER_EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
const PROBE_TTL_MS = 10 * 60 * 1000

export interface BackendResolution {
  kind: ConcreteBackend
  executable: string
  directory: string
}

export function backendDirectory(kind: ConcreteBackend): string | null {
  const root = getPaths().llamaRoot
  return root ? join(root, kind) : null
}

export function backendExecutable(kind: ConcreteBackend): string | null {
  const dir = backendDirectory(kind)
  if (!dir) return null
  const executable = join(dir, SERVER_EXE)
  return existsSync(executable) ? executable : null
}

export function resolveBackend(kind: ConcreteBackend): BackendResolution | null {
  const executable = backendExecutable(kind)
  if (!executable) return null
  return { kind, executable, directory: dirname(executable) }
}

interface RunResult {
  stdout: string
  stderr: string
  code: number | null
  error: string | null
}

export function runProcess(command: string, args: string[], timeoutMs = 20000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const rawCode = (error as { code?: unknown } | null)?.code
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code: typeof rawCode === 'number' ? rawCode : error ? null : 0,
          error: error ? error.message : null
        })
      }
    )
  })
}

function parseDevices(output: string): string[] {
  const lines = output.split(/\r?\n/)
  const devices: string[] = []
  let inSection = false
  for (const line of lines) {
    if (/available devices/i.test(line)) {
      inSection = true
      continue
    }
    if (!inSection) continue
    if (/^\s*$/.test(line)) continue
    const match = line.match(/^\s+([A-Za-z]+\d+):\s*(.+?)\s*$/)
    if (match && match[2]) {
      devices.push(match[2].trim())
    } else if (/^\s*\(none\)/i.test(line)) {
      break
    }
  }
  return devices
}

function parseVersion(output: string): string | null {
  const match = output.match(/version:\s*(\S+)/i)
  return match?.[1] ?? null
}

let probeCache: { at: number; probes: BackendProbe[] } | null = null

export async function probeBackends(force = false): Promise<BackendProbe[]> {
  if (!force && probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.probes

  const kinds: ConcreteBackend[] = ['cuda', 'vulkan', 'cpu']
  const probes: BackendProbe[] = []

  for (const kind of kinds) {
    const executable = backendExecutable(kind)
    if (!executable) {
      probes.push({
        kind,
        present: false,
        available: false,
        devices: [],
        version: null,
        error: 'backend binary not found'
      })
      continue
    }

    const versionResult = await runProcess(executable, ['--version'], 15000)
    const version = parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`)

    if (kind === 'cpu') {
      probes.push({ kind, present: true, available: true, devices: [], version, error: null })
      continue
    }

    const listResult = await runProcess(executable, ['--list-devices'], 25000)
    const combined = `${listResult.stdout}\n${listResult.stderr}`
    const devices = parseDevices(combined)
    const tail = combined.trim().split(/\r?\n/).slice(-3).join(' ')

    probes.push({
      kind,
      present: true,
      available: devices.length > 0,
      devices,
      version,
      error: devices.length > 0 ? null : (listResult.error ?? (tail.length > 0 ? tail : 'no devices'))
    })
  }

  logger.debug(
    'backend',
    `probe results: ${probes.map((p) => `${p.kind}=${p.available ? 'yes' : 'no'}`).join(', ')}`
  )

  probeCache = { at: Date.now(), probes }
  return probes
}

export function invalidateBackendProbe(): void {
  probeCache = null
}

/**
 * Resolves the backend that should be used. `auto` prefers CUDA, then Vulkan,
 * and finally falls back to the CPU build which always works.
 */
export function chooseBackend(preferred: BackendKind, probes: BackendProbe[]): ConcreteBackend | null {
  const byKind = new Map(probes.map((probe) => [probe.kind, probe]))

  if (preferred !== 'auto') {
    const wanted = byKind.get(preferred)
    if (wanted?.available) return preferred
    logger.warn('backend', `requested backend "${preferred}" is unavailable, falling back to auto`)
  }

  for (const kind of ['cuda', 'vulkan', 'cpu'] as ConcreteBackend[]) {
    if (byKind.get(kind)?.available) return kind
  }
  return null
}
