#!/usr/bin/env node
/**
 * Builds the Windows portable zip and publishes it as a GitHub release.
 *
 *   node scripts/release.mjs [--version 0.1.0] [--notes "…"] [--dry-run] [--skip-build]
 *
 * The llama.cpp binaries are not stored in git, so they are fetched on demand
 * (unless they are already present in resources/llama).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE_DIR = join(ROOT, 'release')
const LLAMA_ROOT = join(ROOT, 'resources', 'llama')
const BACKENDS = ['cpu', 'vulkan', 'cuda']

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const skipBuild = args.includes('--skip-build')
const versionArg = args.find((a) => a.startsWith('--version='))?.split('=')[1]
const notesArg = args.find((a) => a.startsWith('--notes='))?.split('=')[1]

function log(message) {
  process.stdout.write(`[release] ${message}\n`)
}

function run(command, commandArgs, options = {}) {
  log(`${command} ${commandArgs.join(' ')}`)
  return execFileSync(command, commandArgs, { stdio: 'inherit', cwd: ROOT, ...options })
}

function pkg() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function formatBytes(bytes) {
  let value = bytes
  const units = ['B', 'KB', 'MB', 'GB']
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function backendStatus() {
  return BACKENDS.map((backend) => ({
    backend,
    present: existsSync(join(LLAMA_ROOT, backend, 'llama-server.exe'))
  }))
}

function ensureBackends() {
  const missing = backendStatus().filter((entry) => !entry.present)
  if (missing.length === 0) {
    log('all llama.cpp backends present')
    return
  }

  log(`missing backends: ${missing.map((entry) => entry.backend).join(', ')}`)
  log('downloading llama.cpp backends (this needs network access)…')
  run(process.execPath, [join(ROOT, 'scripts', 'fetch-llama-backends.mjs')])

  const stillMissing = backendStatus().filter((entry) => !entry.present)
  if (stillMissing.length > 0) {
    throw new Error(`backends still missing after download: ${stillMissing.map((e) => e.backend).join(', ')}`)
  }
}

function findArtifact(version) {
  if (!existsSync(RELEASE_DIR)) return null
  // Only look at builds of the version being released: a stale zip from an
  // earlier version would otherwise be picked up and uploaded.
  const prefix = `LumiLM-${version}-`
  const match = readdirSync(RELEASE_DIR).find(
    (name) => name.startsWith(prefix) && /-portable\.zip$/i.test(name)
  )
  return match ? join(RELEASE_DIR, match) : null
}

const { version: packageVersion, repository } = pkg()
const version = versionArg ?? packageVersion
const tag = version.startsWith('v') ? version : `v${version}`

log(`repository: ${repository.url}`)
log(`version:    ${version} (tag ${tag})`)

ensureBackends()

if (!skipBuild) {
  log('building renderer, main and preload bundles')
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'])
  log('packaging the portable zip (this takes a while: the payload is several GB)')
  run(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
    'electron-builder',
    '--win',
    'zip',
    '--config',
    'electron-builder.yml'
  ])
}

const artifact = findArtifact(version)
if (!artifact) throw new Error(`no ${tag} portable zip found in ${RELEASE_DIR}`)

const stats = statSync(artifact)
const hash = sha256(artifact)
const checksumFile = `${artifact}.sha256`
writeFileSync(checksumFile, `${hash}  ${artifact.split(/[\\/]/).pop()}\n`, 'utf8')

log(`artifact: ${artifact}`)
log(`size:     ${formatBytes(stats.size)}`)
log(`sha256:   ${hash}`)

if (dryRun) {
  log('--dry-run set, stopping before the GitHub release')
  process.exit(0)
}

const notes = notesArg ?? `LumiLM ${tag} — Windows x64 portable build.`

const releaseArgs = [
  'release',
  'create',
  tag,
  artifact,
  checksumFile,
  '--title',
  `LumiLM ${tag}`,
  '--notes',
  `${notes}

### Windows x64 portable

1. Extract \`${artifact.split(/[\\/]/).pop()}\` anywhere.
2. Run \`LumiLM.exe\`.
3. Point LumiLM at a local \`.gguf\` model — no model files are bundled.

SHA-256: \`${hash}\``
]

log('creating the GitHub release')
run('gh', releaseArgs)
log(`done: https://github.com/${repository.url.replace(/^https:\/\/github\.com\/|\.git$/g, '')}/releases/tag/${tag}`)
