/**
 * The projection unit on its own, driven with hand-built state the registry
 * would never produce today: a record whose kind has left the table.
 *
 * That case is what a persisted checkpoint written under a wider composition
 * looks like after the kind row is removed, and the whole point of deriving
 * `stateVersion` from the table is that such a row is discarded rather than
 * served — this file pins what the fold does if one reaches it anyway.
 */

import { describe, expect, it } from 'vitest'
import { contentSurfaceProjection } from '../src/projection.ts'
import { eraseExtractor, foldVersion } from '../src/extractor.ts'
import type { ContentSurfaceRecord } from '../src/types.ts'

/** An extractor recognizing nothing, so only its `resolve` and identity matter here. */
const alpha = eraseExtractor({
  kind: 'alpha',
  dataVersion: 1,
  read: () => undefined,
  resolve: (data: string) => ({ title: `alpha:${data}`, payload: data }),
})

const beta = eraseExtractor({
  kind: 'beta',
  dataVersion: 1,
  read: () => undefined,
  resolve: (data: string) => ({ title: `beta:${data}`, payload: data }),
})

/** Records as a checkpoint written under a wider table would carry them. */
const STATE: ContentSurfaceRecord[] = [
  { kind: 'alpha', entryId: 'one', seq: 2, data: 'one' },
  { kind: 'beta', entryId: 'two', seq: 5, data: 'two' },
]

describe('contentSurface projection', () => {
  it('drops a record whose kind has left the table rather than serving half an entry', () => {
    const unit = contentSurfaceProjection([alpha])
    expect(unit.wire.view(STATE)).toEqual({
      entries: [{ kind: 'alpha', entryId: 'one', seq: 2, title: 'alpha:one', payload: 'one' }],
    })
  })

  it('serves every record whose kind is still registered, newest first', () => {
    const unit = contentSurfaceProjection([alpha, beta])
    expect(unit.wire.view(STATE).entries.map(entry => entry.title)).toEqual(['beta:two', 'alpha:one'])
  })

  it('accepts the state schema over a checkpoint\'s own JSON', () => {
    expect(contentSurfaceProjection([alpha]).stateSchema.parse(STATE)).toEqual(STATE)
  })
})

describe('foldVersion', () => {
  it('is a non-negative safe integer the projection registry accepts', () => {
    const version = foldVersion([alpha, beta])
    expect(Number.isSafeInteger(version) && version >= 0).toBe(true)
  })

  it('ignores the order the table was registered in', () => {
    expect(foldVersion([alpha, beta])).toBe(foldVersion([beta, alpha]))
  })

  it('changes when a kind joins, leaves, or changes its stored shape', () => {
    const bumped = eraseExtractor({ kind: 'beta', dataVersion: 2, read: () => undefined, resolve: () => ({ title: '', payload: null }) })
    expect(new Set([foldVersion([alpha]), foldVersion([alpha, beta]), foldVersion([alpha, bumped])]).size).toBe(3)
  })
})
