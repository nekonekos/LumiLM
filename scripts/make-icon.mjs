#!/usr/bin/env node
/**
 * Turns the LumiLM artwork into every icon the app needs.
 *
 * `build/icons/<theme>/<size>.png` is the single source of truth (the theme
 * folders hold the light and the dark variants of the same mark). From those
 * files this script derives:
 *
 *   build/icon.ico         multi resolution Windows icon baked into LumiLM.exe
 *   build/icon.png         256px light mark, used by electron-builder for Linux
 *   src/shared/app-icons.ts inlined data URLs so that both the main process
 *                          (window/taskbar icon) and the renderer (in-app logo
 *                          and favicon) can switch between themes without
 *                          touching the file system or the CSP
 *
 * The generated files are committed so a checkout always has them, but this
 * script is the only place that writes them. Run it after replacing the
 * artwork: `npm run icon` (also wired to `npm run build`).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_DIR = join(ROOT, 'build')
const SOURCE_DIR = join(BUILD_DIR, 'icons')
const SHARED_OUT = join(ROOT, 'src', 'shared', 'app-icons.ts')

/** Icons embedded in LumiLM.exe, smallest first. */
const ICO_SIZES = [16, 32, 64, 128, 256]
/** The mark inlined into the bundles; 256px is what Windows scales for the taskbar. */
const INLINE_SIZE = 256

const THEMES = ['light', 'dark']

function readPng(file) {
  const buffer = readFileSync(file)
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buffer.subarray(0, 8).equals(signature)) {
    throw new Error(`${file} is not a PNG file`)
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error(`${file} is missing its IHDR chunk`)
  }
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (width !== height) {
    throw new Error(`${file} must be square (found ${width}x${height})`)
  }
  return { buffer, size: width }
}

/**
 * Wraps already encoded PNGs into an ICO container. Windows Vista and newer
 * accept PNG compressed entries directly, which keeps the file small.
 */
function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // resource type: icon
  header.writeUInt16LE(images.length, 4)

  const entries = Buffer.alloc(16 * images.length)
  let offset = header.length + entries.length

  images.forEach((image, index) => {
    const base = index * 16
    // 256 is stored as 0 in the single byte width/height fields.
    const dimension = image.size >= 256 ? 0 : image.size
    entries.writeUInt8(dimension, base)
    entries.writeUInt8(dimension, base + 1)
    entries.writeUInt8(0, base + 2) // palette size
    entries.writeUInt8(0, base + 3) // reserved
    entries.writeUInt16LE(1, base + 4) // colour planes
    entries.writeUInt16LE(32, base + 6) // bits per pixel
    entries.writeUInt32LE(image.png.length, base + 8)
    entries.writeUInt32LE(offset, base + 12)
    offset += image.png.length
  })

  return Buffer.concat([header, entries, ...images.map((image) => image.png)])
}

function loadTheme(theme) {
  const directory = join(SOURCE_DIR, theme)
  if (!existsSync(directory)) {
    throw new Error(`missing artwork directory: ${directory}`)
  }

  const found = new Map(
    readdirSync(directory)
      .filter((name) => /^\d+\.png$/.test(name))
      .map((name) => [Number.parseInt(name, 10), join(directory, name)])
  )

  const missing = ICO_SIZES.filter((size) => !found.has(size))
  if (missing.length > 0) {
    throw new Error(`missing ${theme} icon sizes: ${missing.join(', ')}px`)
  }

  return ICO_SIZES.map((size) => {
    const file = found.get(size)
    const { buffer, size: actual } = readPng(file)
    if (actual !== size) {
      throw new Error(`${file} is ${actual}px but should be ${size}px`)
    }
    return { size, png: buffer }
  })
}

function writeInlinedIcons(sets) {
  const entries = THEMES.map((theme) => {
    const image = sets[theme].find((candidate) => candidate.size === INLINE_SIZE)
    if (!image) throw new Error(`no ${INLINE_SIZE}px artwork for the ${theme} theme`)
    const dataUrl = `data:image/png;base64,${image.png.toString('base64')}`
    return `  ${theme}: '${dataUrl}'`
  }).join(',\n')

  const source = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Produced by \`scripts/make-icon.mjs\` (\`npm run icon\`) from the artwork in
 * \`build/icons/{light,dark}/\`. LumiLM ships two versions of the mark so the
 * window icon, the in-app logo and the favicon can follow the active theme.
 * The images are inlined as data URLs so the main process needs no file system
 * path (which would break inside the asar archive) and the renderer satisfies
 * its \`img-src 'self' data:\` content security policy.
 */
export type AppIconTheme = 'light' | 'dark'

export const APP_ICONS: Record<AppIconTheme, string> = {
${entries}
}
`
  mkdirSync(dirname(SHARED_OUT), { recursive: true })
  writeFileSync(SHARED_OUT, source, 'utf8')
}

const sets = Object.fromEntries(THEMES.map((theme) => [theme, loadTheme(theme)]))

mkdirSync(BUILD_DIR, { recursive: true })

// The packaged executable always carries the light mark; the themed variants
// are applied at runtime through the window icon.
writeFileSync(join(BUILD_DIR, 'icon.ico'), encodeIco(sets.light))
const lightLarge = sets.light.find((image) => image.size === INLINE_SIZE)
if (lightLarge) writeFileSync(join(BUILD_DIR, 'icon.png'), lightLarge.png)

writeInlinedIcons(sets)

console.log(
  `[make-icon] build/icon.ico (${ICO_SIZES.join(', ')}px), build/icon.png and src/shared/app-icons.ts (light + dark ${INLINE_SIZE}px)`
)
