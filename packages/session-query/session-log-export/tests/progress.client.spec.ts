/**
 * The browser's export progress model: what the Host's extent headers mean,
 * how the bar is scaled by the Host's estimate of the bytes the body will
 * carry, how ZIP entries are counted out of the byte stream (including a
 * signature split across two chunks), and the guarantees the panel relies on —
 * capped entry counts, a fraction below 1 until the stream settles, and
 * monotonicity.
 */

import { describe, expect, it } from 'vitest'
import {
  readSessionLogExportExtent,
  SESSION_EXPORT_PROGRESS_START,
  SessionExportProgressTracker,
} from '../src/client/progress.ts'
import {
  SESSION_EXPORT_BYTES_HEADER,
  SESSION_EXPORT_ENTRIES_HEADER,
  SESSION_EXPORT_ESTIMATED_WIRE_BYTES_HEADER,
} from '../src/export-extent.ts'

const SIGNATURE = [0x50, 0x4b, 0x03, 0x04]

function extentHeaders(entries: string, bytes: string, wire: string): Headers {
  return new Headers({
    [SESSION_EXPORT_ENTRIES_HEADER]: entries,
    [SESSION_EXPORT_BYTES_HEADER]: bytes,
    [SESSION_EXPORT_ESTIMATED_WIRE_BYTES_HEADER]: wire,
  })
}

/** One entry's worth of archive bytes: the local file header plus filler. */
function entryBytes(filler: number): Uint8Array {
  return new Uint8Array([...SIGNATURE, ...new Array<number>(filler).fill(0x41)])
}

describe('readSessionLogExportExtent', () => {
  it('reads the entry count, uncompressed total, and estimated wire size', () => {
    expect(readSessionLogExportExtent(extentHeaders('3', '4096', '580')))
      .toEqual({ entries: 3, bytes: 4096, estimatedWireBytes: 580 })
  })

  it('treats an absent, non-numeric, non-positive, or fractional field as no extent', () => {
    expect(readSessionLogExportExtent(new Headers())).toBeNull()
    expect(readSessionLogExportExtent(new Headers({ [SESSION_EXPORT_ENTRIES_HEADER]: '3' }))).toBeNull()
    expect(readSessionLogExportExtent(new Headers({ [SESSION_EXPORT_BYTES_HEADER]: '10' }))).toBeNull()
    // The three fields travel together; an older Host that sends only the
    // first two leaves the bar indeterminate rather than mis-scaled.
    expect(readSessionLogExportExtent(new Headers({
      [SESSION_EXPORT_ENTRIES_HEADER]: '3', [SESSION_EXPORT_BYTES_HEADER]: '4096',
    }))).toBeNull()
    expect(readSessionLogExportExtent(extentHeaders('nope', '10', '5'))).toBeNull()
    expect(readSessionLogExportExtent(extentHeaders('0', '10', '5'))).toBeNull()
    expect(readSessionLogExportExtent(extentHeaders('3', '-1', '5'))).toBeNull()
    expect(readSessionLogExportExtent(extentHeaders('1.5', '10', '5'))).toBeNull()
  })
})

describe('SessionExportProgressTracker', () => {
  it('reports an indeterminate fraction when the Host announced no extent', () => {
    const tracker = new SessionExportProgressTracker(null)
    expect(tracker.progress).toEqual(SESSION_EXPORT_PROGRESS_START)

    expect(tracker.push(entryBytes(6))).toEqual({
      fraction: null, entriesDone: 0, entriesTotal: null, receivedBytes: 10,
    })
    expect(tracker.complete()).toEqual({
      fraction: 1, entriesDone: 1, entriesTotal: null, receivedBytes: 10,
    })
  })

  it('scales a single-entry archive by the announced wire estimate', () => {
    // A Session with no sub-Sessions and no attachments exports one entry:
    // nothing else can say how much of it is left, so the estimate carries it.
    const tracker = new SessionExportProgressTracker({ entries: 1, bytes: 7000, estimatedWireBytes: 1000 })
    expect(tracker.push(entryBytes(96)).fraction).toBeCloseTo(0.1, 10)
    expect(tracker.push(new Uint8Array(400)).fraction).toBeCloseTo(0.5, 10)
    expect(tracker.progress.entriesDone).toBe(0)
    expect(tracker.complete()).toEqual({
      fraction: 1, entriesDone: 1, entriesTotal: 1, receivedBytes: 500,
    })
  })

  it('counts a signature split across two chunks exactly once', () => {
    // One whole entry, then a second entry's signature straddling the chunk
    // boundary: the first entry is done exactly when the second one starts.
    const split = new SessionExportProgressTracker({ entries: 4, bytes: 1000, estimatedWireBytes: 1000 })
    split.push(new Uint8Array([...entryBytes(6), SIGNATURE[0]!, SIGNATURE[1]!]))
    expect(split.progress.entriesDone).toBe(0)
    expect(split.push(new Uint8Array([SIGNATURE[2]!, SIGNATURE[3]!, 0x41])).entriesDone).toBe(1)

    // The same second signature delivered one byte at a time, so the carry is
    // shorter than the signature on every step.
    const dripped = new SessionExportProgressTracker({ entries: 4, bytes: 1000, estimatedWireBytes: 1000 })
    dripped.push(entryBytes(6))
    for (const byte of SIGNATURE) dripped.push(new Uint8Array([byte]))
    expect(dripped.progress.entriesDone).toBe(1)

    // A chunk that ends on the first signature byte alone, then unrelated bytes.
    const nearMiss = new SessionExportProgressTracker({ entries: 4, bytes: 1000, estimatedWireBytes: 1000 })
    nearMiss.push(new Uint8Array([...entryBytes(6), SIGNATURE[0]!]))
    nearMiss.push(new Uint8Array([0x4b, 0x03, 0x05]))
    expect(nearMiss.progress.entriesDone).toBe(0)
  })

  it('caps the entry count at the announced total', () => {
    const tracker = new SessionExportProgressTracker({ entries: 2, bytes: 100_000, estimatedWireBytes: 100_000 })
    for (let entry = 0; entry < 5; entry += 1) tracker.push(entryBytes(4))
    expect(tracker.progress.entriesDone).toBe(2)
    expect(tracker.progress.receivedBytes).toBe(40)
    // The cap is what holds the fraction below 1 here: five signatures in a
    // two-entry archive would otherwise read as more than complete.
    expect(tracker.progress.fraction).toBe(0.99)
  })

  it('stops at the ceiling when the archive out-runs the wire estimate', () => {
    // An archive that compresses softer than the Host's calibration delivers
    // more bytes than estimated; it reaches the ceiling and waits there.
    const tracker = new SessionExportProgressTracker({ entries: 2, bytes: 7000, estimatedWireBytes: 100 })
    expect(tracker.push(entryBytes(996)).fraction).toBe(0.99)
    expect(tracker.complete()).toEqual({
      fraction: 1, entriesDone: 2, entriesTotal: 2, receivedBytes: 1000,
    })
  })

  it('takes the larger of the entry and wire measures, and only grows', () => {
    // Ten entries whose wire bytes run a tenth of the estimate, so the entry
    // measure leads: an archive that compressed harder than the calibration.
    const tracker = new SessionExportProgressTracker({ entries: 10, bytes: 7000, estimatedWireBytes: 1000 })
    const seen: number[] = []
    for (let entry = 0; entry < 10; entry += 1) {
      const progress = tracker.push(entryBytes(6))
      expect(progress.fraction).not.toBeNull()
      seen.push(progress.fraction ?? 0)
    }
    // Chunk k carries 10 of the 1000 estimated bytes and finishes entry k-1,
    // so the entry measure (k-1)/10 overtakes the wire measure 0.01k at once.
    expect(seen[0]).toBeCloseTo(0.01, 10)
    expect(seen[4]).toBeCloseTo(0.4, 10)
    expect(seen.at(-1)).toBeCloseTo(0.9, 10)
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)

    // The wire measure leads instead when one entry carries most of the archive.
    const oneEntry = new SessionExportProgressTracker({ entries: 4, bytes: 7000, estimatedWireBytes: 1000 })
    expect(oneEntry.push(entryBytes(496)).fraction).toBeCloseTo(0.5, 10)
    expect(oneEntry.progress.entriesDone).toBe(0)
  })
})
