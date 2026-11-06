/**
 * Deterministic icon generator: renders the dsh launcher icons (a terminal
 * "dsh_" glyph over a navy gradient) pixel-by-pixel and writes them as PNGs
 * with no image dependencies — zlib comes from node:zlib. Rerunning produces
 * byte-identical files; the generated PNGs under ../assets are committed.
 *
 * Usage: node scripts/gen-icons.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')

// ── PNG encoding ────────────────────────────────────────────────────────────

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** Encode one RGBA pixel buffer (row-major, 4 bytes per pixel) as a PNG. */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── the icon design ─────────────────────────────────────────────────────────

// 5x7 glyph bitmaps plus a half-height terminal cursor block.
const GLYPHS = {
  d: ['00001', '00001', '01111', '10001', '10001', '10001', '01111'],
  s: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  h: ['10000', '10000', '10111', '11001', '10001', '10001', '10001'],
  cursor: ['000', '000', '000', '111', '111', '111', '111'],
}
const TEXT = ['d', 's', 'h', 'cursor']
const TEXT_COLUMNS = TEXT.reduce((total, key) => total + GLYPHS[key][0].length, 0) + (TEXT.length - 1)

const BG_TOP = [0x11, 0x1a, 0x33]
const BG_BOTTOM = [0x0b, 0x10, 0x1f]
const GLOW = [0x1d, 0x47, 0x8f]
const INK = [0xf2, 0xf6, 0xff]
const ACCENT = [0x3b, 0xc8, 0xff]

const lerp = (a, b, t) => a + (b - a) * t

/**
 * Render one icon.
 * @param size - output pixel size.
 * @param rounded - transparent rounded corners (launcher "any" icons) vs
 * full-bleed square (maskable and apple-touch icons).
 */
function render(size, rounded) {
  const rgba = Buffer.alloc(size * size * 4)
  const radius = size * 0.223
  // Maskable icons are cropped to a centered circle by the OS: keep the
  // glyphs inside the 80% safe zone. Rounded icons carry their own margin.
  const glyphSpan = rounded ? 0.6 : 0.52
  const cell = Math.max(1, Math.floor((size * glyphSpan) / TEXT_COLUMNS))
  const textWidth = cell * TEXT_COLUMNS
  const textHeight = cell * 7
  const textLeft = Math.floor((size - textWidth) / 2)
  const textTop = Math.floor((size - textHeight) / 2)

  // Column offset of each glyph, in cells.
  const offsets = []
  let column = 0
  for (const key of TEXT) {
    offsets.push(column)
    column += GLYPHS[key][0].length + 1
  }

  const glyphAt = (x, y) => {
    const gx = Math.floor((x - textLeft) / cell)
    const gy = Math.floor((y - textTop) / cell)
    if (gy < 0 || gy >= 7 || gx < 0 || gx >= TEXT_COLUMNS) return undefined
    for (let i = 0; i < TEXT.length; i++) {
      const glyph = GLYPHS[TEXT[i]]
      const local = gx - offsets[i]
      if (local >= 0 && local < glyph[0].length && glyph[gy][local] === '1') {
        return TEXT[i] === 'cursor' ? ACCENT : INK
      }
    }
    return undefined
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = (y * size + x) * 4
      // Rounded-corner alpha (2px anti-alias band).
      let alpha = 255
      if (rounded) {
        const cx = Math.min(Math.max(x + 0.5, radius), size - radius)
        const cy = Math.min(Math.max(y + 0.5, radius), size - radius)
        const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
        alpha = Math.round(255 * Math.min(1, Math.max(0, radius - distance + 1)))
        if (alpha === 0) continue
      }
      const t = (x + y) / (2 * size)
      let r = lerp(BG_TOP[0], BG_BOTTOM[0], t)
      let g = lerp(BG_TOP[1], BG_BOTTOM[1], t)
      let b = lerp(BG_TOP[2], BG_BOTTOM[2], t)
      // Radial glow anchored top-right.
      const glow = Math.max(0, 1 - Math.hypot(x - size * 0.78, y - size * 0.2) / (size * 0.75))
      const strength = glow * glow * 0.55
      r = lerp(r, GLOW[0], strength)
      g = lerp(g, GLOW[1], strength)
      b = lerp(b, GLOW[2], strength)
      const ink = glyphAt(x, y)
      if (ink !== undefined) [r, g, b] = ink
      rgba[at] = Math.round(r)
      rgba[at + 1] = Math.round(g)
      rgba[at + 2] = Math.round(b)
      rgba[at + 3] = alpha
    }
  }
  return encodePng(size, rgba)
}

mkdirSync(OUT_DIR, { recursive: true })
const PRODUCTS = [
  ['icon-192.png', render(192, true)],
  ['icon-512.png', render(512, true)],
  ['icon-maskable-512.png', render(512, false)],
  ['apple-touch-icon.png', render(180, false)],
]
for (const [file, buffer] of PRODUCTS) {
  const path = join(OUT_DIR, file)
  writeFileSync(path, buffer)
  console.log(`gen-icons: ${path} (${buffer.length} bytes)`)
}
