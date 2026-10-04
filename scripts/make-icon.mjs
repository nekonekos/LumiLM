#!/usr/bin/env node
/**
 * Generates the LumiLM application icon without any image dependency.
 *
 * The mark is drawn procedurally with signed distance fields (light blue
 * gradient tile plus a white chat bubble) and encoded as PNG, then wrapped into
 * a multi resolution Windows .ico container.
 *
 * Usage: node scripts/make-icon.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_DIR = join(ROOT, 'build')

const GRADIENT_TOP = [0x8f, 0xd0, 0xff]
const GRADIENT_BOTTOM = [0x2b, 0x6c, 0xe8]
const DOT_COLOR = [0x2b, 0x6c, 0xe8]

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

function lerp(a, b, t) {
  return a + (b - a) * t
}

function mix(top, bottom, t) {
  return [lerp(top[0], bottom[0], t), lerp(top[1], bottom[1], t), lerp(top[2], bottom[2], t)]
}

function roundedRectSDF(px, py, cx, cy, hw, hh, radius) {
  const qx = Math.abs(px - cx) - (hw - radius)
  const qy = Math.abs(py - cy) - (hh - radius)
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius
}

/** Signed distance to a convex polygon (points must be given in order). */
function polygonSDF(px, py, points, radius) {
  const cx = points.reduce((sum, point) => sum + point[0], 0) / points.length
  const cy = points.reduce((sum, point) => sum + point[1], 0) / points.length
  let distance = -Infinity

  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    const ex = b[0] - a[0]
    const ey = b[1] - a[1]
    const length = Math.hypot(ex, ey) || 1
    let nx = ey / length
    let ny = -ex / length
    if ((a[0] - cx) * nx + (a[1] - cy) * ny < 0) {
      nx = -nx
      ny = -ny
    }
    distance = Math.max(distance, (px - a[0]) * nx + (py - a[1]) * ny)
  }

  return distance - radius
}

const TAIL_POINTS = [
  [0.315, 0.6],
  [0.47, 0.62],
  [0.35, 0.86]
]

/**
 * Returns the straight (non premultiplied) colour and coverage of a sample in
 * normalised [0,1] coordinates.
 */
function shade(x, y, withDots) {
  const background = roundedRectSDF(x, y, 0.5, 0.5, 0.5, 0.5, 0.225)
  if (background > 0) return null

  const bubble = Math.min(
    roundedRectSDF(x, y, 0.5, 0.455, 0.3, 0.235, 0.105),
    polygonSDF(x, y, TAIL_POINTS, 0.035)
  )

  if (bubble <= 0) {
    if (withDots) {
      for (const dotX of [0.385, 0.5, 0.615]) {
        if (Math.hypot(x - dotX, y - 0.455) <= 0.036) {
          return { color: DOT_COLOR, alpha: 1 }
        }
      }
    }
    return { color: [255, 255, 255], alpha: 1 }
  }

  const t = Math.min(1, Math.max(0, (x + y) * 0.5))
  return { color: mix(GRADIENT_TOP, GRADIENT_BOTTOM, t), alpha: 1 }
}

function renderRGBA(size) {
  const samples = 4
  const rgba = Buffer.alloc(size * size * 4)
  const withDots = size >= 32

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = (x + (sx + 0.5) / samples) / size
          const py = (y + (sy + 0.5) / samples) / size
          const sample = shade(px, py, withDots)
          if (!sample) continue
          r += sample.color[0] * sample.alpha
          g += sample.color[1] * sample.alpha
          b += sample.color[2] * sample.alpha
          a += sample.alpha
        }
      }

      const total = samples * samples
      const alpha = a / total
      const index = (y * size + x) * 4
      rgba[index] = alpha > 0 ? Math.round(r / a) : 0
      rgba[index + 1] = alpha > 0 ? Math.round(g / a) : 0
      rgba[index + 2] = alpha > 0 ? Math.round(b / a) : 0
      rgba[index + 3] = Math.round(alpha * 255)
    }
  }

  return rgba
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff]
  }
  return (crc ^ -1) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // icon
  header.writeUInt16LE(images.length, 4)

  const entries = Buffer.alloc(16 * images.length)
  let offset = 6 + 16 * images.length

  images.forEach((image, index) => {
    const base = index * 16
    const dimension = image.size >= 256 ? 0 : image.size
    entries.writeUInt8(dimension, base)
    entries.writeUInt8(dimension, base + 1)
    entries.writeUInt8(0, base + 2)
    entries.writeUInt8(0, base + 3)
    entries.writeUInt16LE(1, base + 4)
    entries.writeUInt16LE(32, base + 6)
    entries.writeUInt32LE(image.png.length, base + 8)
    entries.writeUInt32LE(offset, base + 12)
    offset += image.png.length
  })

  return Buffer.concat([header, entries, ...images.map((image) => image.png)])
}

mkdirSync(BUILD_DIR, { recursive: true })

const images = ICO_SIZES.map((size) => ({ size, png: encodePng(size, renderRGBA(size)) }))
writeFileSync(join(BUILD_DIR, 'icon.ico'), encodeIco(images))

const large = images.find((image) => image.size === 256)
if (large) writeFileSync(join(BUILD_DIR, 'icon.png'), large.png)

console.log(`[make-icon] wrote build/icon.ico (${ICO_SIZES.join(', ')}) and build/icon.png`)
