/**
 * What a pack's `metadata` object has to say before the pack is one, and what
 * the refusal names when it does not.
 */

import { describe, expect, it } from 'vitest'
import { parsePackManifest } from '../src/manifest.ts'

describe('pack manifest', () => {
  it('reads a complete manifest and fills the requirements a pack left out', () => {
    const complete = parsePackManifest({
      pack: { version: '1.0.0', platform: '>=0.5.0' },
      requires: { components: { '@deepseek-ai/dsh-experimental-component-kit': '>=0.3.0' }, parts: ['toy.crud'] },
      views: ['views/space-layer.yml'],
    })
    expect(complete).toEqual({
      ok: true,
      manifest: {
        pack: { version: '1.0.0', platform: '>=0.5.0' },
        requires: { components: { '@deepseek-ai/dsh-experimental-component-kit': '>=0.3.0' }, parts: ['toy.crud'] },
        views: ['views/space-layer.yml'],
      },
    })

    const bare = parsePackManifest({ pack: { version: '0.1.0' } })
    expect(bare).toEqual({
      ok: true,
      manifest: { pack: { version: '0.1.0' }, requires: { components: {}, parts: [] }, views: [] },
    })

    const halfFilled = parsePackManifest({ pack: { version: '0.1.0' }, requires: { parts: ['toy.crud'] } })
    expect(halfFilled).toEqual({
      ok: true,
      manifest: { pack: { version: '0.1.0' }, requires: { components: {}, parts: ['toy.crud'] }, views: [] },
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
  })

  it('refuses a key it does not know, so a misspelled requirement is not a requirement dropped', () => {
    expect(parsePackManifest({ pack: { version: '1.0.0' }, require: { parts: ['toy.crud'] } }))
      .toMatchObject({ ok: false, field: 'metadata.require' })
    expect(parsePackManifest({ pack: { version: '1.0.0', platfrom: '>=1.0.0' } }))
      .toMatchObject({ ok: false, field: 'metadata.pack.platfrom' })
    expect(parsePackManifest({ pack: { version: '1.0.0' }, requires: { part: ['toy.crud'] } }))
      .toMatchObject({ ok: false, field: 'metadata.requires.part' })
  })
})
