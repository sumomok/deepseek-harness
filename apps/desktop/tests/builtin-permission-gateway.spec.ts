/**
 * The permission gateway's bundle layer over the one `@deepseek-ai/dsh-base`
 * composes: the `permission` row a desktop profile ends up with, read from the
 * tarball this repository ships rather than from a description of it.
 *
 * An id-targeted patch replaces the target row's whole `config`, so the
 * gateway's layer restates dsh-base's preset table to add one entry to it. That
 * restated copy is what goes stale when a base release changes a preset, and
 * composing both layers here is what catches it: the three base presets are
 * compared against what dsh-base alone composes, never against a literal.
 * @module
 */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadOverlayPatches, resolveBundleDir } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'
import { BUILTIN_WEB_BUNDLES } from '../src/profile-seed.ts'

/** The bundle under test, which is also the package the payload vendors. */
const GATEWAY = '@haoran/dsh-llm-permission-gateway'

/** One preset's knob bundle and optional client presentation, as the table carries it. */
interface PresetSpec {
  sandbox: string
  approval: string
  name?: string
  description?: string
  glyph?: string
}

/** The composed-entry fields these cases read. */
interface Entry {
  id?: string
  config?: Record<string, unknown>
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
// The deploy root whose closure becomes the payload's `server/node_modules`,
// which is the installation anchor the shipped Loader resolves bundles from.
const installAnchor = join(repoRoot, 'apps', 'desktop-server', 'package.json')
const basePatchPath = join(repoRoot, 'packages', 'bundle', 'base', 'cordis.patch.yml')

const gatewayDir = resolveBundleDir('test', GATEWAY, installAnchor, join(repoRoot, 'apps', 'desktop-server'))
const basePatches = loadOverlayPatches('test', basePatchPath)
const gatewayPatches = loadOverlayPatches('test', join(gatewayDir, 'cordis.patch.yml'))

/** One composed entry by id; absent ids throw rather than returning undefined into an expectation. */
function entry(entries: Entry[], id: string): Entry {
  const found = entries.find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`composed no entry with id ${id}`)
  return found
}

/** The preset table of one composed entry list. */
function presetsOf(entries: Entry[]): Record<string, PresetSpec> {
  return entry(entries, 'permission').config?.['presets'] as Record<string, PresetSpec>
}

/** The preset a session is pinned to for one knob pair: the first table entry that matches, in declaration order. */
function firstMatch(sandbox: string, approval: string): string {
  const found = Object.entries(presets).find(([, spec]) => spec.sandbox === sandbox && spec.approval === approval)
  return found?.[0] ?? 'custom'
}

const baseOnly = composeEntries([basePatches]) as Entry[]
const withGateway = composeEntries([basePatches, gatewayPatches]) as Entry[]
const presets = presetsOf(withGateway)

describe('the desktop payload', () => {
  it('seeds the gateway bundle, so the layer below is one a launch applies', () => {
    expect(BUILTIN_WEB_BUNDLES).toContain(GATEWAY)
  })

  it('resolves the bundle from the deploy root that becomes the payload', () => {
    expect(gatewayDir).toContain(join('apps', 'desktop-server'))
  })
})

describe('the composed preset table', () => {
  it('leaves every dsh-base preset exactly as dsh-base composes it', () => {
    const base = presetsOf(baseOnly)
    for (const [name, spec] of Object.entries(base)) {
      expect(presets[name]).toEqual(spec)
    }
  })

  it('adds yolo-access after them, and nothing else', () => {
    expect(Object.keys(presets)).toEqual([...Object.keys(presetsOf(baseOnly)), 'yolo-access'])
  })

  it('says in the picker what selecting it gives up, under the full-access shield', () => {
    expect(presets['yolo-access']).toEqual({
      sandbox: 'danger-full-access',
      approval: 'ask',
      name: '自动审查',
      description: expect.stringContaining('沙箱完全关闭') as string,
      glyph: 'danger-full-access',
    })
  })

  it('gives every preset its own knob pair, so each one stays nameable', () => {
    // The permission service resolves a preset by looking its knob values up in
    // this table: two entries sharing a pair both resolve to `custom`, which no
    // client can select.
    const pairs = Object.values(presets).map(spec => `${spec.sandbox}/${spec.approval}`)
    expect(new Set(pairs).size).toBe(pairs.length)
  })
})

describe('yolo-access is offered, never imposed', () => {
  it('leaves defaultPreset unset, so the default stays the one the knobs infer', () => {
    expect(Object.keys(entry(withGateway, 'permission').config ?? {})).toEqual(['presets'])
  })

  it('is the first match for no knob pair dsh-base can compose', () => {
    // dsh-base derives both knobs from one `DSH_PERMISSION_MODE` expression, so
    // the pairs its composition can produce are exactly these: the mode with
    // `ask` while it is not `danger-full-access`, and `danger-full-access` with
    // `never`. The permission service pins a fresh session to the first table
    // entry matching the effective pair, in declaration order, so this is the
    // whole domain a default can come from — and a build that turned the
    // sandbox off silently would be one that landed on yolo-access from it.
    expect(firstMatch('read-only', 'ask')).toBe('read-only')
    expect(firstMatch('workspace-write', 'ask')).toBe('workspace-write')
    expect(firstMatch('danger-full-access', 'never')).toBe('danger-full-access')
  })

  it('is reachable only by an explicit pick', () => {
    // The one pair that selects it needs the sandbox off and approval still on,
    // which no value of DSH_PERMISSION_MODE produces.
    expect(firstMatch('danger-full-access', 'ask')).toBe('yolo-access')
  })
})

describe('the gate row', () => {
  it('is inserted with a judge route of its own', () => {
    expect(entry(withGateway, 'llm-permission-gateway').config).toMatchObject({
      provider: expect.any(String) as string,
      model: expect.any(String) as string,
    })
  })
})
