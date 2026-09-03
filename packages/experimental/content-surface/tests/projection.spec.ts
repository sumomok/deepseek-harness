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
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import { contentSurfaceProjection } from '../src/projection.ts'
import { eraseExtractor, foldVersion } from '../src/extractor.ts'
import type { ContentSurfaceFold } from '../src/types.ts'

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
const STATE: ContentSurfaceFold = {
  records: [
    { kind: 'alpha', entryId: 'one', seq: 2, data: 'one' },
    { kind: 'beta', entryId: 'two', seq: 5, data: 'two' },
  ],
}

/** One dismissal event, as the fold receives it. */
function dismissal(kind: string, entryId: string, seq: number): SessionEvent {
  return { type: 'content-surface/dismissed', seq: SessionSeq(seq), time: 0, data: { kind, entryId, by: 'user' } }
}

/** One selection event, as the fold receives it. */
function selection(kind: string, entryId: string, seq: number): SessionEvent {
  return { type: 'content-surface/selected', seq: SessionSeq(seq), time: 0, data: { kind, entryId, by: 'user' } }
}

describe('contentSurface projection', () => {
  it('drops a record whose kind has left the table rather than serving half an entry', () => {
    const unit = contentSurfaceProjection([alpha])
    expect(unit.wire.view(STATE)).toEqual({
      entries: [{ kind: 'alpha', entryId: 'one', seq: 2, title: 'alpha:one', payload: 'one' }],
      front: { kind: 'alpha', entryId: 'one' },
    })
  })

  it('serves every record whose kind is still registered, newest first', () => {
    const unit = contentSurfaceProjection([alpha, beta])
    expect(unit.wire.view(STATE).entries.map(entry => entry.title)).toEqual(['beta:two', 'alpha:one'])
  })

  it('accepts the state schema over a checkpoint\'s own JSON, with and without a selection', () => {
    const unit = contentSurfaceProjection([alpha])
    expect(unit.stateSchema.parse(STATE)).toEqual(STATE)
    const selected = { ...STATE, selected: { kind: 'beta', entryId: 'two', seq: 7 } }
    expect(unit.stateSchema.parse(selected)).toEqual(selected)
    // Absent rather than present and undefined: the checkpoint is JSON, and
    // what leaves the schema is what a fresh fold would have produced.
    expect(Object.hasOwn(unit.stateSchema.parse(STATE), 'selected')).toBe(false)
  })

  it('removes the record a dismissal names, leaving every other one untouched', () => {
    const unit = contentSurfaceProjection([alpha, beta])
    const next = unit.apply(STATE, dismissal('alpha', 'one', 9))
    expect(next).toEqual({ records: [{ kind: 'beta', entryId: 'two', seq: 5, data: 'two' }] })
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

  it('carries a selection across a dismissal that removed another entry', () => {
    const unit = contentSurfaceProjection([alpha, beta])
    const chosen = unit.apply(STATE, selection('alpha', 'one', 9))
    const next = unit.apply(chosen, dismissal('beta', 'two', 10))
    expect(next).toEqual({
      records: [{ kind: 'alpha', entryId: 'one', seq: 2, data: 'one' }],
      selected: { kind: 'alpha', entryId: 'one', seq: 9 },
    })
  })

  it('keeps the same state reference for an event no case and no extractor claims', () => {
    const unit = contentSurfaceProjection([alpha, beta])
    expect(unit.apply(STATE, { type: 'turn/start', seq: SessionSeq(9), time: 0, data: { turn: 1 } })).toBe(STATE)
  })
})

describe('contentSurface front', () => {
  const unit = contentSurfaceProjection([alpha, beta])

  it('has no front when the session produced no entries', () => {
    expect(unit.wire.view({ records: [] })).toEqual({ entries: [] })
  })

  it('puts the newest entry in front when nothing was selected', () => {
    expect(unit.wire.view(STATE).front).toEqual({ kind: 'beta', entryId: 'two' })
  })

  it('puts the entry the user selected in front, older than the newest though it is', () => {
    expect(unit.wire.view(unit.apply(STATE, selection('alpha', 'one', 9))).front)
      .toEqual({ kind: 'alpha', entryId: 'one' })
  })

  it('gives the front back to an entry recorded after the selection', () => {
    const chosen = unit.apply(STATE, selection('alpha', 'one', 9))
    // The agent showing something is a later record than the click, so the
    // click gives way — the same comparison the selection won above.
    const shown = unit.apply(chosen, { type: ALPHA_SHOWN, seq: 12, time: 0, data: { id: 'again' } } as SessionEvent)
    expect(contentSurfaceProjection([alphaRecognizing, beta]).wire.view(shown).front)
      .toEqual({ kind: 'alpha', entryId: 'one' })
    expect(unit.wire.view({ ...STATE, selected: { kind: 'alpha', entryId: 'one', seq: 4 } }).front)
      .toEqual({ kind: 'beta', entryId: 'two' })
  })

  it('falls back to the newest entry when the selected one was dismissed', () => {
    const chosen = unit.apply(STATE, selection('alpha', 'one', 9))
    expect(unit.wire.view(unit.apply(chosen, dismissal('alpha', 'one', 11))).front)
      .toEqual({ kind: 'beta', entryId: 'two' })
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
