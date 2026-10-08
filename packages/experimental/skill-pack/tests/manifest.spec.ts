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

  it('lists every key the manifest schema reads, with the two that must be present and what each value must be', () => {
    expect(PACK_MANIFEST_FIELDS).toEqual([
      { path: 'pack.version', required: true, summary: 'an exact semantic version, such as 1.0.0' },
      { path: 'pack.platform', required: false, summary: 'a semantic-version range, such as >=0.2.0' },
      { path: 'pack.viewFormat', required: false, summary: 'an integer' },
      { path: 'pack.anchorFormat', required: false, summary: 'an integer' },
      {
        path: 'requires.components',
        required: false,
        summary: 'a mapping from a package name, a non-empty string, to a semantic-version range',
      },
      { path: 'requires.parts', required: false, summary: 'a list of part ids, each a non-empty string' },
      { path: 'views', required: false, summary: 'a list of view file paths inside the pack, each a non-empty string' },
    ])
  })

  it('refuses a value of another kind than each field\'s summary states, naming the field', () => {
    /** A manifest stating the required version and the given dotted field set to the value. */
    const setting = (path: string, value: unknown): Record<string, unknown> => {
      const [head, leaf] = path.split('.') as [string, string | undefined]
      const pack = { version: '1.0.0' }
      if (head === 'pack' && leaf !== undefined) return { pack: { ...pack, [leaf]: value } }
      return leaf === undefined ? { pack, [head]: value } : { pack, [head]: { [leaf]: value } }
    }
    const refusing: Readonly<Record<string, readonly unknown[]>> = {
      'pack.version': ['1.0', '>=1.0.0', 1],
      'pack.platform': ['not a range', 1],
      'pack.viewFormat': [1.5, '1'],
      'pack.anchorFormat': [1.5, '1'],
      'requires.components': [['@a/b'], { '': '>=1.0.0' }, { '@a/b': 'not a range' }],
      'requires.parts': ['toy.data-page', [''], [1]],
      views: ['views/a.yml', [''], [1]],
    }
    expect(Object.keys(refusing)).toEqual(PACK_MANIFEST_FIELDS.map(field => field.path))
    for (const [path, values] of Object.entries(refusing)) {
      expect(parsePackManifest(setting(path, VALUES[path])), path).toMatchObject({ ok: true })
      for (const value of values) {
        const result = parsePackManifest(setting(path, value))
        expect(!result.ok && result.field.startsWith(`metadata.${path}`), `${path}: ${JSON.stringify(value)}`).toBe(true)
      }
    }
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
