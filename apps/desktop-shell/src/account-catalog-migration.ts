/**
 * Remove the `models` field a Models page save left on the DeepSeek account
 * row, before the server starts, on each launch of a build that carries this
 * until the run is done.
 *
 * Through 0.1.0-rc.38 the Models page edited the `deepseek-account` route's
 * catalog, and a save writes the composed row's whole `config`, `models`
 * included, into the profile's own patch layer
 * (`$DSH_HOME/profiles/desktop-shell/cordis.patch.yml`); the server's one-time
 * import of a `settings.yaml` section writes through the same path. From
 * dsh-v0.2.1-alpha.4 the account plugin refuses any `models` key at load
 * (`llm-deepseek-account: models is no longer configurable`), whatever its
 * value, so a row that keeps one loses every account model.
 *
 * `models` is removed from the `config` mapping of every top-level
 * id-targeted `llm-deepseek-account` row of that file, and from the
 * `llm-deepseek-account` section of the `settings.yaml` the server is about to
 * import, whatever it holds. Every other key stays; a row whose `config` held
 * nothing else keeps `config: {}`, which composes as the row without it does,
 * and a `settings.yaml` section left empty is taken out. Rows inside an
 * `insert` list, every other row and section, and `$DSH_HOME/cordis.patch.yml`
 * are not read. The value removed is recorded as parsed, and nothing is
 * rewritten as `modelOverrides`.
 *
 * `settings.yaml` is cleared only once `settings-migration.json` reads `done`,
 * for the reason and with the profile cleared again on each waiting launch, as
 * `model-catalog-migration.ts` states. A file that does not parse as the YAML
 * this edits is left as it is and named once in the log; the run then stays
 * `pending`, so the first launch that parses it clears it. A profile layer of
 * comments alone holds no row and does not keep the run `pending`.
 *
 * {@link ACCOUNT_CATALOG_MIGRATION_MARKER} records every removal and every
 * file skipped, separately from `model-catalog-migration.json`, which machines
 * that ran rc.37 or rc.38 already hold as `done`. A launch that stays
 * `pending` and finds nothing new leaves it unwritten. It is written after the
 * files it describes, and `done` makes every later launch skip the run. A
 * marker that cannot be read counts as absent.
 * @module @deepseek-ai/dsh-desktop-shell/account-catalog-migration
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isMap, isSeq, parseDocument, type YAMLMap } from 'yaml'
import { writeAtomic } from './profile-seed.ts'
import {
  PATCH_PARSE_OPTIONS, PRIVATE_FILE_MODE, PROFILE_PATCH_FILENAME, readSettingsMigrationMarker, SETTINGS_FILENAME,
  SETTINGS_MIGRATION_MARKER,
} from './settings-migration.ts'

/** The run's record inside the desktop profile directory. */
export const ACCOUNT_CATALOG_MIGRATION_MARKER = 'account-catalog-migration.json'

/** The profile row id and the `settings.yaml` section name the field lives under. */
const LLM_DEEPSEEK_ACCOUNT = 'llm-deepseek-account'

/** The contents of {@link ACCOUNT_CATALOG_MIGRATION_MARKER}. */
export interface AccountCatalogMigrationMarker {
  /** `pending` while `settings.yaml` waits or a file did not parse; `done` makes every later launch skip the run. */
  state: 'pending' | 'done'
  /** True while `settings.yaml` waits for `settings-migration.json` to read `done`. */
  settingsDeferred?: boolean
  /** Each value removed, in removal order: the file it was in and the value as parsed. */
  removed: { file: string; models: unknown }[]
  /** One line per file left alone, each saying why. */
  skipped: string[]
}

/** What one run did, for the launch log. */
export interface AccountCatalogMigrationReport {
  /** Log lines; empty for a launch the marker already covers. */
  lines: string[]
}

/**
 * What one run records into, and the log each record is also written to as
 * it is made, so a later fault still leaves an earlier removal in the log.
 */
interface Run {
  marker: AccountCatalogMigrationMarker
  report: AccountCatalogMigrationReport
  /** Set when a file did not parse, which keeps the run `pending`. */
  unparsed: boolean
}

/**
 * Run the migration for this Harness home unless its marker reads `done`.
 *
 * Never throws: a fault leaves the marker as the last finished write left it,
 * so the next launch runs the unfinished part again, and becomes one log line
 * naming it.
 * @param home - the Harness home, holding `settings.yaml`.
 * @param profileDir - the desktop profile directory, holding the markers and the patch layer.
 * @returns the lines to log.
 */
export function migrateAccountCatalog(home: string, profileDir: string): AccountCatalogMigrationReport {
  const report: AccountCatalogMigrationReport = { lines: [] }
  try {
    runMigration(home, profileDir, report)
  } catch (error) {
    report.lines.push(`stopped and will run again next launch: ${String(error)}`)
  }
  return report
}

/**
 * Read the marker, or undefined when there is none or it is not one this
 * module wrote.
 * @param path - the marker path.
 * @returns the marker.
 */
export function readAccountCatalogMigrationMarker(path: string): AccountCatalogMigrationMarker | undefined {
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // Unreadable, a directory included: the run starts over as on a machine it never ran on.
    return undefined
  }
  return isMarker(parsed) ? parsed : undefined
}

/** Whether parsed JSON holds the fields every marker this module writes carries. */
function isMarker(value: unknown): value is AccountCatalogMigrationMarker {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (record['state'] === 'pending' || record['state'] === 'done')
    && Array.isArray(record['removed']) && Array.isArray(record['skipped'])
}

/** The body {@link migrateAccountCatalog} guards. */
function runMigration(home: string, profileDir: string, report: AccountCatalogMigrationReport): void {
  const markerPath = join(profileDir, ACCOUNT_CATALOG_MIGRATION_MARKER)
  const previous = readAccountCatalogMigrationMarker(markerPath)
  if (previous?.state === 'done') return
  if (previous === undefined && existsSync(markerPath)) {
    report.lines.push(`${ACCOUNT_CATALOG_MIGRATION_MARKER} cannot be read; running the migration again`)
  }
  const marker: AccountCatalogMigrationMarker = previous === undefined
    ? { state: 'pending', removed: [], skipped: [] }
    : { ...previous, removed: [...previous.removed], skipped: [...previous.skipped] }
  const run: Run = { marker, report, unparsed: false }

  // Before `done`, the last launch's server may have imported the field into the profile.
  clearProfileRows(join(profileDir, PROFILE_PATCH_FILENAME), run)

  const settingsReady = readSettingsMigrationMarker(join(profileDir, SETTINGS_MIGRATION_MARKER))?.state === 'done'
  if (settingsReady) {
    clearSettingsSection(join(home, SETTINGS_FILENAME), run)
    delete marker.settingsDeferred
  } else {
    marker.settingsDeferred = true
    report.lines.push(`left ${SETTINGS_FILENAME} for a launch whose ${SETTINGS_MIGRATION_MARKER} reads done`)
  }
  marker.state = settingsReady && !run.unparsed ? 'done' : 'pending'
  if (previous !== undefined && isDeepStrictEqual(previous, marker)) return
  writeAtomic(markerPath, `${JSON.stringify(marker, undefined, 2)}\n`, PRIVATE_FILE_MODE)
}

/**
 * Read one member of parsed plain data.
 * @param value - an object or array from `Document.toJS()`, or any other value.
 * @param key - the member's key or index.
 * @returns the member, or undefined when `value` holds none.
 */
function memberOf(value: unknown, key: string | number): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

/**
 * Take `models` out of one account mapping and record its value.
 * @param section - the mapping holding `models`: a profile row's `config`, or the `settings.yaml` section.
 * @param plain - the same mapping from `Document.toJS()`, aliases resolved and `null` kept.
 * @param where - the file and the kind of mapping, as the log names them.
 * @param file - the file name the marker records.
 * @param run - extended with what this removed.
 * @returns true when it removed `models`.
 */
function removeModels(section: YAMLMap, plain: unknown, where: string, file: string, run: Run): boolean {
  if (!section.has('models')) return false
  const models = memberOf(plain, 'models')
  section.delete('models')
  run.marker.removed.push({ file, models })
  run.report.lines.push(`removed models from ${where}; recorded in ${ACCOUNT_CATALOG_MIGRATION_MARKER}`)
  return true
}

/**
 * Record a file left alone, unless an earlier launch recorded the same line,
 * and keep the run `pending`.
 * @param line - the file name and why.
 * @param run - extended with the line.
 */
function skipUnparsed(line: string, run: Run): void {
  run.unparsed = true
  if (run.marker.skipped.includes(line)) return
  run.marker.skipped.push(line)
  run.report.lines.push(`skipped ${line}`)
}

/**
 * Clear every top-level id-targeted account row of the profile's patch layer,
 * writing the file only when one changed.
 * @param patchPath - the profile's `cordis.patch.yml`.
 * @param run - extended with what this found.
 * @throws when the file exists and cannot be read or replaced.
 */
function clearProfileRows(patchPath: string, run: Run): void {
  if (!existsSync(patchPath)) return
  const document = parseDocument(readFileSync(patchPath, 'utf8'), PATCH_PARSE_OPTIONS)
  // A layer of comments alone parses to no node, so it holds no row to clear.
  if (document.errors[0] === undefined && document.contents === null) return
  if (document.errors[0] !== undefined || !isSeq(document.contents)) {
    skipUnparsed(`${PROFILE_PATCH_FILENAME}: not a YAML sequence this shell can edit`, run)
    return
  }
  const plain: unknown = document.toJS()
  let changed = false
  for (const [index, item] of document.contents.items.entries()) {
    if (!isMap(item) || item.has('insert')) continue
    const id: unknown = item.get('id')
    if (id !== LLM_DEEPSEEK_ACCOUNT) continue
    const config: unknown = item.get('config', true)
    if (!isMap(config)) continue
    const where = `${PROFILE_PATCH_FILENAME}'s ${LLM_DEEPSEEK_ACCOUNT} row`
    if (removeModels(config, memberOf(memberOf(plain, index), 'config'), where, PROFILE_PATCH_FILENAME, run)) changed = true
  }
  if (changed) writeAtomic(patchPath, document.toString(), PRIVATE_FILE_MODE)
}

/**
 * Clear the account section of the `settings.yaml` the server is about to
 * import, and take the section out when nothing is left in it.
 * @param settingsPath - `$DSH_HOME/settings.yaml`.
 * @param run - extended with what this found.
 * @throws when the file exists and cannot be read or replaced.
 */
function clearSettingsSection(settingsPath: string, run: Run): void {
  if (!existsSync(settingsPath)) return
  const document = parseDocument(readFileSync(settingsPath, 'utf8'))
  if (document.errors[0] !== undefined || !isMap(document.contents)) {
    skipUnparsed(`${SETTINGS_FILENAME}: not a YAML mapping of sections`, run)
    return
  }
  const section: unknown = document.get(LLM_DEEPSEEK_ACCOUNT, true)
  if (!isMap(section)) return
  const plain = memberOf(document.toJS(), LLM_DEEPSEEK_ACCOUNT)
  if (!removeModels(section, plain, `${SETTINGS_FILENAME}'s ${LLM_DEEPSEEK_ACCOUNT} section`, SETTINGS_FILENAME, run)) return
  if (section.items.length === 0) document.delete(LLM_DEEPSEEK_ACCOUNT)
  writeAtomic(settingsPath, document.toString(), PRIVATE_FILE_MODE)
}
