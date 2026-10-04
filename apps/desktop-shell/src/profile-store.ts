/**
 * Keep the two records pnpm checks before every `pnpm add` and `pnpm remove`
 * in a profile directory in line with where that directory is now, so plugin
 * installs, uninstalls, and upgrades keep working after the Harness home
 * moves.
 *
 * The store. pnpm without a `storeDir` setting picks its store per volume:
 * the one under its home directory (`~/Library/pnpm/store` on macOS,
 * `%LOCALAPPDATA%\pnpm\store` on Windows) when a file in the project can be
 * hard-linked there, otherwise `<mount point>/.pnpm-store`. An install records
 * the store it linked from as `storeDir` in `node_modules/.modules.yaml`, and
 * `pnpm add` and `pnpm remove` stop with `ERR_PNPM_UNEXPECTED_STORE` when they
 * pick a different one. A data move copies `profiles/*` as files, so after a
 * move between volumes pnpm picks the new volume's store for a `node_modules`
 * recorded with the old one.
 *
 * The virtual store. pnpm on Windows records `virtualStoreDir`, the
 * directory `node_modules\.pnpm`, as an absolute path (on other systems,
 * relative to `node_modules`), and `pnpm add` and `pnpm remove` stop with
 * `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE` when it is not the profile's own
 * `node_modules\.pnpm`. On Windows every data move changes that path, within
 * one volume as well as between two.
 *
 * {@link pinProfileStores} runs on every launch, before the server starts,
 * and makes up to two changes in each profile directory.
 *
 * A recorded `virtualStoreDir` that is absolute, ends in `node_modules/.pnpm`,
 * and names another directory than the profile's own `node_modules/.pnpm`
 * becomes `.pnpm`, the relative form pnpm resolves against `node_modules`,
 * unless `pnpm-workspace.yaml` sets a virtual store of its own. The decision
 * uses the comparison pnpm makes, `path.relative` of the two paths, so it is
 * case-insensitive on Windows as pnpm is. `.modules.yaml` is written back as
 * pnpm writes it, JSON with two-space indentation and no final newline, and
 * pnpm's next install in the profile records the absolute path again.
 *
 * In a profile whose `.modules.yaml` records an absolute `storeDir` and whose
 * `pnpm-workspace.yaml` is a mapping that sets no store, `storeDir` is added:
 * the recorded path without its last segment when that is a store version
 * such as `v11`, which pnpm appends again to a setting that does not end with
 * it, followed by the comment {@link PIN_COMMENT}. pnpm reads that setting in
 * place of its own choice, so the profile keeps using the store its
 * `node_modules` came from, whichever volume holds the profile now; a store on
 * another volume costs a copy of each new package's files instead of a link.
 * The pin is written whether or not the profile ever moved: it names the store
 * pnpm already uses there, so it changes nothing until the home moves, and it
 * needs no look at the store's volume, which may be a disk that is not
 * attached. On later launches a setting carrying that comment follows the
 * record: it takes the new value when `.modules.yaml` records another store,
 * and it is removed when nothing records a store, as after `node_modules` was
 * deleted, so the next install picks a store the way pnpm does without the
 * setting. A store setting without the comment, typed by hand or one whose
 * comment was deleted, is never changed, and one that names another store than
 * the recorded one is reported. The file is parsed and serialized again by the
 * `yaml` package: comments and every other setting are kept, the way the
 * plugin manager's own edit of `allowBuilds` keeps them, and indentation and
 * line endings follow that package's defaults. pnpm's own edits of the file
 * keep a value node they do not change, comment included.
 *
 * A profile without `node_modules/.modules.yaml` has nothing recorded, and a
 * profile without `pnpm-workspace.yaml` gets no pin, since creating that file
 * would change how pnpm treats the directory. A pinned store that is no longer
 * reachable, on a disk that was detached after a move, fails pnpm's next
 * operation in that profile until the disk is attached again or the
 * profile's `node_modules` is deleted and the app launched again; nothing here
 * can relink the profile without fetching every package again.
 * @module @deepseek-ai/dsh-desktop-shell/profile-store
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import { isMap, isScalar, parse, parseDocument, type Document } from 'yaml'
import { writeDurably } from './durable-file.ts'
import { profilesDirectory } from './profile-seed.ts'

/** The pnpm settings file in a profile directory. */
const WORKSPACE_FILENAME = 'pnpm-workspace.yaml'

/** The pnpm install record, under `node_modules`. */
const MODULES_FILENAME = '.modules.yaml'

/** The spellings of a store setting in `pnpm-workspace.yaml`. */
const STORE_KEYS: readonly string[] = ['storeDir', 'store-dir']

/** The spellings of a virtual store setting in `pnpm-workspace.yaml`; with either one, `.modules.yaml` is left as it is. */
const VIRTUAL_STORE_KEYS: readonly string[] = ['virtualStoreDir', 'virtual-store-dir']

/** The last segment of a store path that names pnpm's store version. */
const STORE_VERSION_SEGMENT = /^v\d+$/

/** The virtual store's directory name, which is also the relative `virtualStoreDir` naming the one inside `node_modules`. */
const VIRTUAL_STORE_NAME = '.pnpm'

/** The comment after a `storeDir` value this module wrote; a setting carrying it follows the record on later launches. */
export const PIN_COMMENT = 'set by the desktop app from node_modules/.modules.yaml'

/** What one run is given. */
export interface StorePinSpec {
  /** The Harness home whose profiles are pinned. */
  home: string
  /** The platform whose path syntax the recorded paths use. */
  platform: NodeJS.Platform
}

/** What one run did. */
export interface StorePinReport {
  /** One line per change to a profile's files, naming the setting or record, its new value, and why. */
  changed: string[]
  /** One line per profile left alone for a reason worth logging. */
  skipped: string[]
}

/** A profile's `node_modules/.modules.yaml`, as far as this module uses it. */
type InstallRecord =
  | { kind: 'none' }
  | { kind: 'problem'; problem: string }
  | { kind: 'record'; file: string; fields: Record<string, unknown>; store: string | undefined }

/**
 * The path functions for a platform's path syntax.
 * @param platform - the platform.
 * @returns `win32` on Windows, `posix` elsewhere.
 */
const pathsOf = (platform: NodeJS.Platform): typeof posix => (platform === 'win32' ? win32 : posix)

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
  const path = pathsOf(platform)
  const parent = path.dirname(recorded)
  if (!STORE_VERSION_SEGMENT.test(path.basename(recorded)) || parent === path.parse(recorded).root) return recorded
  return parent
}

/**
 * Read a profile's install record.
 * @param dir - the profile directory.
 * @param platform - the platform whose path syntax the recorded paths use.
 * @returns the record with its store, `none` when nothing is installed, or a reason the record cannot be used.
 * @throws when `.modules.yaml` exists but cannot be read.
 */
function readInstallRecord(dir: string, platform: NodeJS.Platform): InstallRecord {
  const file = join(dir, 'node_modules', MODULES_FILENAME)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'none' }
    throw error
  }
  let parsed: unknown
  try {
    parsed = parse(text)
  } catch (error) {
    return { kind: 'problem', problem: `node_modules/${MODULES_FILENAME} is not YAML (${String(error)})` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { kind: 'none' }
  const fields = parsed as Record<string, unknown>
  const store = fields['storeDir']
  if (store === undefined) return { kind: 'record', file, fields, store: undefined }
  if (typeof store !== 'string' || !pathsOf(platform).isAbsolute(store)) {
    return {
      kind: 'problem',
      problem: `node_modules/${MODULES_FILENAME} records storeDir ${JSON.stringify(store)}, which is not an absolute path`,
    }
  }
  return { kind: 'record', file, fields, store }
}

/**
 * The recorded virtual store when it is the `node_modules/.pnpm` of another
 * directory than this profile.
 * @param dir - the profile directory.
 * @param fields - the install record's fields.
 * @param platform - the platform whose path syntax the recorded path uses.
 * @returns the recorded path, or `undefined` when it is relative, this profile's own, or not a `node_modules/.pnpm`.
 */
function movedVirtualStore(dir: string, fields: Record<string, unknown>, platform: NodeJS.Platform): string | undefined {
  const recorded = fields['virtualStoreDir']
  const path = pathsOf(platform)
  if (typeof recorded !== 'string' || !path.isAbsolute(recorded)) return undefined
  if (path.basename(recorded) !== VIRTUAL_STORE_NAME || path.basename(path.dirname(recorded)) !== 'node_modules') return undefined
  return path.relative(path.join(dir, 'node_modules', VIRTUAL_STORE_NAME), recorded) === '' ? undefined : recorded
}

/**
 * Write a profile's settings file back with its permission bits.
 * @param file - the settings file.
 * @param document - its parsed contents.
 */
function writeSettings(file: string, document: Document): void {
  writeDurably(file, Buffer.from(String(document), 'utf8'), statSync(file).mode & 0o777)
}

/**
 * Bring one profile's store setting in line with its install record.
 * @param name - the profile's directory name, for the report.
 * @param file - the profile's settings file.
 * @param document - its parsed contents, a mapping.
 * @param store - the recorded store, `undefined` when nothing records one.
 * @param platform - the platform whose path syntax the recorded path uses.
 * @param report - extended with what was done.
 * @throws when the settings cannot be written.
 */
function pinStore(
  name: string, file: string, document: Document, store: string | undefined, platform: NodeJS.Platform, report: StorePinReport,
): void {
  const key = STORE_KEYS.find(candidate => document.has(candidate))
  if (key === undefined) {
    if (store === undefined) return
    const setting = storeSetting(store, platform)
    const node = document.createNode(setting)
    node.comment = ` ${PIN_COMMENT}`
    document.set('storeDir', node)
    writeSettings(file, document)
    report.changed.push(`${name}: storeDir ${setting} (node_modules was linked from ${store})`)
    return
  }
  const node: unknown = document.get(key, true)
  const value: unknown = isScalar(node) ? node.value : node
  if (!isScalar(node) || node.comment?.trim() !== PIN_COMMENT) {
    if (store !== undefined && value !== storeSetting(store, platform) && value !== store) {
      report.skipped.push(
        `${name}: ${WORKSPACE_FILENAME} sets ${key} ${JSON.stringify(value)}, but node_modules was linked from ${store}; left as it is`,
      )
    }
    return
  }
  if (store === undefined) {
    document.delete(key)
    writeSettings(file, document)
    report.changed.push(`${name}: ${key} ${JSON.stringify(value)} removed, since nothing installed records a store`)
    return
  }
  const setting = storeSetting(store, platform)
  if (value === setting) return
  node.value = setting
  writeSettings(file, document)
  report.changed.push(`${name}: ${key} ${JSON.stringify(value)} changed to ${setting} (node_modules was linked from ${store})`)
}

/**
 * Bring one profile's records in line with where it is.
 * @param name - the profile's directory name, for the report.
 * @param dir - the profile directory.
 * @param platform - the platform whose path syntax the recorded paths use.
 * @param report - extended with what was done.
 * @throws when a file exists but cannot be read, or a file cannot be written.
 */
function pinProfile(name: string, dir: string, platform: NodeJS.Platform, report: StorePinReport): void {
  const record = readInstallRecord(dir, platform)
  if (record.kind === 'problem') {
    report.skipped.push(`${name}: ${record.problem}; left as it is`)
    return
  }
  const file = join(dir, WORKSPACE_FILENAME)
  let document: Document | undefined
  try {
    document = parseDocument(readFileSync(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const settings = document !== undefined && document.errors.length === 0 && isMap(document.contents) ? document : undefined
  const store = record.kind === 'record' ? record.store : undefined
  if (record.kind === 'record') {
    const moved = movedVirtualStore(dir, record.fields, platform)
    const setting = settings === undefined ? undefined : VIRTUAL_STORE_KEYS.find(candidate => settings.has(candidate))
    if (moved !== undefined && setting !== undefined) {
      report.skipped.push(`${name}: ${WORKSPACE_FILENAME} sets ${setting}, so the recorded virtualStoreDir ${moved} is left as it is`)
    } else if (moved !== undefined && (document === undefined || settings !== undefined)) {
      const fields = { ...record.fields, virtualStoreDir: VIRTUAL_STORE_NAME }
      writeDurably(record.file, Buffer.from(JSON.stringify(fields, undefined, 2), 'utf8'), statSync(record.file).mode & 0o777)
      report.changed.push(`${name}: virtualStoreDir ${moved} changed to ${VIRTUAL_STORE_NAME} in node_modules/${MODULES_FILENAME}`)
    }
  }
  if (document === undefined) {
    if (store !== undefined) report.skipped.push(`${name}: no ${WORKSPACE_FILENAME} to record the store ${store} in; left as it is`)
    return
  }
  if (settings === undefined) {
    if (store !== undefined) report.skipped.push(`${name}: ${WORKSPACE_FILENAME} is not a YAML mapping; the store ${store} is not recorded`)
    return
  }
  pinStore(name, file, settings, store, platform, report)
}

/**
 * Bring the records of every profile under a Harness home in line with where
 * it is: repair a virtual store recorded at another location, and add, update,
 * or remove the store setting this module owns. Repeating a run changes
 * nothing. A profile that cannot be read or written is reported and the run
 * goes on.
 * @param spec - the home and the platform.
 * @returns the changes made and the profiles left alone with a reason.
 */
export function pinProfileStores(spec: StorePinSpec): StorePinReport {
  const report: StorePinReport = { changed: [], skipped: [] }
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
