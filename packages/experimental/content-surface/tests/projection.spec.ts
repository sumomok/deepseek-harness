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
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
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

/**
 * Like `alpha`, but recognizes a fake event type under a fixed entry id —
 * used only to prove resurrection re-reads through `read`, not through
 * hand-built state. Typed against a plain string, not a literal, since this
 * fixture's own event type is not a real registered `SessionEventType`
 * (mirrors `registry.spec.ts`'s own `fakeExtractor`).
 */
const ALPHA_SHOWN = 'alpha/shown'
const alphaRecognizing = eraseExtractor({
  kind: 'alpha',
  dataVersion: 1,
  read: (event: SessionEvent) => ((event.type as string) === ALPHA_SHOWN ? { entryId: 'one', data: (event.data as { id: string }).id } : undefined),
  resolve: (data: string) => ({ title: `alpha:${data}`, payload: data }),
})

/** Records as a checkpoint written under a wider table would carry them. */
const STATE: ContentSurfaceRecord[] = [
  { kind: 'alpha', entryId: 'one', seq: 2, data: 'one' },
  { kind: 'beta', entryId: 'two', seq: 5, data: 'two' },
]

/** One dismissal event, as the fold receives it. */
function dismissal(kind: string, entryId: string, seq: number): SessionEvent {
  return { type: 'content-surface/dismissed', seq, time: 0, data: { kind, entryId, by: 'user' } }
}

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

  it('removes the record a dismissal names, leaving every other one untouched', () => {
    const unit = contentSurfaceProjection([alpha, beta])
    const next = unit.apply(STATE, dismissal('alpha', 'one', 9))
    expect(next).toEqual([{ kind: 'beta', entryId: 'two', seq: 5, data: 'two' }])
  })

  it('is a no-op fold when the dismissed pair is already gone, not an error', () => {
    const unit = contentSurfaceProjection([alpha, beta])
    const next = unit.apply(STATE, dismissal('alpha', 'never-shown', 9))
    expect(next).toBe(STATE)
  })

  it('resurrects a dismissed-then-redrawn pair as an ordinary fresh record', () => {
    const unit = contentSurfaceProjection([alphaRecognizing])
    const afterDismissal = unit.apply(STATE, dismissal('alpha', 'one', 9))
    expect(unit.wire.view(afterDismissal).entries).toEqual([])
    const resurrected = unit.apply(afterDismissal, { type: ALPHA_SHOWN, seq: 10, time: 0, data: { id: 'again' } } as SessionEvent)
    expect(unit.wire.view(resurrected).entries).toEqual([{ kind: 'alpha', entryId: 'one', seq: 10, title: 'alpha:again', payload: 'again' }])
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
