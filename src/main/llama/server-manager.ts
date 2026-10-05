import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import type {
  ConcreteBackend,
  LoadOptions,
  ModelInfo,
  RecommendedParams,
  RuntimeMetrics,
  ServerState
} from '@shared/types'
import { modelLibrary } from '../gguf/scanner'
import { settingsStore } from '../store/settings'
import { logger, toError } from '../util/logger'
import { buildServerArgs, redactArgs, splitArgs } from './args'
import { computeRecommendation, degradeRecommendation } from './auto-tune'
import { chooseBackend, probeBackends, resolveBackend, runProcess } from './backend'
import { LlamaClient } from './client'
import { detectHardware, primaryVramBytes } from './hardware'

const MAX_LOG_LINES = 4000
const HEALTH_POLL_MS = 400
const MAX_ATTEMPTS = 3

const MEMORY_ERROR_PATTERN =
  /out of memory|outofmemory|\boom\b|failed to allocate|cudamalloc|cuda_error_out_of_memory|erroroutofdevicememory|ggml_backend_.*alloc_buffer.*fail|not enough memory|insufficient memory/i

export function createInitialState(): ServerState {
  return {
    status: 'idle',
    modelId: null,
    modelPath: null,
    modelName: null,
    mmprojPath: null,
    backend: null,
    port: null,
    pid: null,
    contextSize: null,
    gpuLayers: null,
    totalLayers: null,
    kvCacheType: null,
    startedAt: null,
    error: null,
    progress: null,
    degradedRetries: 0,
    commandLine: null,
    supportsTools: null,
    metrics: null
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

function directoryOf(executable: string): string {
  const index = Math.max(executable.lastIndexOf('\\'), executable.lastIndexOf('/'))
  return index > 0 ? executable.slice(0, index) : process.cwd()
}

function extractContextSize(props: Record<string, unknown> | null): number | null {
  if (!props) return null
  const direct = props.n_ctx
  if (typeof direct === 'number' && direct > 0) return direct
  const settings = props.default_generation_settings
  if (settings && typeof settings === 'object') {
    const nCtx = (settings as { n_ctx?: unknown }).n_ctx
    if (typeof nCtx === 'number' && nCtx > 0) return nCtx
  }
  return null
}

/**
 * llama.cpp can only turn a tool call into the native `tool_calls` channel when
 * the model's chat template handles tools. The template is reported by /props,
 * so it doubles as a cheap capability probe. `null` means "unknown".
 */
export function extractToolSupport(props: Record<string, unknown> | null): boolean | null {
  if (!props) return null
  const template = props.chat_template
  if (typeof template !== 'string' || template.length === 0) return null
  return /tool_call|tool_calls|function_call|[^a-z]tools[^a-z]/i.test(template)
}

interface StartConfig {
  model: ModelInfo
  recommendation: RecommendedParams
  executable: string
  mmprojPath: string | null
  extraArgs: string[]
  alias: string
}

function pickNumber(
  optionValue: number | 'auto' | undefined,
  settingValue: number | 'auto',
  fallback: number
): number {
  if (optionValue !== undefined && optionValue !== 'auto') return optionValue
  if (settingValue !== 'auto') return settingValue
  return fallback
}

type TriState = boolean | 'auto'

function pickBoolean(optionValue: TriState | undefined, settingValue: TriState, fallback: boolean): boolean {
  if (optionValue !== undefined && optionValue !== 'auto') return optionValue
  if (settingValue !== 'auto') return settingValue
  return fallback
}

class ServerManager extends EventEmitter {
  private child: ChildProcess | null = null
  private state: ServerState = createInitialState()
  private logs: string[] = []
  private llamaClient: LlamaClient | null = null
  private apiKey = ''
  private starting = false
  private stopRequested = false
  private cancelRequested = false
  private idleTimer: NodeJS.Timeout | null = null
  private metrics: RuntimeMetrics = {
    ttftMs: null,
    tokensPerSecond: null,
    promptTokens: null,
    completionTokens: null,
    contextUsedTokens: null,
    contextSize: null,
    promptPerSecond: null,
    lastUpdated: Date.now()
  }

  getState(): ServerState {
    return { ...this.state, metrics: { ...this.metrics } }
  }

  getLogs(): string[] {
    return [...this.logs]
  }

  clearLogs(): void {
    this.logs = []
  }

  getClient(): LlamaClient | null {
    return this.state.status === 'ready' ? this.llamaClient : null
  }

  isReady(): boolean {
    return this.state.status === 'ready' && this.llamaClient !== null
  }

  isBusy(): boolean {
    return this.starting
  }

  private setState(patch: Partial<ServerState>): void {
    this.state = { ...this.state, ...patch }
    this.emit('state', this.getState())
  }

  private appendLog(line: string): void {
    this.logs.push(line)
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES)
    this.emit('log', line)
    this.interpretLog(line)
  }

  private interpretLog(line: string): void {
    if (this.state.status !== 'starting' && this.state.status !== 'loading') return

    if (/loaded meta data|llama_model_loader/i.test(line)) {
      this.setProgress(0.25)
      return
    }

    const offload = line.match(/offloaded (\d+)\/(\d+) layers/i)
    if (offload && offload[1] && offload[2]) {
      this.setState({ gpuLayers: Number(offload[1]), totalLayers: Number(offload[2]) })
      this.setProgress(0.6)
      return
    }

    if (/load_tensors|loading tensors/i.test(line)) {
      this.setProgress(0.5)
      return
    }
    if (/warming up|warmup/i.test(line)) {
      this.setProgress(0.85)
      return
    }
    if (/all slots are idle|server is listening|main: server|listening on/i.test(line)) {
      this.setProgress(0.95)
    }
  }

  private setProgress(value: number): void {
    if (this.state.progress !== null && this.state.progress >= value) return
    this.setState({ progress: value })
  }

  private async resolveStartConfig(options: LoadOptions): Promise<StartConfig> {
    const settings = settingsStore.get()
    const models = await modelLibrary.list()
    if (models.length === 0) throw new Error('NO_MODELS')

    const modelId = options.modelId ?? settings.models.activeModelId ?? models[0]?.id ?? null
    const model = models.find((item) => item.id === modelId) ?? models[0]
    if (!model) throw new Error('NO_MODELS')
    if (!existsSync(model.path)) throw new Error('MODEL_MISSING')

    const hardware = await detectHardware()
    const probes = await probeBackends()
    const preferredBackend = options.backend ?? model.backendOverride ?? settings.inference.backend
    const backend: ConcreteBackend = chooseBackend(preferredBackend, probes) ?? 'cpu'

    const resolved = resolveBackend(backend)
    if (!resolved) throw new Error('BACKEND_MISSING')

    const projectorsEnabled = options.mmprojEnabled ?? settings.models.mmprojEnabled
    const mmprojPath = projectorsEnabled ? model.mmprojPath : null
    let mmprojBytes = 0
    if (mmprojPath) {
      try {
        mmprojBytes = statSync(mmprojPath).size
      } catch {
        mmprojBytes = 0
      }
    }

    const base = computeRecommendation({
      model,
      hardware,
      preset: options.perfPreset ?? settings.inference.perfPreset,
      backend,
      vramReserveMb: options.vramReserveMb ?? settings.inference.vramReserveMb,
      mmprojEnabled: projectorsEnabled,
      mmprojBytes
    })

    const { inference } = settings
    const recommendation: RecommendedParams = {
      ...base,
      gpuLayers:
        backend === 'cpu'
          ? 0
          : pickNumber(options.gpuLayers, inference.gpuLayers, base.gpuLayers),
      contextSize: pickNumber(options.contextSize, inference.contextSize, base.contextSize),
      kvCacheType:
        options.kvCacheType && options.kvCacheType !== 'auto'
          ? options.kvCacheType
          : inference.kvCacheType !== 'auto'
            ? inference.kvCacheType
            : base.kvCacheType,
      threads: pickNumber(options.threads, inference.threads, base.threads),
      batchSize: pickNumber(options.batchSize, inference.batchSize, base.batchSize),
      flashAttention: pickBoolean(options.flashAttention, inference.flashAttention, base.flashAttention),
      useMmap: options.useMmap ?? inference.useMmap,
      useMlock: options.useMlock ?? inference.useMlock
    }

    return {
      model,
      recommendation,
      executable: resolved.executable,
      mmprojPath,
      extraArgs: splitArgs(options.extraArgs ?? inference.extraArgs ?? ''),
      alias: model.fileName.replace(/\.gguf$/i, '')
    }
  }

  private spawnServer(config: StartConfig, port: number): void {
    const { recommendation } = config
    const args = buildServerArgs({
      modelPath: config.model.path,
      mmprojPath: config.mmprojPath,
      host: '127.0.0.1',
      port,
      apiKey: this.apiKey,
      alias: config.alias,
      gpuLayers: recommendation.gpuLayers,
      contextSize: recommendation.contextSize,
      kvCacheType: recommendation.kvCacheType,
      threads: recommendation.threads,
      batchSize: recommendation.batchSize,
      ubatchSize: recommendation.ubatchSize,
      flashAttention: recommendation.flashAttention,
      useMmap: recommendation.useMmap,
      useMlock: recommendation.useMlock,
      extraArgs: config.extraArgs
    })

    logger.info('server', `starting llama-server: ${redactArgs(args)}`)

    const child = spawn(config.executable, args, {
      cwd: directoryOf(config.executable),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    })

    this.child = child

    this.setState({
      status: 'loading',
      modelId: config.model.id,
      modelPath: config.model.path,
      modelName: config.model.fileName,
      mmprojPath: config.mmprojPath,
      backend: recommendation.backend,
      port,
      pid: child.pid ?? null,
      contextSize: recommendation.contextSize,
      gpuLayers: recommendation.gpuLayers,
      totalLayers: recommendation.totalLayers,
      kvCacheType: recommendation.kvCacheType,
      startedAt: Date.now(),
      error: null,
      progress: 0.1,
      commandLine: redactArgs(args)
    })

    const forward = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim().length > 0) this.appendLog(line)
      }
    }

    child.stdout?.on('data', forward)
    child.stderr?.on('data', forward)
    child.on('error', (error) => this.appendLog(`[process error] ${error.message}`))

    child.on('exit', (code, signal) => {
      const wasReady = this.state.status === 'ready'
      this.child = null
      this.llamaClient = null
      this.clearIdleTimer()

      if (this.stopRequested) {
        this.stopRequested = false
        this.setState({ status: 'idle', pid: null, progress: null, metrics: null })
        return
      }

      const logTail = this.logs.slice(-40).join('\n')
      this.setState({
        status: 'error',
        pid: null,
        progress: null,
        error: wasReady
          ? `llama-server exited unexpectedly (code ${code ?? 'null'})`
          : `llama-server failed to start (code ${code ?? 'null'}, signal ${signal ?? 'none'})`
      })
      this.emit('crashed', { code, signal, logTail, wasReady })
    })
  }

  private async waitForReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.cancelRequested) return false
      if (!this.child) return false
      const health = await this.llamaClient?.health(1500)
      if (health?.status === 'ok') return true
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS))
    }
    return false
  }

  private computeStartupTimeout(model: ModelInfo): number {
    const gigabytes = model.sizeBytes / (1024 * 1024 * 1024)
    return Math.min(600_000, 60_000 + Math.round(gigabytes * 25_000))
  }

  async load(options: LoadOptions = {}): Promise<ServerState> {
    if (this.starting) throw new Error('SERVER_BUSY')
    this.starting = true
    this.cancelRequested = false

    try {
      if (this.child) await this.stopInternal()

      const config = await this.resolveStartConfig(options)
      this.setState({ status: 'starting', error: null, progress: 0.02 })

      let lastError: string | null = null

      for (let step = 0; step < MAX_ATTEMPTS; step += 1) {
        if (this.cancelRequested) break

        const attempt: StartConfig =
          step === 0
            ? config
            : { ...config, recommendation: degradeRecommendation(config.recommendation, step) }

        if (step > 0) {
          this.appendLog(
            `[lumilm] previous attempt failed, retrying with reduced settings (step ${step}/${MAX_ATTEMPTS - 1})`
          )
        }

        const port = await findFreePort()
        this.apiKey = randomBytes(24).toString('hex')
        this.llamaClient = new LlamaClient(`http://127.0.0.1:${port}`, this.apiKey)

        this.stopRequested = false
        this.spawnServer(attempt, port)

        const ready = await this.waitForReady(this.computeStartupTimeout(config.model))

        if (ready) {
          const props = await this.llamaClient?.props(5000)
          const reportedCtx = extractContextSize(props)

          this.metrics = {
            ttftMs: null,
            tokensPerSecond: null,
            promptTokens: null,
            completionTokens: null,
            contextUsedTokens: null,
            contextSize: reportedCtx ?? attempt.recommendation.contextSize,
            promptPerSecond: null,
            lastUpdated: Date.now()
          }

          this.setState({
            status: 'ready',
            progress: 1,
            error: null,
            degradedRetries: step,
            contextSize: reportedCtx ?? attempt.recommendation.contextSize,
            gpuLayers: attempt.recommendation.gpuLayers,
            totalLayers: attempt.recommendation.totalLayers,
            kvCacheType: attempt.recommendation.kvCacheType,
            supportsTools: extractToolSupport(props)
          })

          modelLibrary.markUsed(config.model.id)
          this.resetIdleTimer()
          logger.info(
            'server',
            `ready on port ${port} (backend=${attempt.recommendation.backend}, ngl=${attempt.recommendation.gpuLayers}, ctx=${attempt.recommendation.contextSize})`
          )
          return this.getState()
        }

        lastError =
          this.state.error ??
          (this.cancelRequested ? 'CANCELLED' : 'llama-server did not become ready in time')
        const tail = this.logs.slice(-80).join('\n')
        const memoryRelated = MEMORY_ERROR_PATTERN.test(tail) || MEMORY_ERROR_PATTERN.test(lastError)

        this.stopRequested = true
        await this.forceKill()
        this.stopRequested = false

        if (this.cancelRequested) break
        if (!memoryRelated || step === MAX_ATTEMPTS - 1) {
          this.setState({ status: 'error', error: lastError, progress: null })
          throw new Error(lastError)
        }
      }

      if (this.cancelRequested) {
        this.setState({ status: 'idle', error: null, progress: null, metrics: null })
        return this.getState()
      }

      this.setState({ status: 'error', error: lastError, progress: null })
      throw new Error(lastError ?? 'FAILED_TO_START')
    } catch (error) {
      const message = toError(error).message
      if (message === 'NO_MODELS' || message === 'MODEL_MISSING' || message === 'BACKEND_MISSING') {
        this.setState({ status: 'idle', error: null, metrics: null })
      } else if (message !== 'SERVER_BUSY') {
        this.setState({ status: 'error', error: message, progress: null })
      }
      throw error
    } finally {
      this.starting = false
    }
  }

  private async forceKill(): Promise<void> {
    const child = this.child
    this.child = null
    this.llamaClient = null

    if (!child || child.pid === undefined) return

    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        resolve()
      }

      const timer = setTimeout(() => {
        void runProcess('taskkill', ['/PID', String(child.pid), '/T', '/F'], 8000).finally(finish)
      }, 2500)

      child.once('exit', () => {
        clearTimeout(timer)
        finish()
      })

      try {
        child.kill()
      } catch {
        clearTimeout(timer)
        void runProcess('taskkill', ['/PID', String(child.pid), '/T', '/F'], 8000).finally(finish)
      }
    })
  }

  private async stopInternal(): Promise<void> {
    this.stopRequested = true
    this.clearIdleTimer()
    this.setState({ status: 'stopping' })
    await this.forceKill()
    this.stopRequested = false
    this.setState({ status: 'idle', pid: null, progress: null, error: null, metrics: null })
  }

  async stop(): Promise<ServerState> {
    if (this.starting) {
      this.cancelRequested = true
      return this.getState()
    }
    if (!this.child) {
      this.setState({ status: 'idle', pid: null, progress: null, error: null, metrics: null })
      return this.getState()
    }
    await this.stopInternal()
    return this.getState()
  }

  /** Called during application shutdown; never rejects. */
  async shutdown(): Promise<void> {
    this.cancelRequested = true
    this.clearIdleTimer()
    this.stopRequested = true
    await this.forceKill().catch(() => undefined)
  }

  async tokenize(text: string): Promise<number> {
    if (!this.llamaClient || !this.isReady()) return 0
    return this.llamaClient.tokenize(text)
  }

  updateMetrics(patch: Partial<RuntimeMetrics>): void {
    this.metrics = { ...this.metrics, ...patch, lastUpdated: Date.now() }
    if (this.state.status === 'ready') this.setState({ metrics: { ...this.metrics } })
    else this.emit('metrics', { ...this.metrics })
  }

  resetMetrics(): void {
    this.metrics = {
      ttftMs: null,
      tokensPerSecond: null,
      promptTokens: null,
      completionTokens: null,
      contextUsedTokens: null,
      contextSize: this.state.contextSize,
      promptPerSecond: null,
      lastUpdated: Date.now()
    }
    if (this.state.status === 'ready') this.setState({ metrics: { ...this.metrics } })
  }

  touchActivity(): void {
    this.resetIdleTimer()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer()
    const minutes = settingsStore.get().inference.idleUnloadMinutes
    if (!minutes || minutes <= 0) return
    this.idleTimer = setTimeout(() => {
      logger.info('server', `unloading idle model after ${minutes} minute(s)`)
      void this.stop()
    }, minutes * 60_000)
  }

  async describeFitness(modelId: string): Promise<{ vramBytes: number; fits: boolean } | null> {
    const model = await modelLibrary.get(modelId)
    if (!model) return null
    const hardware = await detectHardware()
    const vramBytes = primaryVramBytes(hardware)
    return { vramBytes, fits: vramBytes >= model.sizeBytes }
  }
}

export const serverManager = new ServerManager()
