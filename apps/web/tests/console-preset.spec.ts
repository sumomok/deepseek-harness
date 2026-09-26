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
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { CONSOLE_PRESET } from './content-column.ts'
import { REPO_ROOT } from './support.ts'

/** The console bundle's own patch file. */
const CONSOLE_PATCH = join(REPO_ROOT, 'packages/experimental/console-profile/cordis.patch.yml')

interface PresetRow {
  id?: string
  name?: string
  config?: { id?: unknown; plugins?: unknown }
  insert?: PresetRow[]
}

/**
 * The `preset-console` row the console bundle inserts.
 * @returns the row, or `undefined` when the patch declares none.
 */
function shippedRow(): PresetRow | undefined {
  const parsed = yaml.load(readFileSync(CONSOLE_PATCH, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error(`composition file at ${CONSOLE_PATCH} must be a list`)
  return (parsed as PresetRow[]).flatMap(row => row.insert ?? []).find(row => row.id === 'preset-console')
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
