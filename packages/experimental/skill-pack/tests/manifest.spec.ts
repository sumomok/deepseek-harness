/**
 * What a pack's `metadata` object has to say before the pack is one, and what
 * the refusal names when it does not.
 */

import { describe, expect, it } from 'vitest'
import {
  anchorFormatMissing,
  PACK_ANCHOR_FORMATS,
  PACK_MANIFEST_FIELDS,
  PACK_VIEW_FORMATS,
  parsePackManifest,
  readsDeclaredViews,
  viewFormatMissing,
} from '../src/manifest.ts'
import { describeMissing } from '../src/reconcile.ts'
import type { PackManifest } from '../src/types.ts'

/** One parsed manifest, for the two reads that answer from a manifest rather than from an object. */
function manifest(pack: PackManifest['pack'], views: readonly string[] = []): PackManifest {
  return { pack, requires: { components: {}, parts: [] }, views }
}

describe('pack manifest', () => {
  it('reads a complete manifest and fills the requirements a pack left out', () => {
    const complete = parsePackManifest({
      pack: { version: '1.0.0', platform: '>=0.5.0', viewFormat: 1 },
      requires: { components: { '@deepseek-ai/dsh-experimental-component-kit': '>=0.3.0' }, parts: ['toy.data-page'] },
      views: ['views/space-layer.yml'],
    })
    expect(complete).toEqual({
      ok: true,
      manifest: {
        pack: { version: '1.0.0', platform: '>=0.5.0', viewFormat: 1 },
        requires: { components: { '@deepseek-ai/dsh-experimental-component-kit': '>=0.3.0' }, parts: ['toy.data-page'] },
        views: ['views/space-layer.yml'],
      },
    })

    const bare = parsePackManifest({ pack: { version: '0.1.0' } })
    expect(bare).toEqual({
      ok: true,
      manifest: { pack: { version: '0.1.0' }, requires: { components: {}, parts: [] }, views: [] },
    })

    const halfFilled = parsePackManifest({ pack: { version: '0.1.0' }, requires: { parts: ['toy.data-page'] } })
    expect(halfFilled).toEqual({
      ok: true,
      manifest: { pack: { version: '0.1.0' }, requires: { components: {}, parts: ['toy.data-page'] }, views: [] },
    })
  })

  it('names the field that refused the manifest', () => {
    expect(parsePackManifest(undefined)).toMatchObject({ ok: false, field: 'metadata' })
    expect(parsePackManifest({})).toMatchObject({ ok: false, field: 'metadata.pack' })
    expect(parsePackManifest({ pack: { version: 'one' } })).toEqual({
      ok: false,
      field: 'metadata.pack.version',
      reason: 'must be an exact semantic version',
    })
    expect(parsePackManifest({ pack: { version: '1.0.0', platform: 'newest' } })).toEqual({
      ok: false,
      field: 'metadata.pack.platform',
      reason: 'must be a semantic-version range',
    })
    expect(parsePackManifest({ pack: { version: '1.0.0' }, requires: { components: { kit: 'newest' } } })).toEqual({
      ok: false,
      field: 'metadata.requires.components.kit',
      reason: 'must be a semantic-version range',
    })
    expect(parsePackManifest({ pack: { version: '1.0.0' }, requires: { parts: [''] } }))
      .toMatchObject({ ok: false, field: 'metadata.requires.parts.0' })
    expect(parsePackManifest({ pack: { version: '1.0.0' }, views: [7] }))
      .toMatchObject({ ok: false, field: 'metadata.views.0' })
    expect(parsePackManifest({ pack: { version: '1.0.0', viewFormat: '1' } }))
      .toMatchObject({ ok: false, field: 'metadata.pack.viewFormat' })
    expect(parsePackManifest({ pack: { version: '1.0.0', viewFormat: 1.5 } }))
      .toMatchObject({ ok: false, field: 'metadata.pack.viewFormat' })
  })

  it('refuses a key it does not know, so a misspelled requirement is not a requirement dropped', () => {
    expect(parsePackManifest({ pack: { version: '1.0.0' }, require: { parts: ['toy.data-page'] } }))
      .toMatchObject({ ok: false, field: 'metadata.require' })
    expect(parsePackManifest({ pack: { version: '1.0.0', platfrom: '>=1.0.0' } }))
      .toMatchObject({ ok: false, field: 'metadata.pack.platfrom' })
    expect(parsePackManifest({ pack: { version: '1.0.0' }, requires: { part: ['toy.data-page'] } }))
      .toMatchObject({ ok: false, field: 'metadata.requires.part' })
  })
})

describe('the manifest fields a pack may state', () => {
  /** A value each listed field accepts. */
  const VALUES: Readonly<Record<string, unknown>> = {
    'pack.version': '1.0.0',
    'pack.platform': '>=0.5.0',
    'pack.viewFormat': 1,
    'pack.anchorFormat': 1,
    'requires.components': { '@deepseek-ai/dsh-experimental-component-kit': '>=0.2.0' },
    'requires.parts': ['toy.data-page'],
    views: ['views/a.yml'],
  }

  /** The manifest object stating exactly the given dotted fields. */
  function stating(paths: readonly string[]): Record<string, unknown> {
    const metadata: Record<string, unknown> = {}
    const objects: Record<string, Record<string, unknown>> = {}
    for (const path of paths) {
      const [head, leaf] = path.split('.') as [string, string | undefined]
      if (leaf === undefined) {
        metadata[head] = VALUES[path]
      } else {
        objects[head] = { ...objects[head], [leaf]: VALUES[path] }
        metadata[head] = objects[head]
      }
    }
    return metadata
  }

  it('lists every key the manifest schema reads, with the two that must be present', () => {
    expect(PACK_MANIFEST_FIELDS).toEqual([
      { path: 'pack.version', required: true },
      { path: 'pack.platform', required: false },
      { path: 'pack.viewFormat', required: false },
      { path: 'pack.anchorFormat', required: false },
      { path: 'requires.components', required: false },
      { path: 'requires.parts', required: false },
      { path: 'views', required: false },
    ])
  })

  it('accepts a manifest stating every listed field, and one stating only the required ones', () => {
    expect(parsePackManifest(stating(PACK_MANIFEST_FIELDS.map(field => field.path)))).toMatchObject({ ok: true })
    expect(parsePackManifest(stating(PACK_MANIFEST_FIELDS.filter(field => field.required).map(field => field.path))))
      .toMatchObject({ ok: true })
  })

  it('refuses a manifest leaving out a required field, naming it', () => {
    for (const field of PACK_MANIFEST_FIELDS.filter(one => one.required)) {
      const others = PACK_MANIFEST_FIELDS.map(one => one.path).filter(path => path !== field.path)
      expect(parsePackManifest(stating(others))).toMatchObject({ ok: false, field: `metadata.${field.path}` })
    }
  })
})

describe('the view-file format a manifest states', () => {
  it('reads the views of a pack that states a format this build reads', () => {
    expect(PACK_VIEW_FORMATS).toEqual([1])
    expect(readsDeclaredViews(manifest({ version: '1.0.0', viewFormat: 1 }, ['views/a.yml']))).toBe(true)
  })

  it('reads the views of a pack that declares none, whatever it states about the format', () => {
    expect(readsDeclaredViews(manifest({ version: '1.0.0' }))).toBe(true)
    expect(readsDeclaredViews(manifest({ version: '1.0.0', viewFormat: 7 }))).toBe(true)
  })

  it('reads the views of no pack that states a format this build does not, or states none', () => {
    expect(readsDeclaredViews(manifest({ version: '1.0.0', viewFormat: 7 }, ['views/a.yml']))).toBe(false)
    expect(readsDeclaredViews(manifest({ version: '1.0.0' }, ['views/a.yml']))).toBe(false)
  })

  it('names what the pack stated and what this build reads, and says nothing about a format nobody stated', () => {
    expect(viewFormatMissing(manifest({ version: '1.0.0', viewFormat: 7 }, ['views/a.yml'])))
      .toEqual({ kind: 'view-format', stated: 7, reads: [1] })
    expect(viewFormatMissing(manifest({ version: '1.0.0' }, ['views/a.yml'])))
      .toEqual({ kind: 'view-format', reads: [1] })
  })
})

describe('the anchor format a manifest states', () => {
  it('reads the anchor format written beside the view format', () => {
    expect(parsePackManifest({ pack: { version: '1.0.0', viewFormat: 1, anchorFormat: 1 }, views: ['views/a.yml'] })).toEqual({
      ok: true,
      manifest: {
        pack: { version: '1.0.0', viewFormat: 1, anchorFormat: 1 },
        requires: { components: {}, parts: [] },
        views: ['views/a.yml'],
      },
    })
  })

  it('judges a pack stating an anchor format this build reads, and a pack stating none, as usual', () => {
    expect(PACK_ANCHOR_FORMATS).toEqual([1])
    expect(anchorFormatMissing(manifest({ version: '1.0.0', anchorFormat: 1 }))).toBeUndefined()
    expect(anchorFormatMissing(manifest({ version: '1.0.0' }))).toBeUndefined()
  })

  it('names the format a pack states and the formats this build reads when it is 2, 0 or -1', () => {
    for (const stated of [2, 0, -1]) {
      const missing = anchorFormatMissing(manifest({ version: '1.0.0', anchorFormat: stated }))
      expect(missing).toEqual({ kind: 'anchor-format', stated, reads: [1] })
      expect(missing === undefined ? undefined : describeMissing(missing))
        .toBe(`states anchor format ${String(stated)}; this build reads 1`)
    }
  })

  it('refuses an anchor format that is not an integer, naming its field and the type it must be', () => {
    expect(parsePackManifest({ pack: { version: '1.0.0', anchorFormat: 1.5 } })).toEqual({
      ok: false,
      field: 'metadata.pack.anchorFormat',
      reason: 'Invalid input: expected int, received number',
    })
    expect(parsePackManifest({ pack: { version: '1.0.0', anchorFormat: '1' } })).toEqual({
      ok: false,
      field: 'metadata.pack.anchorFormat',
      reason: 'Invalid input: expected number, received string',
    })
  })
})
