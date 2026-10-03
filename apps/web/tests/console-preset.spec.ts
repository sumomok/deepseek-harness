/**
 * The console e2e lanes compose the `console` Agent preset from
 * `CONSOLE_PRESET` in `content-column.ts`, a restatement of the
 * `preset-console` row that `packages/experimental/console-profile/cordis.patch.yml`
 * ships. The two must declare the same preset: a persona sentence, a plugin
 * row, or a row's config that differs between them makes the recorded
 * scenarios exercise a preset no deployment runs.
 *
 * Only the fields both sides carry are compared: the row's `config.id` and
 * `config.plugins`. `name`, `description`, and `order` exist only on the test
 * definition, which the preset registry requires and the shipped row leaves to
 * its schema defaults.
 *
 * The same lanes compose `CONSOLE_PROMPT_OVERLAY`, which restates the bundle's
 * three rows that change the system prompt outside the presets: `web-runtime`'s
 * `surfaceContext`, the `ui-deliverables` disable, and the `system-prompt` row
 * without the harness identity sentence. Each must match the bundle's row, or
 * the pinned `web-content-console` prompt is one no console deployment sends.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { CONSOLE_PRESET, CONSOLE_PROMPT_OVERLAY } from './content-column.ts'
import { REPO_ROOT } from './support.ts'

/** The console bundle's own patch file. */
const CONSOLE_PATCH = join(REPO_ROOT, 'packages/experimental/console-profile/cordis.patch.yml')

interface PresetRow {
  id?: string
  name?: string
  disabled?: boolean
  config?: { id?: unknown; plugins?: unknown; surfaceContext?: unknown; includeHarnessIdentity?: unknown }
  insert?: PresetRow[]
}

/**
 * The rows of one composition file.
 * @param file - absolute path of the file.
 * @returns its top-level rows.
 */
function rowsOf(file: string): PresetRow[] {
  const parsed = yaml.load(readFileSync(file, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error(`composition file at ${file} must be a list`)
  return parsed as PresetRow[]
}

/**
 * The `preset-console` row the console bundle inserts.
 * @returns the row, or `undefined` when the patch declares none.
 */
function shippedRow(): PresetRow | undefined {
  return rowsOf(CONSOLE_PATCH).flatMap(row => row.insert ?? []).find(row => row.id === 'preset-console')
}

describe('the console e2e preset', () => {
  const row = shippedRow()

  it('restates a row the console bundle ships', () => {
    expect(row).toMatchObject({ name: '@deepseek-ai/dsh-agent-preset' })
  })

  it('declares the shipped preset id', () => {
    expect(row?.config?.id).toBe(CONSOLE_PRESET.id)
  })

  it('declares the shipped plugin rows, their names, and their config', () => {
    expect(CONSOLE_PRESET.plugins).toEqual(row?.config?.plugins)
  })
})

describe('the console e2e prompt layer', () => {
  const bundle = new Map(rowsOf(CONSOLE_PATCH).flatMap(entry => entry.id === undefined ? [] : [[entry.id, entry] as const]))
  const layer = rowsOf(CONSOLE_PROMPT_OVERLAY)

  it('patches only the web-runtime, ui-deliverables, and system-prompt rows', () => {
    expect(layer.map(entry => entry.id)).toEqual(['web-runtime', 'ui-deliverables', 'system-prompt'])
  })

  it('carries the bundle\'s surface-context choice', () => {
    const own = layer.find(entry => entry.id === 'web-runtime')
    expect(bundle.get('web-runtime')?.config?.surfaceContext).toBe(false)
    expect(own?.config?.surfaceContext).toBe(bundle.get('web-runtime')?.config?.surfaceContext)
  })

  it('disables ui-deliverables as the bundle does', () => {
    expect(bundle.get('ui-deliverables')?.disabled).toBe(true)
    expect(layer.find(entry => entry.id === 'ui-deliverables')?.disabled).toBe(true)
  })

  it('restates the bundle\'s system-prompt row, without the harness identity sentence', () => {
    expect(bundle.get('system-prompt')?.config?.includeHarnessIdentity).toBe(false)
    expect(layer.find(entry => entry.id === 'system-prompt')).toEqual(bundle.get('system-prompt'))
  })
})
