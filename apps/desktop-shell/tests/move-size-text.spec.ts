/**
 * The size a data move shows on both of its screens. The Settings page's data
 * section asks the person to confirm the preflight's `copyBytes`, and the
 * progress window counts up to the copier's total; both count the same data,
 * the preflight's scan and the copier's own scan of it, so one byte count must
 * read the same on both.
 *
 * The Settings half is `formatSize` from the vendored
 * `@haoran/dsh-data-location` browser bundle, resolved from the server's
 * manifest as the payload ships it. The bundle is run with a module loader
 * that hands every import an empty object: the bundle only binds its imports
 * when it loads, and `formatSize` uses none of them.
 * @module
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { formatBytes } from '../src/move-text.ts'

const fromServer = createRequire(join(process.cwd(), 'apps', 'desktop-server', 'package.json'))

/** The manifest field this suite reads. */
interface ClientManifest {
  exports?: Record<string, string | { default?: string }>
}

/** What the bundle hands its module loader. */
interface BundleRegistration {
  factory: (require: (id: string) => object) => Record<string, unknown>
}

/**
 * Whether a bundle export is a byte-count formatter.
 * @param value - the export.
 * @returns true for a function.
 */
function isFormatter(value: unknown): value is (bytes: number) => string {
  return typeof value === 'function'
}

/**
 * The Settings page's byte-count formatter, from the vendored bundle.
 * @returns `formatSize`.
 */
function settingsFormatSize(): (bytes: number) => string {
  const manifestPath = fromServer.resolve('@haoran/dsh-data-location/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ClientManifest
  const declared = manifest.exports?.['./client']
  const relative = typeof declared === 'string' ? declared : declared?.default
  if (relative === undefined) throw new Error('@haoran/dsh-data-location declares no ./client export')
  let exported: Record<string, unknown> = {}
  const load = (registration: BundleRegistration): void => {
    exported = registration.factory(() => ({}))
  }
  runInNewContext(readFileSync(resolve(dirname(manifestPath), relative), 'utf8'), { window: { __ModuleLoader__: { load } } })
  const formatSize = exported['formatSize']
  if (!isFormatter(formatSize)) throw new Error('@haoran/dsh-data-location/client exports no formatSize')
  return formatSize
}

const KIB = 1024
const MIB = KIB * 1024
const GIB = MIB * 1024

/** Counts on both sides of every unit step and rounding edge, plus sizes a home has. */
const COUNTS = [
  1, 511, 512, 1023, KIB, 1536, 4_000, MIB - 513, MIB - 1, MIB, MIB + 1, 1.5 * MIB, 820e6,
  558_900_000, GIB - 1, GIB, GIB + 1, 1.24e9, 2e9, 5.55 * GIB, 120 * GIB,
]

describe('the size a data move shows', () => {
  const formatSize = settingsFormatSize()

  it('reads the same in the progress window as on the Settings page for every count above zero', () => {
    for (const bytes of COUNTS) expect(formatBytes(bytes), `${String(bytes)} bytes`).toBe(formatSize(bytes))
  })

  it('reads 533 MB on both screens for the 533 MiB the Settings page confirmed', () => {
    expect([formatSize(558_900_000), formatBytes(558_900_000)]).toEqual(['533 MB', '533 MB'])
  })

  it('reads zero, where the progress line starts, as 0 KB where the Settings page reads 1 KB', () => {
    expect([formatBytes(0), formatSize(0)]).toEqual(['0 KB', '1 KB'])
  })
})
