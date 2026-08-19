/**
 * Desktop icon products from the shared PWA renders (apps/pwa/assets):
 * `build/icon.icns` through the macOS sips + iconutil toolchain and
 * `build/icon.ico` as a PNG-payload ICO written directly (Vista+ format, no
 * image dependencies).
 *
 * Downscaling goes through whatever the host already ships — `sips` on macOS,
 * System.Drawing through PowerShell on Windows — so neither platform pulls in
 * an image library for nine thumbnails. The `.icns` half stays macOS-only:
 * `iconutil` has no counterpart elsewhere and only a macOS build consumes its
 * product, so off darwin it is skipped and `.ico` is still written. That is
 * what lets a Windows package be built on Windows, where it can also be
 * installed and tested.
 *
 * Usage: node scripts/gen-desktop-icons.mjs
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUILD_DIR = join(HERE, '..', 'build')
const SOURCE_512 = join(HERE, '..', '..', 'pwa', 'assets', 'icon-512.png')

mkdirSync(BUILD_DIR, { recursive: true })

/**
 * Write a square PNG downscale of `source` at `size` px to `out`, using the
 * host's own imaging: `sips` on macOS, System.Drawing on Windows. The Windows
 * side asks for high-quality bicubic explicitly — the default is nearest
 * neighbour, which is visible at 16 px.
 */
function resizePng(source, size, out) {
  if (process.platform === 'darwin') {
    execFileSync('sips', ['-z', String(size), String(size), source, '--out', out], { stdio: 'ignore' })
    return
  }
  if (process.platform !== 'win32') throw new Error(`gen-desktop-icons: no downscaler for ${process.platform}`)
  const script = [
    'Add-Type -AssemblyName System.Drawing;',
    `$image = [System.Drawing.Image]::FromFile('${source}');`,
    `$bitmap = New-Object System.Drawing.Bitmap ${String(size)}, ${String(size)};`,
    '$graphics = [System.Drawing.Graphics]::FromImage($bitmap);',
    "$graphics.InterpolationMode = 'HighQualityBicubic';",
    `$graphics.DrawImage($image, 0, 0, ${String(size)}, ${String(size)});`,
    `$bitmap.Save('${out}', [System.Drawing.Imaging.ImageFormat]::Png);`,
    '$graphics.Dispose(); $bitmap.Dispose(); $image.Dispose()',
  ].join(' ')
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' })
}

// ── icon.icns ───────────────────────────────────────────────────────────────

const iconset = join(BUILD_DIR, 'icon.iconset')
rmSync(iconset, { recursive: true, force: true })
if (process.platform === 'darwin') {
mkdirSync(iconset)
/** iconset member sizes; @2x members reuse the double-size render. */
const MEMBERS = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
]
for (const [name, size] of MEMBERS) {
  const out = join(iconset, name)
  if (size === 512) copyFileSync(SOURCE_512, out)
  else resizePng(SOURCE_512, size, out)
}
// 512@2x wants 1024px; reusing the 512 render loses nothing at dev fidelity.
copyFileSync(SOURCE_512, join(iconset, 'icon_512x512@2x.png'))
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(BUILD_DIR, 'icon.icns')])
rmSync(iconset, { recursive: true, force: true })
console.log(`gen-desktop-icons: ${join(BUILD_DIR, 'icon.icns')}`)
} else {
  console.log(`gen-desktop-icons: skipping icon.icns on ${process.platform} (iconutil is macOS-only)`)
}

// ── icon.ico ────────────────────────────────────────────────────────────────

const png256Path = join(BUILD_DIR, 'icon-256.tmp.png')
resizePng(SOURCE_512, 256, png256Path)
const png = readFileSync(png256Path)
rmSync(png256Path)
const ico = Buffer.alloc(6 + 16 + png.length)
ico.writeUInt16LE(0, 0) // reserved
ico.writeUInt16LE(1, 2) // type: icon
ico.writeUInt16LE(1, 4) // one image
ico[6] = 0 // width 256 encodes as 0
ico[7] = 0 // height 256 encodes as 0
ico[8] = 0 // no palette
ico[9] = 0 // reserved
ico.writeUInt16LE(1, 10) // color planes
ico.writeUInt16LE(32, 12) // bits per pixel
ico.writeUInt32LE(png.length, 14)
ico.writeUInt32LE(6 + 16, 18) // payload offset
png.copy(ico, 6 + 16)
writeFileSync(join(BUILD_DIR, 'icon.ico'), ico)
console.log(`gen-desktop-icons: ${join(BUILD_DIR, 'icon.ico')} (${ico.length} bytes)`)
