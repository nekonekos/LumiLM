#!/usr/bin/env node
/**
 * Downloads the prebuilt llama.cpp server binaries that LumiLM ships with.
 *
 * Three Windows x64 backends are fetched so the application can pick the best
 * one at runtime: CPU (always works), Vulkan (AMD/Intel/NVIDIA) and CUDA
 * (NVIDIA, including the cuBLAS runtime DLLs).
 *
 * GitHub's REST API is rate limited for anonymous callers, so the release and
 * asset listings are scraped from the public HTML endpoints instead.
 *
 * Usage:
 *   node scripts/fetch-llama-backends.mjs [--force] [--backends=cpu,vulkan,cuda]
 *                                         [--keep-archives]
 *
 * Environment:
 *   LLAMA_TAG     pin a specific llama.cpp build tag (for example b11390)
 *   LLAMA_CUDA    CUDA variant to prefer: 12.4 (default, widest driver support) or 13.4
 *   LLAMA_PROXY   HTTP proxy for all requests, e.g. http://127.0.0.1:7897
 *                 (falls back to HTTPS_PROXY / HTTP_PROXY when unset)
 */
import { execFileSync, spawn } from 'node:child_process'
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { request as httpRequest } from 'node:http'
import { get as httpsGet, request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LLAMA_ROOT = join(ROOT, 'resources', 'llama')
const DOWNLOAD_DIR = join(LLAMA_ROOT, '_downloads')
const REPO = 'ggml-org/llama.cpp'
const CUDA_VARIANT = process.env.LLAMA_CUDA ?? '12.4'
const REQUEST_TIMEOUT_MS = 30_000

const TARGETS = [
  { dir: 'cpu', patterns: [/^llama-.*-bin-win-cpu-x64\.zip$/i] },
  { dir: 'vulkan', patterns: [/^llama-.*-bin-win-vulkan-x64\.zip$/i] },
  {
    dir: 'cuda',
    patterns: [
      new RegExp(`^llama-.*-bin-win-cuda-${CUDA_VARIANT.replace('.', '\\.')}-x64\\.zip$`, 'i'),
      /^llama-.*-bin-win-cuda-12\.4-x64\.zip$/i,
      /^llama-.*-bin-win-cuda-x64\.zip$/i,
      /^llama-.*-bin-win-cuda-13[^/]*-x64\.zip$/i
    ],
    extra: [
      {
        label: 'cudart',
        patterns: [
          new RegExp(`^cudart-llama-bin-win-cuda-${CUDA_VARIANT.replace('.', '\\.')}-x64\\.zip$`, 'i'),
          /^cudart-llama-bin-win-cuda-12\.4-x64\.zip$/i,
          /^cudart-llama-bin-win-cuda-x64\.zip$/i,
          /^cudart-llama-bin-win-cuda-13[^/]*-x64\.zip$/i
        ],
        copy: /\.dll$/i
      }
    ]
  }
]

const args = process.argv.slice(2)
const force = args.includes('--force')
const keepArchives = args.includes('--keep-archives')
const backendsArg = args.find((arg) => arg.startsWith('--backends='))
const selected = backendsArg
  ? new Set(
      backendsArg
        .split('=')[1]
        .split(',')
        .map((value) => value.trim().toLowerCase())
    )
  : new Set(TARGETS.map((target) => target.dir))

const USER_AGENT = 'LumiLM-build (+https://github.com/nekonekos/LumiLM)'

/**
 * Optional HTTP(S) proxy support. Node's `https` module ignores the usual
 * proxy environment variables, so an explicit CONNECT tunnel is established
 * when one is configured.
 */
const PROXY_URL =
  process.env.LLAMA_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? null

/**
 * `curl` is considerably faster than Node's `https` client on many networks
 * (it negotiates HTTP/2 and honours the proxy environment) so it is preferred
 * whenever it is available. Node's own client remains the fallback.
 */
const curlAvailable = (() => {
  if (process.env.LLAMA_NO_CURL === '1') return false
  try {
    execFileSync('curl', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** Runs curl with the given arguments and resolves with its stdout. */
function runCurl(args) {
  return new Promise((resolve, reject) => {
    const full = ['--silent', '--show-error', '--location', '--fail', ...args]
    if (PROXY_URL) full.splice(1, 0, '--proxy', PROXY_URL)

    const child = spawn('curl', full, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `curl exited with code ${code}`))
    })
  })
}

/** Opens a raw tunnel socket to `target` through the configured proxy, if any. */
function proxyTunnel(target) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(PROXY_URL)
    const port = Number(target.port) || 443
    const connectRequest = httpRequest({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers: {
        host: `${target.hostname}:${port}`,
        ...(proxy.username
          ? {
              'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`
            }
          : {})
      }
    })

    connectRequest.setTimeout(REQUEST_TIMEOUT_MS, () => {
      connectRequest.destroy(new Error(`proxy connect timed out: ${PROXY_URL}`))
    })
    connectRequest.on('error', reject)
    connectRequest.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`proxy CONNECT failed with HTTP ${response.statusCode}`))
        return
      }
      resolve(socket)
    })
    connectRequest.end()
  })
}

/**
 * `https.get` replacement that honours {@link PROXY_URL}.
 *
 * When a proxy is configured the underlying request only exists once the
 * CONNECT tunnel is up, so `setTimeout`, `on('error')` and `destroy` are
 * buffered and replayed onto it.
 */
function httpGet(url, options, callback) {
  if (!PROXY_URL) return httpsGet(url, options, callback)

  const target = new URL(url)
  let real = null
  let failure = null
  let timer = null
  const handlers = []

  const shim = {
  on(event, handler) {
    if (event === 'error') handlers.push(handler)
    if (real) real.on(event, handler)
    return shim
  },
  setTimeout(ms, onTimeout) {
    timer = setTimeout(() => {
      shim.destroy(new Error(`request timed out after ${ms} ms: ${url}`))
      onTimeout?.()
    }, ms)
    return shim
  },
  destroy(error) {
    if (timer) clearTimeout(timer)
    if (real) real.destroy(error)
    else if (error) fail(error)
    return shim
  }
  }

  function fail(error) {
  if (timer) clearTimeout(timer)
  if (failure) return
  failure = error
  for (const handler of handlers) handler(error)
  }

  proxyTunnel(target)
  .then((socket) => {
    if (failure) {
      socket.destroy()
      return
    }
    real = httpsRequest(
      {
        host: target.hostname,
        port: Number(target.port) || 443,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: options?.headers,
        agent: false,
        // `https.request` does not wrap a caller supplied socket in TLS, so the
        // tunneled socket is upgraded here before the request is written.
        createConnection: () =>
          tlsConnect({ socket, servername: target.hostname, ALPNProtocols: ['http/1.1'] })
      },
      (response) => {
        if (timer) clearTimeout(timer)
        callback(response)
      }
    )
    real.on('error', fail)
  })
  .catch(fail)

  return shim
}

function log(message) {
  process.stdout.write(`[fetch-llama] ${message}\n`)
}

async function fetchText(url, redirects = 0) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (curlAvailable) return await runCurl(['--user-agent', USER_AGENT, url])
      return await fetchTextWithNode(url, redirects)
    } catch (error) {
      lastError = error
      log(`  retrying ${url} (${attempt}/3): ${error.message}`)
      await new Promise((resolve) => setTimeout(resolve, 800 * attempt))
    }
  }
  throw lastError
}

function fetchTextWithNode(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error(`too many redirects for ${url}`))
      return
    }

    const request = httpGet(url, { headers: { 'User-Agent': USER_AGENT } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume()
        resolve(fetchTextWithNode(new URL(response.headers.location, url).toString(), redirects + 1))
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`HTTP ${response.statusCode} for ${url}`))
        return
      }

      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => resolve(body))
    })

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`request timed out after ${REQUEST_TIMEOUT_MS} ms: ${url}`))
    })
    request.on('error', reject)
  })
}

/**
 * Some networks throttle direct GitHub release-asset downloads to a crawl, so
 * mirrors can be supplied (in priority order). A download that is slower than
 * {@link MIN_SPEED_BYTES_PER_SECOND} after the warm-up window is abandoned and
 * the next source is tried.
 */
const MIRROR_PREFIXES = (
  process.env.LLAMA_MIRROR
    ? [process.env.LLAMA_MIRROR]
    : ['https://gh-proxy.com/', 'https://ghfast.top/', 'https://ghproxy.net/']
).map((prefix) => (prefix.endsWith('/') ? prefix : `${prefix}/`))

const MIN_SPEED_BYTES_PER_SECOND = 250_000
const SPEED_SAMPLE_MS = 12_000
const STALL_TIMEOUT_MS = 30_000

function candidatesFor(url) {
  return [
    { label: 'github', url },
    ...MIRROR_PREFIXES.map((prefix) => ({ label: prefix, url: `${prefix}${url}` }))
  ]
}

/**
 * Downloads `url` to `destination`, preferring curl. A source that stays below
 * `minSpeed` for the sample window is abandoned so another source can be tried.
 */
function downloadWithCurl(url, destination, options) {
  const args = [
    '--user-agent',
    USER_AGENT,
    '--connect-timeout',
    '30',
    '--speed-limit',
    String(options.minSpeed ?? MIN_SPEED_BYTES_PER_SECOND),
    '--speed-time',
    String(Math.round((options.sampleMs ?? SPEED_SAMPLE_MS) / 1000)),
    '--output',
    destination,
    '--write-out',
    '%{http_code} %{size_download} %{speed_download}',
    url
  ]

  return runCurl(args).then((stdout) => {
    const [httpCode, size, speed] = stdout.trim().split(/\s+/)
    if (httpCode !== '200') throw new Error(`download failed with HTTP ${httpCode} for ${url}`)
    log(
      `  done: ${(Number(size) / 1024 / 1024).toFixed(0)} MB at ${(Number(speed) / 1024).toFixed(0)} KB/s`
    )
  })
}

function download(url, destination, options = {}) {
  if (typeof url !== 'string') throw new Error(`invalid download url: ${String(url)}`)
  if (curlAvailable) return downloadWithCurl(url, destination, options)
  return downloadWithNode(url, destination, options)
}

function downloadWithNode(url, destination, options = {}) {
  if (typeof url !== 'string') throw new Error(`invalid download url: ${String(url)}`)

  const minSpeed = options.minSpeed ?? 0
  const sampleMs = options.sampleMs ?? SPEED_SAMPLE_MS
  const startedAt = Date.now()

  return new Promise((resolve, reject) => {
    const request = httpGet(url, { headers: { 'User-Agent': USER_AGENT } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume()
        resolve(download(new URL(response.headers.location, url).toString(), destination, options))
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`download failed with HTTP ${response.statusCode} for ${url}`))
        return
      }

      const total = Number(response.headers['content-length'] ?? 0)
      let received = 0
      let nextLogAt = 0

      response.on('data', (chunk) => {
        received += chunk.length

        const mb = received / (1024 * 1024)
        if (mb >= nextLogAt) {
          nextLogAt = mb + 25
          const totalMb = total > 0 ? ` / ${(total / (1024 * 1024)).toFixed(0)}` : ''
          const speed = received / Math.max(1, (Date.now() - startedAt) / 1000)
          log(`  ${mb.toFixed(0)}${totalMb} MB (${(speed / 1024).toFixed(0)} KB/s)`)
        }

        if (minSpeed > 0) {
          const elapsed = Date.now() - startedAt
          if (elapsed > sampleMs && received / (elapsed / 1000) < minSpeed) {
            response.destroy(
              new Error(
                `source too slow (${(received / (elapsed / 1000) / 1024).toFixed(0)} KB/s): ${url}`
              )
            )
          }
        }
      })

      pipeline(response, createWriteStream(destination)).then(resolve, reject)
    })

    request.setTimeout(STALL_TIMEOUT_MS, () => {
      request.destroy(new Error(`download stalled: ${url}`))
    })
    request.on('error', reject)
  })
}

/** Verifies a downloaded archive is a complete zip (not a truncated download). */
function isValidZip(filePath) {
  try {
    const size = statSync(filePath).size
    if (size < 22) return false

    const fd = openSync(filePath, 'r')
    try {
      const head = Buffer.alloc(4)
      readSync(fd, head, 0, 4, 0)
      if (head[0] !== 0x50 || head[1] !== 0x4b || head[2] !== 0x03 || head[3] !== 0x04) return false

      const tailLength = Math.min(size, 66_000)
      const tail = Buffer.alloc(tailLength)
      readSync(fd, tail, 0, tailLength, size - tailLength)
      return tail.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

/** Downloads an archive from GitHub (with mirror fallback) until it is a complete zip. */
async function ensureArchive(url, assetName) {
  const zipPath = join(DOWNLOAD_DIR, assetName)

  if (isValidZip(zipPath)) {
    log(`reusing cached ${assetName}`)
    return zipPath
  }

  const candidates = candidatesFor(url)

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    for (const candidate of candidates) {
      rmSync(zipPath, { force: true })
      const label = candidate.label === 'github' ? 'github' : `mirror ${candidate.label}`
      log(`downloading ${assetName} via ${label}${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
      try {
        await download(candidate.url, zipPath, { minSpeed: MIN_SPEED_BYTES_PER_SECOND })
        if (isValidZip(zipPath)) return zipPath
        log('  archive looks incomplete, trying another source')
      } catch (error) {
        log(`  failed: ${error.message}`)
      }
    }
  }

  rmSync(zipPath, { force: true })
  throw new Error(`could not download a complete archive for ${assetName}`)
}

function extractZip(zipPath, destination) {
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })

  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}', '${destination.replace(/'/g, "''")}')`
    ].join('; ')
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'inherit'
    })
  } else {
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', destination], { stdio: 'inherit' })
  }
}

/** Moves the contents of a single nested directory up one level, repeatedly. */
function flattenDirectory(directory) {
  for (let pass = 0; pass < 4; pass += 1) {
    const entries = readdirSync(directory, { withFileTypes: true })
    const files = entries.filter((entry) => entry.isFile())
    const dirs = entries.filter((entry) => entry.isDirectory())
    if (files.length > 0 || dirs.length !== 1) return

    const nested = join(directory, dirs[0].name)
    for (const entry of readdirSync(nested)) {
      renameSync(join(nested, entry), join(directory, entry))
    }
    rmSync(nested, { recursive: true, force: true })
  }
}

function copyMatching(sourceDir, destinationDir, pattern) {
  mkdirSync(destinationDir, { recursive: true })
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const from = join(sourceDir, entry.name)
    if (entry.isDirectory()) {
      copyMatching(from, join(destinationDir, entry.name), pattern)
    } else if (pattern.test(entry.name)) {
      const to = join(destinationDir, entry.name)
      rmSync(to, { force: true })
      renameSync(from, to)
    }
  }
}

function pickAsset(names, patterns) {
  for (const pattern of patterns) {
    const found = names.find((name) => pattern.test(name))
    if (found) return found
  }
  return null
}

async function listReleaseTags() {
  const atom = await fetchText(`https://github.com/${REPO}/releases.atom`)
  const tags = []
  for (const match of atom.matchAll(/Repository\/\d+\/([^<]+)</g)) {
    const tag = match[1]
    if (tag && !tags.includes(tag)) tags.push(tag)
  }
  return tags
}

async function listAssets(tag) {
  const html = await fetchText(`https://github.com/${REPO}/releases/expanded_assets/${tag}`)
  const names = []
  for (const match of html.matchAll(/releases\/download\/[^/]+\/([^"]+)"/g)) {
    const name = decodeURIComponent(match[1])
    if (!names.includes(name)) names.push(name)
  }
  return names
}

async function resolveRelease() {
  const pinned = process.env.LLAMA_TAG
  if (pinned) {
    log(`using pinned llama.cpp build ${pinned}`)
    return { tag: pinned, assets: await listAssets(pinned) }
  }

  const tags = await listReleaseTags()
  if (tags.length === 0) throw new Error('could not list llama.cpp releases')

  for (const tag of tags.slice(0, 12)) {
    const assets = await listAssets(tag)
    if (assets.some((name) => /^llama-.*-bin-win-cpu-x64\.zip$/i.test(name))) {
      return { tag, assets }
    }
  }
  throw new Error('no llama.cpp release with Windows binaries found')
}

async function main() {
  mkdirSync(DOWNLOAD_DIR, { recursive: true })

  const { tag, assets } = await resolveRelease()
  log(`llama.cpp build: ${tag} (${assets.length} assets)`) 

  const manifest = {
    version: tag,
    cudaVariant: CUDA_VARIANT,
    fetchedAt: new Date().toISOString(),
    source: `https://github.com/${REPO}`,
    backends: []
  }

  for (const target of TARGETS) {
    if (!selected.has(target.dir)) continue

    const destination = join(LLAMA_ROOT, target.dir)
    const mainAsset = pickAsset(assets, target.patterns)

    if (!mainAsset) {
      log(`!! no asset for backend "${target.dir}" in build ${tag}`)
      continue
    }

    if (existsSync(join(destination, 'llama-server.exe')) && !force) {
      log(`backend "${target.dir}" already present, skipping (use --force to refresh)`)
      manifest.backends.push({ backend: target.dir, asset: mainAsset, skipped: true })
      continue
    }

    const url = (name) => `https://github.com/${REPO}/releases/download/${tag}/${name}`
    const zipPath = await ensureArchive(url(mainAsset), mainAsset)

    log(`extracting ${mainAsset} -> resources/llama/${target.dir}`)
    extractZip(zipPath, destination)
    flattenDirectory(destination)

    for (const extra of target.extra ?? []) {
      const extraAsset = pickAsset(assets, extra.patterns)
      if (!extraAsset) {
        log(`!! no ${extra.label} asset for backend "${target.dir}"`)
        continue
      }

      const extraZip = await ensureArchive(url(extraAsset), extraAsset)

      const staging = join(DOWNLOAD_DIR, `_stage_${extra.label}_${target.dir}`)
      log(`extracting ${extraAsset}`)
      extractZip(extraZip, staging)
      flattenDirectory(staging)
      copyMatching(staging, destination, extra.copy)
      rmSync(staging, { recursive: true, force: true })
    }

    manifest.backends.push({ backend: target.dir, asset: mainAsset, skipped: false })
    log(`backend "${target.dir}" ready`)
  }

  writeFileSync(join(LLAMA_ROOT, 'VERSION.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  log('wrote resources/llama/VERSION.json')

  for (const target of TARGETS) {
    if (!selected.has(target.dir)) continue
    const present = existsSync(join(LLAMA_ROOT, target.dir, 'llama-server.exe'))
    if (!present) log(`WARNING: backend "${target.dir}" does not contain llama-server.exe`)
  }

  if (!keepArchives) {
    rmSync(DOWNLOAD_DIR, { recursive: true, force: true })
    log('removed downloaded archives (use --keep-archives to keep them)')
  }
}

main().catch((error) => {
  console.error(`[fetch-llama] failed: ${error.message}`)
  process.exitCode = 1
})
