/**
 * What a pack's `metadata` object has to say before the pack is one, and what
 * the refusal names when it does not.
 */

import { describe, expect, it } from 'vitest'
import { PACK_VIEW_FORMATS, parsePackManifest, readsDeclaredViews, viewFormatMissing } from '../src/manifest.ts'
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
