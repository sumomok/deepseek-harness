/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'
import {
  Config as TelemetryConfig,
  DEFAULT_TELEMETRY_MODE,
  SessionTelemetryMode,
} from '@deepseek-ai/dsh-session-telemetry-otel'
import { Config as SessionLogConfig } from '@deepseek-ai/dsh-session-log-deepseek'

/** One row of the shipped base patch, as the loader's entry schema parses it. */
interface PatchRow {
  id?: string
  config?: Record<string, unknown>
  disabled?: boolean
}

/**
 * Read the rows of the shipped `dsh-base` patch file.
 * @returns every insert row, in file order.
 */
function patchRows(): PatchRow[] {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const parsed = yaml.load(
    readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
    { schema: entryListSchema },
  )
  return (parsed as { insert?: PatchRow[] }[]).flatMap(patch => patch.insert ?? [])
}

describe('dsh-base bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    // The base layer is one insert list over the empty profile root, and
    // `patchRows()` reads the same file the manifest field names.
    const rows = patchRows()
    expect(rows.length).toBeGreaterThan(50)
    expect(rows.some(row => row.id === 'agent-loop')).toBe(true)
    expect(rows.find(row => row.id === 'session-telemetry-otel')).toMatchObject({
      disabled: true,
      config: { mode: { __jsExpr: "process.env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'" } },
    })
    // This fork product sends no session telemetry and reports no
    // installed-plugin inventory to DeepSeek; both rows stay declared,
    // disabled, so a `disabled: true` row's own Cordis semantics — its
    // `apply()` never runs — is this product's only telemetry off-switch that
    // needs no environment variable to take effect.
    expect(rows.find(row => row.id === 'plugin-package-inventory-deepseek')).toMatchObject({
      disabled: true,
    })
    // The third DeepSeek-bound path answers to the plugin's own schema field,
    // so this row carries `enabled: false`.
    expect(rows.find(row => row.id === 'session-log-deepseek')).toMatchObject({
      config: { enabled: false },
    })
    expect(rows.find(row => row.id === 'hmr')).toMatchObject({
      config: { root: [] },
    })
    expect(rows.filter(row => row.id === 'subagent-codex')).toHaveLength(0)
    expect(rows.filter(row => row.id === 'subagent-claude-code')).toHaveLength(0)
    expect(rows.find(row => row.id === 'web')?.config).toMatchObject({ fetchProvider: 'http' })
    expect(rows.find(row => row.id === 'web-fetch-http')).toBeDefined()
    expect(rows.find(row => row.id === 'tool-web')?.config).toMatchObject({ fetch: true })
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-subagent-codex')
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-subagent-claude-code')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-web-fetch-http')
  })

  it('gates each shell stack by platform with a symmetric disabled expression', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const parsed = yaml.load(
      readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(parsed)) throw new TypeError('base patch must parse to a patch list')
    const rows = parsed.flatMap((patch): Record<string, unknown>[] =>
      typeof patch === 'object' && patch !== null
        ? (patch as { insert?: Record<string, unknown>[] }).insert ?? []
        : [],
    )
    // Symmetric gating: each stack's executor and tool rows carry the same
    // platform fact, inverted between the bash and pwsh twins, so exactly one
    // shell stack mounts per host. Evaluate with a platform-scoped context
    // (the `with` scope shadows the global `process`) so both outcomes pin on
    // every host.
    for (const [id, win32, linux] of [
      ['bash-sandbox', true, false],
      ['tool-bash', true, false],
      ['pwsh-sandbox', false, true],
      ['tool-pwsh', false, true],
    ] as const) {
      const row = rows.find(candidate => candidate.id === id)
      if (row === undefined) throw new Error(`base patch must mount ${id}`)
      const expression = (row.disabled as { __jsExpr?: string } | undefined)?.__jsExpr
      if (expression === undefined) throw new Error(`${id} must gate on a !!js disabled expression`)
      expect(Boolean(evaluate({ process: { platform: 'win32' } }, expression)), `${id} on win32`).toBe(win32)
      expect(Boolean(evaluate({ process: { platform: 'linux' } }, expression)), `${id} on linux`).toBe(linux)
    }
    // The platform layer folded into these rows: no separate patch file ships.
    expect(existsSync(resolve(root, 'windows.cordis.patch.yml'))).toBe(false)
  })

  it('keeps each DeepSeek-bound reporter off through a switch that holds, never through a mode', () => {
    // `mode` selects a capture policy, never on or off: the two the plugin
    // accepts both deliver, and an omitted one resolves to FEEDBACK_ONLY, so
    // the shipped `!!js` expression cannot express this product's answer.
    // `disabled: true` above is what keeps `apply()` from running at all, and
    // it holds whatever DSH_TELEMETRY_MODE says.
    expect([...Object.values(SessionTelemetryMode)].sort())
      .toEqual(['DISABLED', 'FEEDBACK_ONLY'])
    expect(DEFAULT_TELEMETRY_MODE).toBe(SessionTelemetryMode.FEEDBACK_ONLY)
    expect(TelemetryConfig({}).mode).toBe(SessionTelemetryMode.FEEDBACK_ONLY)
    // The third DeepSeek-bound path ships on by its own schema default, so the
    // off-switch that reaches it is the row's `config`, resolved here through
    // that same schema.
    expect(SessionLogConfig({}).enabled).toBe(true)
    const sessionLog = patchRows().find(row => row.id === 'session-log-deepseek')
    expect(SessionLogConfig(sessionLog?.config).enabled).toBe(false)
  })
})
