/**
 * Clear the DeepSeek model tables earlier desktop builds froze into a
 * machine's own settings, before the server starts, on each launch of a build
 * that carries this until the run is done.
 *
 * Through 0.1.0-rc.36.1 a bundle layer of this payload set `models` on the
 * `llm-deepseek` row, which replaces the adapter's own catalog whole. From
 * 0.1.0-rc.34 a save from the Models page writes the composed row's whole
 * `config` into the profile's own patch layer
 * (`$DSH_HOME/profiles/desktop-shell/cordis.patch.yml`), and the server's
 * one-time import of a `settings.yaml` section writes through the same path,
 * so a machine that saved a DeepSeek setting or imported such a section holds
 * the table the bundle layer carried then. That layer applies after every
 * bundle layer, so the bundle layer that stopped setting a table cannot reach
 * such a machine; rc.33 and earlier clients kept a table in `settings.yaml`
 * instead, which that import would carry into the profile the same way.
 *
 * A `models` value is removed only where it equals one of
 * {@link SHIPPED_MODEL_TABLES} — key order aside, row order counting — since
 * such a value holds nothing the user wrote. Every other key of the row stays,
 * and so does a table the user changed, which is recorded instead. No other
 * row, no other `settings.yaml` section, and no stored model selection,
 * reasoning effort, subagent allow-list, or review model is read or written.
 *
 * `settings.yaml` is cleared only once `settings-migration.json` reads `done`:
 * until then that migration may still write its migrated copy back from
 * `settings.yaml.pre-rc34` on a later launch, and the server would import
 * whatever table that copy carries. A launch that finds it unfinished clears
 * the profile and records `settingsDeferred`. Each later launch before `done`
 * clears the profile again: a settings migration that stopped before it moved
 * `settings.yaml` aside, or after it wrote the migrated copy, leaves a file
 * the server of the same launch imports into the profile's `llm-deepseek`
 * row, table included, and no bundle layer of this build sets a shipped
 * table. The launch that finds the settings migration done also clears the
 * file it left, before that launch's server imports it.
 *
 * {@link MODEL_CATALOG_MIGRATION_MARKER} records every removal and every table
 * kept. A table kept and a file skipped are recorded once however many
 * launches find them, so a launch that stays `pending` and finds nothing new
 * leaves the marker unwritten. It is written after the files it describes,
 * and `done` makes every later launch skip the run, so a table the user
 * builds again afterwards stays. A marker that cannot be read counts as
 * absent.
 * @module @deepseek-ai/dsh-desktop-shell/model-catalog-migration
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

/** The run's record inside the desktop profile directory, separate from `settings-migration.json`. */
export const MODEL_CATALOG_MIGRATION_MARKER = 'model-catalog-migration.json'

/** The profile row id and the `settings.yaml` section name the tables live under. */
const LLM_DEEPSEEK = 'llm-deepseek'

/** The releases that shipped one table, as the marker names it. */
export type ShippedModelTable = 'rc34-rc36' | 'rc32-rc33' | 'rc20-rc30'

/**
 * Every `models` table a desktop release composed onto the `llm-deepseek` row,
 * as the parsed YAML value the row held.
 *
 * - `rc34-rc36`: `apps/desktop-app/cordis.patch.yml` at tags
 *   `desktop-v0.1.0-rc.34` and `desktop-v0.1.0-rc.34.1`, and in the rc.35,
 *   rc.35.1, rc.36, and rc.36.1 releases.
 * - `rc32-rc33`: the same file at tags `desktop-v0.1.0-rc.32` and
 *   `desktop-v0.1.0-rc.33`.
 * - `rc20-rc30`: `cordis.patch.yml` inside the vendored
 *   `haoran-dsh-default-model-0.1.2.tgz` every tag from `desktop-v0.1.0-rc.20`
 *   through `desktop-v0.1.0-rc.30` carries.
 */
export const SHIPPED_MODEL_TABLES: Readonly<Record<ShippedModelTable, readonly Readonly<Record<string, unknown>>[]>> = {
  'rc34-rc36': [{
    id: 'deepseek-flash',
    name: 'DeepSeek-V4.1-Flash',
    description: 'V4.1 Flash · 文本与图片',
    contextWindow: 1_000_000,
    inputModalities: ['text', 'image'],
    systemPromptUpdate: 'in-history',
    toolUpdate: 'addition-only',
  }],
  'rc32-rc33': [{
    id: 'deepseek-flash',
    name: 'DeepSeek-V4.1-Flash',
    description: 'V4.1 Flash · 文本与图片',
    contextWindow: 1_000_000,
    inputModalities: ['text', 'image'],
    imagePixelBudget: 640_000,
    imageMaxBytes: 1_048_576,
    systemPromptUpdate: 'in-history',
  }],
  'rc20-rc30': [
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    {
      id: 'deepseek-v4-flash-vision-exp',
      name: 'default',
      description: 'deepseek-v4-flash-vision-exp · 视觉',
      inputModalities: ['text', 'image'],
    },
  ],
}

/** The contents of {@link MODEL_CATALOG_MIGRATION_MARKER}. */
export interface ModelCatalogMigrationMarker {
  /** `pending` while `settings.yaml` waits; `done` makes every later launch skip the run. */
  state: 'pending' | 'done'
  /** True while `settings.yaml` waits for `settings-migration.json` to read `done`; set exactly while `state` is `pending`. */
  settingsDeferred?: boolean
  /** Each table removed: the file it was in and which shipped table it equalled. */
  removed: { file: string; table: ShippedModelTable }[]
  /** Each table left in place because it equals no shipped table, with its value; one entry per file and value. */
  kept: { file: string; models: unknown }[]
  /** One line per file left alone, each saying why. */
  skipped: string[]
}

/** What one run did, for the launch log. */
export interface ModelCatalogMigrationReport {
  /** Log lines; empty for a launch the marker already covers. */
  lines: string[]
}

/**
 * What one run records into, and the log each record is also written to as
 * it is made, so a later fault still leaves an earlier removal in the log.
 */
interface Run {
  marker: ModelCatalogMigrationMarker
  report: ModelCatalogMigrationReport
}

/**
 * Run the migration for this Harness home unless its marker reads `done`.
 *
 * Never throws: a fault leaves the marker as the last finished write left it,
 * so the next launch runs the unfinished part again, and becomes one log line
 * naming it.
 * @param home - the Harness home, holding `settings.yaml`.
 * @param profileDir - the desktop profile directory, holding both markers and the patch layer.
 * @returns the lines to log.
 */
export function migrateModelCatalog(home: string, profileDir: string): ModelCatalogMigrationReport {
  const report: ModelCatalogMigrationReport = { lines: [] }
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
export function readModelCatalogMigrationMarker(path: string): ModelCatalogMigrationMarker | undefined {
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
function isMarker(value: unknown): value is ModelCatalogMigrationMarker {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (record['state'] === 'pending' || record['state'] === 'done')
    && Array.isArray(record['removed']) && Array.isArray(record['kept']) && Array.isArray(record['skipped'])
}

/** The body {@link migrateModelCatalog} guards. */
function runMigration(home: string, profileDir: string, report: ModelCatalogMigrationReport): void {
  const markerPath = join(profileDir, MODEL_CATALOG_MIGRATION_MARKER)
  const previous = readModelCatalogMigrationMarker(markerPath)
  if (previous?.state === 'done') return
  if (previous === undefined && existsSync(markerPath)) {
    report.lines.push(`${MODEL_CATALOG_MIGRATION_MARKER} cannot be read; running the migration again`)
  }
  const marker: ModelCatalogMigrationMarker = previous === undefined
    ? { state: 'pending', removed: [], kept: [], skipped: [] }
    : { ...previous, removed: [...previous.removed], kept: [...previous.kept], skipped: [...previous.skipped] }
  const run: Run = { marker, report }

  // Before `done`, the last launch's server may have imported a shipped table into the profile.
  clearProfileTables(join(profileDir, PROFILE_PATCH_FILENAME), run)

  const settingsReady = readSettingsMigrationMarker(join(profileDir, SETTINGS_MIGRATION_MARKER))?.state === 'done'
  if (settingsReady) {
    clearSettingsTable(join(home, SETTINGS_FILENAME), run)
    marker.state = 'done'
    delete marker.settingsDeferred
  } else {
    marker.state = 'pending'
    marker.settingsDeferred = true
    report.lines.push(`left ${SETTINGS_FILENAME} for a launch whose ${SETTINGS_MIGRATION_MARKER} reads done`)
  }
  if (previous !== undefined && isDeepStrictEqual(previous, marker)) return
  writeAtomic(markerPath, `${JSON.stringify(marker, undefined, 2)}\n`, PRIVATE_FILE_MODE)
}

/**
 * Name the shipped table a `models` value equals.
 * @param models - the value as parsed.
 * @returns the table's name, or undefined when it equals none.
 */
function shippedTable(models: unknown): ShippedModelTable | undefined {
  const names = Object.keys(SHIPPED_MODEL_TABLES) as ShippedModelTable[]
  return names.find(name => isDeepStrictEqual(models, SHIPPED_MODEL_TABLES[name]))
}

/**
 * Take a shipped table out of one `llm-deepseek` mapping, or record the table
 * it keeps.
 * @param section - the mapping holding `models`: a profile row's `config`, or the `settings.yaml` section.
 * @param file - the file name the marker records.
 * @param run - extended with what this found.
 * @returns true when it removed `models`.
 */
function clearTable(section: YAMLMap, file: string, run: Run): boolean {
  if (!section.has('models')) return false
  const node: unknown = section.get('models', true)
  const models: unknown = isMap(node) || isSeq(node) ? node.toJSON() : section.get('models')
  const table = shippedTable(models)
  if (table === undefined) {
    if (!run.marker.kept.some(entry => entry.file === file && isDeepStrictEqual(entry.models, models))) {
      run.marker.kept.push({ file, models })
      run.report.lines.push(`kept the edited models table in ${file}'s ${LLM_DEEPSEEK} row; recorded in ${MODEL_CATALOG_MIGRATION_MARKER}`)
    }
    return false
  }
  section.delete('models')
  run.marker.removed.push({ file, table })
  run.report.lines.push(`removed the ${table} models table from ${file}'s ${LLM_DEEPSEEK} row`)
  return true
}

/**
 * Record a file left alone, unless an earlier launch recorded the same line.
 * @param line - the file name and why.
 * @param run - extended with the line.
 */
function skip(line: string, run: Run): void {
  if (run.marker.skipped.includes(line)) return
  run.marker.skipped.push(line)
  run.report.lines.push(`skipped ${line}`)
}

/**
 * Clear every top-level id-targeted `llm-deepseek` row of the profile's patch
 * layer, writing the file only when one changed.
 * @param patchPath - the profile's `cordis.patch.yml`.
 * @param run - extended with what this found.
 * @throws when the file exists and cannot be read or replaced.
 */
function clearProfileTables(patchPath: string, run: Run): void {
  if (!existsSync(patchPath)) return
  const document = parseDocument(readFileSync(patchPath, 'utf8'), PATCH_PARSE_OPTIONS)
  if (document.errors[0] !== undefined || !isSeq(document.contents)) {
    skip(`${PROFILE_PATCH_FILENAME}: not a YAML sequence this shell can edit`, run)
    return
  }
  let changed = false
  for (const item of document.contents.items) {
    if (!isMap(item) || item.has('insert')) continue
    const id: unknown = item.get('id')
    if (id !== LLM_DEEPSEEK) continue
    const config: unknown = item.get('config', true)
    if (isMap(config) && clearTable(config, PROFILE_PATCH_FILENAME, run)) changed = true
  }
  if (changed) writeAtomic(patchPath, document.toString(), PRIVATE_FILE_MODE)
}

/**
 * Clear the `llm-deepseek` section of the `settings.yaml` the server is about
 * to import, and take the section out when nothing is left in it.
 * @param settingsPath - `$DSH_HOME/settings.yaml`.
 * @param run - extended with what this found.
 * @throws when the file exists and cannot be read or replaced.
 */
function clearSettingsTable(settingsPath: string, run: Run): void {
  if (!existsSync(settingsPath)) return
  const document = parseDocument(readFileSync(settingsPath, 'utf8'))
  if (document.errors[0] !== undefined || !isMap(document.contents)) {
    skip(`${SETTINGS_FILENAME}: not a YAML mapping of sections`, run)
    return
  }
  const section: unknown = document.get(LLM_DEEPSEEK, true)
  if (!isMap(section) || !clearTable(section, SETTINGS_FILENAME, run)) return
  if (section.items.length === 0) document.delete(LLM_DEEPSEEK)
  writeAtomic(settingsPath, document.toString(), PRIVATE_FILE_MODE)
}
