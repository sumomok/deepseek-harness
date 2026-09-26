/**
 * Checks the packaging pipeline runs on what a boot of the staged server
 * printed and on the profile composition it resolved.
 *
 * A server that prints its URL line has not proved its profile composed: a
 * `dsh.profile.bundles` name the Loader cannot resolve, or whose DSH peers the
 * runtime refuses, is skipped with one stderr line and the boot goes on without
 * that bundle's layer. A refused plugin row is disabled the same way, and an
 * entry that fails to start is reported in a warning while its siblings keep
 * running. These functions turn those lines, and the composed tree
 * `--dump-config` prints, into build failures.
 * @module
 */

import yaml from 'js-yaml'

/**
 * The stderr fragments a profile boot writes when it leaves part of the
 * composition out while still starting: a skipped bundle
 * (`<bin>: skipping profile bundle "<name>": <reason>`), a refused plugin row
 * (`<bin>: disabling profile plugin …`), and entries that did not start
 * (`<bin>: warning: <n> entries did not activate`).
 */
export const LOAD_FAILURE_MARKERS = ['skipping profile bundle', 'disabling profile plugin', 'did not activate'] as const

/** The row the desktop composition layer opens full-text search on, and the value it sets. */
const DESKTOP_LAYER_PROBE = { id: 'session-query-sqlite', openAt: 'first-search' } as const

/**
 * The lines of a boot's stderr that report a bundle, row, or entry the boot
 * went on without.
 * @param stderr - everything the server wrote to stderr.
 * @returns the offending lines, in order; empty when the composition loaded whole.
 */
export function loadFailureLines(stderr: string): string[] {
  return stderr.split(/\r?\n/).filter(line => LOAD_FAILURE_MARKERS.some(marker => line.includes(marker)))
}

/** The `!!js` dialect a config dump prints, read back as an opaque expression. */
const DUMP_SCHEMA = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (source: string) => ({ __jsExpr: source }) }),
])

/**
 * Whether one parsed YAML value is a mapping.
 * @param value - one parsed YAML node.
 * @returns true for a mapping, false for a scalar, a sequence, or null.
 */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Find a row by id, descending into group rows the way the Loader's patch
 * index does: a row is a group when `group` is true and its `config` is an
 * entry list.
 * @param rows - one parsed entry list.
 * @param id - the row id.
 * @returns the row, or undefined when no row at any depth has that id.
 */
function findRow(rows: readonly unknown[], id: string): Record<string, unknown> | undefined {
  for (const row of rows) {
    if (!isMapping(row)) continue
    if (row['id'] === id) return row
    const children = row['config']
    if (row['group'] === true && Array.isArray(children)) {
      const nested = findRow(children, id)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * Check that a desktop profile's composed tree carries the desktop composition
 * layer.
 *
 * `@deepseek-ai/dsh-desktop-app` is the last bundle the profile names, and the
 * one row every layer below leaves at `openAt: never` is the full-text search
 * row it opens at `first-search`. The row is looked up in what
 * `dsh --profile <name> --dump-config` printed, which composes the same bundle
 * list the boot resolved.
 * @param dump - the stdout of `--dump-config`.
 * @throws when the dump is not an entry list, has no such row, or the row is disabled or not opened at the first search.
 */
export function verifyDesktopLayer(dump: string): void {
  const parsed: unknown = yaml.load(dump, { schema: DUMP_SCHEMA })
  if (!Array.isArray(parsed)) throw new Error('package: --dump-config printed no entry list.')
  const { id, openAt } = DESKTOP_LAYER_PROBE
  const row = findRow(parsed, id)
  if (row === undefined) throw new Error(`package: the composed desktop profile has no ${id} row.`)
  const config = row['config']
  const composed = isMapping(config) ? config['openAt'] : undefined
  if (row['disabled'] !== undefined || composed !== openAt) {
    throw new Error(
      `package: the composed ${id} row is not the desktop layer's (openAt ${JSON.stringify(composed)}, disabled ${JSON.stringify(row['disabled'])}); `
      + '@deepseek-ai/dsh-desktop-app did not reach the profile.',
    )
  }
}
