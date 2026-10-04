/**
 * Pin each profile's pnpm store in its `pnpm-workspace.yaml`, so plugin
 * installs, uninstalls, and upgrades keep working after the Harness home
 * moves to another volume.
 *
 * pnpm without a `storeDir` setting picks its store per volume: the one under
 * its home directory (`~/Library/pnpm/store` on macOS,
 * `%LOCALAPPDATA%\pnpm\store` on Windows) when a file in the project can be
 * hard-linked there, otherwise `<mount point>/.pnpm-store`. An install records
 * the store it linked from in `node_modules/.modules.yaml`, and every later
 * `pnpm add` and `pnpm remove` in that directory stops with
 * `ERR_PNPM_UNEXPECTED_STORE` when it picks a different one. A data move
 * copies `profiles/*` as files, so after a move between volumes pnpm picks the
 * new volume's store for a `node_modules` recorded with the old one, and every
 * operation of the plugin manager, which runs pnpm in the profile directory,
 * fails until the data returns to the volume it came from.
 *
 * {@link pinProfileStores} runs on every launch, before the server starts. In
 * each profile directory whose `node_modules/.modules.yaml` records an
 * absolute `storeDir` and whose `pnpm-workspace.yaml` is a mapping that sets
 * no store, it adds `storeDir`: the recorded path without its last segment
 * when that is a store version such as `v11`, which pnpm appends again to a
 * setting that does not end with it. pnpm reads that setting in place of its
 * own choice, so the profile keeps using the store its `node_modules` came
 * from, whichever volume holds the profile now; a store on another volume
 * costs a copy of each new package's files instead of a link.
 * The pin is written whether or not the profile ever moved: it names the store
 * pnpm already uses there, so it changes nothing until the home moves, and it
 * needs no look at the store's volume, which may be a disk that is not
 * attached. Every other byte of the file stays as it was, comments included,
 * the way the plugin manager's own edit of `allowBuilds` keeps them.
 *
 * A `storeDir` already in the file is never changed, and one that names
 * another store than the recorded one is reported. A profile without
 * `node_modules/.modules.yaml` has nothing recorded and is left alone, and so
 * is one without `pnpm-workspace.yaml`, since creating that file would change
 * how pnpm treats the directory. A pinned store that is no longer reachable,
 * on a disk that was detached after a move, fails pnpm's next operation in
 * that profile; nothing here can relink the profile without fetching every
 * package again.
 * @module @deepseek-ai/dsh-desktop-shell/profile-store
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import { isMap, parse, parseDocument } from 'yaml'
import { writeDurably } from './durable-file.ts'
import { profilesDirectory } from './profile-seed.ts'

/** The pnpm settings file in a profile directory. */
const WORKSPACE_FILENAME = 'pnpm-workspace.yaml'

/** The spellings of a store setting in `pnpm-workspace.yaml`; a file with either one is left as it is. */
const STORE_KEYS: readonly string[] = ['storeDir', 'store-dir']

/** The last segment of a store path that names pnpm's store version. */
const STORE_VERSION_SEGMENT = /^v\d+$/

/** What one run is given. */
export interface StorePinSpec {
  /** The Harness home whose profiles are pinned. */
  home: string
  /** The platform whose path syntax the recorded store paths use. */
  platform: NodeJS.Platform
}

/** What one run did. */
export interface StorePinReport {
  /** One line per profile whose `pnpm-workspace.yaml` gained `storeDir`, naming the value and the recorded store. */
  pinned: string[]
  /** One line per profile left alone for a reason worth logging. */
  skipped: string[]
}

/**
 * The value to pin for a recorded store path: the path without its last
 * segment when that segment is a store version and the rest is more than a
 * root, otherwise the path itself. pnpm appends its store version to a
 * setting that does not already end with it.
 * @param recorded - the absolute `storeDir` from `.modules.yaml`.
 * @param platform - the platform whose path syntax it uses.
 * @returns the `storeDir` setting that resolves to `recorded` under the pnpm that recorded it.
 */
export function storeSetting(recorded: string, platform: NodeJS.Platform): string {
  const path = platform === 'win32' ? win32 : posix
  const parent = path.dirname(recorded)
  if (!STORE_VERSION_SEGMENT.test(path.basename(recorded)) || parent === path.parse(recorded).root) return recorded
  return parent
}

/**
 * The store a profile's `node_modules` was linked from.
 * @param dir - the profile directory.
 * @param platform - the platform whose path syntax the recorded path uses.
 * @returns the absolute path, `undefined` when nothing is installed, or a reason the record cannot be used.
 * @throws when `.modules.yaml` exists but cannot be read.
 */
function recordedStore(dir: string, platform: NodeJS.Platform): string | undefined | { problem: string } {
  let text: string
  try {
    text = readFileSync(join(dir, 'node_modules', '.modules.yaml'), 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
  let record: unknown
  try {
    record = parse(text)
  } catch (error) {
    return { problem: `node_modules/.modules.yaml is not YAML (${String(error)})` }
  }
  const store = typeof record === 'object' && record !== null ? (record as Record<string, unknown>)['storeDir'] : undefined
  if (store === undefined) return undefined
  const path = platform === 'win32' ? win32 : posix
  if (typeof store !== 'string' || !path.isAbsolute(store)) {
    return { problem: `node_modules/.modules.yaml records storeDir ${JSON.stringify(store)}, which is not an absolute path` }
  }
  return store
}

/**
 * Pin one profile's store.
 * @param name - the profile's directory name, for the report.
 * @param dir - the profile directory.
 * @param platform - the platform whose path syntax the recorded path uses.
 * @param report - extended with what was done.
 * @throws when a file exists but cannot be read, or the settings cannot be written.
 */
function pinProfile(name: string, dir: string, platform: NodeJS.Platform, report: StorePinReport): void {
  const recorded = recordedStore(dir, platform)
  if (recorded === undefined) return
  if (typeof recorded !== 'string') {
    report.skipped.push(`${name}: ${recorded.problem}; left as it is`)
    return
  }
  const file = join(dir, WORKSPACE_FILENAME)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    report.skipped.push(`${name}: no ${WORKSPACE_FILENAME} to record the store ${recorded} in; left as it is`)
    return
  }
  const document = parseDocument(text)
  if (document.errors.length > 0 || !isMap(document.contents)) {
    report.skipped.push(`${name}: ${WORKSPACE_FILENAME} is not a YAML mapping; the store ${recorded} is not recorded`)
    return
  }
  const setting = storeSetting(recorded, platform)
  const key = STORE_KEYS.find(candidate => document.has(candidate))
  if (key !== undefined) {
    const value = document.get(key)
    if (value !== setting && value !== recorded) {
      report.skipped.push(
        `${name}: ${WORKSPACE_FILENAME} sets ${key} ${JSON.stringify(value)}, but node_modules was linked from ${recorded}; left as it is`,
      )
    }
    return
  }
  document.set('storeDir', setting)
  writeDurably(file, Buffer.from(String(document), 'utf8'), statSync(file).mode & 0o777)
  report.pinned.push(`${name}: storeDir ${setting} (node_modules was linked from ${recorded})`)
}

/**
 * Pin the store of every profile under a Harness home that has a recorded
 * store and no store setting. Repeating a run changes nothing. A profile that
 * cannot be read or written is reported and the run goes on.
 * @param spec - the home and the platform.
 * @returns the profiles pinned and the ones left alone with a reason.
 */
export function pinProfileStores(spec: StorePinSpec): StorePinReport {
  const report: StorePinReport = { pinned: [], skipped: [] }
  const root = profilesDirectory(spec.home)
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report.skipped.push(`${root}: ${String(error)}`)
    return report
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    // `node_modules` beside the profiles is the shared flat fallback, not a profile.
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    try {
      pinProfile(entry.name, join(root, entry.name), spec.platform, report)
    } catch (error) {
      report.skipped.push(`${entry.name}: ${String(error)}`)
    }
  }
  return report
}
