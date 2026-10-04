import { arch, cpus, freemem, platform, release, totalmem } from 'node:os'
import type { BackendProbe, GpuInfo, GpuVendor, HardwareInfo } from '@shared/types'
import { settingsStore } from '../store/settings'
import { logger } from '../util/logger'
import { chooseBackend, probeBackends, runProcess } from './backend'

const HW_TTL_MS = 5 * 60 * 1000

function detectVendor(name: string): GpuVendor {
  const lower = name.toLowerCase()
  if (/nvidia|geforce|quadro|\brtx\b|\bgtx\b|tesla/.test(lower)) return 'nvidia'
  if (/amd|radeon|ati technologies/.test(lower)) return 'amd'
  if (/intel|\barc\b|iris|\buhd graphics\b|\bhd graphics\b/.test(lower)) return 'intel'
  return name.trim().length === 0 ? 'unknown' : 'other'
}

async function detectNvidiaSmi(): Promise<GpuInfo[]> {
  const candidates = ['nvidia-smi', 'C:\\Windows\\System32\\nvidia-smi.exe']
  for (const candidate of candidates) {
    const result = await runProcess(
      candidate,
      ['--query-gpu=index,name,memory.total', '--format=csv,noheader,nounits'],
      8000
    )
    const output = `${result.stdout}\n${result.stderr}`.trim()
    if (result.error && result.stdout.trim().length === 0) continue
    if (output.length === 0) continue

    const gpus: GpuInfo[] = []
    for (const line of output.split(/\r?\n/)) {
      const parts = line.split(',').map((p) => p.trim())
      if (parts.length < 3) continue
      const index = Number(parts[0])
      const name = parts[1] ?? ''
      const mib = Number(parts[2])
      gpus.push({
        index: Number.isFinite(index) ? index : gpus.length,
        name,
        vramBytes: Number.isFinite(mib) && mib > 0 ? Math.round(mib * 1024 * 1024) : null,
        vendor: detectVendor(name),
        source: 'nvidia-smi'
      })
    }
    if (gpus.length > 0) return gpus
  }
  return []
}

/**
 * Reads the CPU model, physical core count and GPU adapter memory in a single
 * PowerShell call. The registry key `HardwareInformation.qwMemorySize` is used
 * because `Win32_VideoController.AdapterRAM` is clamped to 4 GiB.
 */
const PS_HARDWARE_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1',
  '$cores = 0',
  'if ($cpu -and $cpu.NumberOfCores) { $cores = [int]$cpu.NumberOfCores }',
  '$gpus = @()',
  'Get-ChildItem "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}" | ForEach-Object {',
  '  $p = Get-ItemProperty -Path $_.PSPath',
  '  if ($p -and $p.DriverDesc) {',
  '    $vram = 0',
  '    $prop = $p.PSObject.Properties["HardwareInformation.qwMemorySize"]',
  '    if ($prop -and $prop.Value) {',
  '      $v = $prop.Value',
  '      if ($v -is [byte[]]) {',
  '        if ($v.Length -eq 8) { $vram = [BitConverter]::ToUInt64($v, 0) }',
  '        elseif ($v.Length -eq 4) { $vram = [BitConverter]::ToUInt32($v, 0) }',
  '      } else { $vram = [int64]$v }',
  '    }',
  '    $gpus += [pscustomobject]@{ name = $p.DriverDesc; vram = $vram }',
  '  }',
  '}',
  'if ($gpus.Count -eq 0) {',
  '  Get-CimInstance Win32_VideoController | ForEach-Object {',
  '    $vram = 0',
  '    if ($_.AdapterRAM -gt 0) { $vram = [int64]$_.AdapterRAM }',
  '    $gpus += [pscustomobject]@{ name = $_.Name; vram = $vram }',
  '  }',
  '}',
  '[pscustomobject]@{ cpu = $cpu.Name; cores = $cores; gpus = @($gpus) } | ConvertTo-Json -Compress -Depth 4'
].join('\n')

interface WindowsHardware {
  cpu: string
  cores: number
  gpus: GpuInfo[]
}

async function detectWindowsHardware(): Promise<WindowsHardware | null> {
  const result = await runProcess(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_HARDWARE_SCRIPT],
    20000
  )
  const raw = result.stdout.trim()
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as {
      cpu?: string
      cores?: number
      gpus?: Array<{ name?: string; vram?: number }> | { name?: string; vram?: number }
    }
    const list = parsed.gpus === undefined ? [] : Array.isArray(parsed.gpus) ? parsed.gpus : [parsed.gpus]
    const gpus: GpuInfo[] = list
      .filter((gpu) => typeof gpu?.name === 'string' && gpu.name.length > 0)
      .map((gpu, index) => {
        const vram = typeof gpu.vram === 'number' && gpu.vram > 0 ? gpu.vram : null
        const name = gpu.name as string
        return {
          index,
          name,
          vramBytes: vram,
          vendor: detectVendor(name),
          source: 'registry' as const
        }
      })
    return {
      cpu: typeof parsed.cpu === 'string' ? parsed.cpu : '',
      cores: typeof parsed.cores === 'number' && parsed.cores > 0 ? parsed.cores : 0,
      gpus
    }
  } catch (error) {
    logger.warn('hardware', `failed to parse hardware probe: ${String(error)}`)
    return null
  }
}

interface CachedHardware {
  cpuModel: string
  physicalCores: number
  logicalCores: number
  totalRamBytes: number
  gpus: GpuInfo[]
  probes: BackendProbe[]
  probedAt: number
}

let cache: { at: number; data: CachedHardware } | null = null

async function collectHardware(): Promise<CachedHardware> {
  const logicalCores = cpus().length
  let physicalCores = 0
  let cpuModel = cpus()[0]?.model?.trim() ?? ''
  let gpus: GpuInfo[] = []

  if (platform() === 'win32') {
    const windows = await detectWindowsHardware()
    if (windows) {
      physicalCores = windows.cores
      cpuModel = windows.cpu || cpuModel
      gpus = windows.gpus
    }
  }

  const nvidia = await detectNvidiaSmi()
  if (nvidia.length > 0) {
    const byName = new Map(gpus.map((gpu) => [gpu.name.toLowerCase(), gpu]))
    for (const gpu of nvidia) {
      const existing = byName.get(gpu.name.toLowerCase())
      if (existing) {
        existing.vramBytes = gpu.vramBytes ?? existing.vramBytes
        existing.source = 'nvidia-smi'
      } else {
        gpus.push(gpu)
      }
    }
  }

  if (physicalCores <= 0) physicalCores = Math.max(1, Math.floor(logicalCores / 2))

  const probes = await probeBackends()

  return {
    cpuModel: cpuModel || 'Unknown CPU',
    physicalCores: Math.min(physicalCores, logicalCores),
    logicalCores,
    totalRamBytes: totalmem(),
    gpus,
    probes,
    probedAt: Date.now()
  }
}

export async function detectHardware(force = false): Promise<HardwareInfo> {
  if (force || !cache || Date.now() - cache.at >= HW_TTL_MS) {
    cache = { at: Date.now(), data: await collectHardware() }
  }

  const data = cache.data
  const { inference } = settingsStore.get()

  return {
    cpuModel: data.cpuModel,
    physicalCores: data.physicalCores,
    logicalCores: data.logicalCores,
    totalRamBytes: data.totalRamBytes,
    freeRamBytes: freemem(),
    gpus: data.gpus,
    os: `${platform()} ${release()}`,
    arch: arch(),
    backends: data.probes,
    selectedBackend: chooseBackend(inference.backend, data.probes),
    probedAt: data.probedAt
  }
}

/** Best guess at the dedicated GPU memory available for the model. */
export function primaryVramBytes(hardware: HardwareInfo): number {
  const withMemory = hardware.gpus.filter((gpu) => (gpu.vramBytes ?? 0) > 0)
  if (withMemory.length === 0) return 0
  const discrete = withMemory.filter((gpu) => gpu.vendor === 'nvidia' || gpu.vendor === 'amd')
  const pool = discrete.length > 0 ? discrete : withMemory
  return Math.max(...pool.map((gpu) => gpu.vramBytes ?? 0))
}

export function invalidateHardware(): void {
  cache = null
}
