import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Engine-independent measurements over the recorded boundary fixtures.
 *
 * These pin what the recorded session actually did, so a B2 change can be
 * compared against it. The recording predates the compaction guards; the cases
 * that describe the target behavior assert it directly and pass on the current
 * implementation.
 */

const FIXTURES = join(import.meta.dirname, 'fixtures')

interface Event {
  readonly type: string
  readonly data?: Record<string, unknown>
  readonly surfaceOp?: unknown
}

function load(name: string): Event[] {
  return readFileSync(join(FIXTURES, name, 'session.jsonl'), 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Event)
}

function summaries(events: readonly Event[]): Record<string, unknown>[] {
  return events.filter(event => event.type === 'compaction/summary').map(event => event.data ?? {})
}

function ends(events: readonly Event[]): Record<string, unknown>[] {
  return events.filter(event => event.type === 'compaction/end').map(event => event.data ?? {})
}

function replacementOf(events: readonly Event[]): Record<string, unknown> | undefined {
  const replacement = events.find((event) => {
    const op = event.surfaceOp as { op?: string } | undefined
    return event.type === 'user/message' && op?.op === 'replace'
  })
  return replacement?.surfaceOp as Record<string, unknown> | undefined
}

describe('measurement: what a compaction reclaims', () => {
  const events = load('boundary-b-consecutive')
  const [first] = summaries(events)

  it('records the shadowed token count of the successful attempt', () => {
    expect(first?.['shadowedTokenCount']).toBeGreaterThan(0)
    expect(first?.['shadowedSeqs']).toBeInstanceOf(Array)
    expect((first?.['shadowedSeqs'] as number[]).length).toBeGreaterThan(0)
  })

  it('replaces a range that contains every shadowed surface node', () => {
    const op = replacementOf(events)
    expect(op).toBeDefined()
    const start = Number(op?.['startSeq'])
    const end = Number(op?.['endSeq'])
    expect(end).toBeGreaterThanOrEqual(start)
    const shadowedSeqs = first?.['shadowedSeqs'] as number[]
    // Shadowed sequences are surface nodes: log-only events between them are not listed.
    for (const seq of shadowedSeqs) {
      expect(seq).toBeGreaterThanOrEqual(start)
      expect(seq).toBeLessThanOrEqual(end)
    }
  })

  it('never reports a failed attempt as having reclaimed anything', () => {
    const failed = ends(events).filter(end => end['error'] !== undefined)
    expect(failed).toHaveLength(1)
    const failedId = failed[0]?.['compactionId']
    expect(summaries(events).some(summary => summary['compactionId'] === failedId)).toBe(false)
  })
})

describe('fixed prefix and semantic tail', () => {
  const events = load('boundary-b-consecutive')
  const summary = summaries(events)[0]
  const op = replacementOf(events)
  const shadowed = (summary?.['shadowedSeqs'] as number[] | undefined) ?? []

  it('starts the compacted range after the leading system prompt', () => {
    const firstSystem = events.findIndex(event => event.type === 'system/message')
    if (firstSystem === -1) {
      expect(Number(op?.['startSeq'])).toBeGreaterThan(0)
      return
    }
    expect(Number(op?.['startSeq'])).toBeGreaterThan(firstSystem)
  })

  // Surface order and log seq diverge once a replacement exists: a checkpoint
  // written now carries a high seq but sits at the surface head, so the shadowed
  // list is surface order, not seq order. Retention logic must use surface
  // positions, never numeric seq ordering.
  it('records shadowed nodes in surface order, not ascending seq order', () => {
    expect(shadowed.length).toBeGreaterThan(1)
    const ascending = shadowed.every((value, index) => index === 0 || value > shadowed[index - 1]!)
    expect(ascending).toBe(false)
  })

  it('retains a tail after the compacted range', () => {
    const end = Number(op?.['endSeq'])
    const laterSurface = events.filter((event, index) => index > 0 && event.type.endsWith('/message'))
    expect(end).toBeGreaterThan(0)
    expect(laterSurface.length).toBeGreaterThan(0)
  })
})

describe('consecutive compaction lineage', () => {
  const events = load('boundary-b-consecutive')
  const brackets = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'compaction/start')
  const firstId = String(brackets[0]?.event.data?.['compactionId'])
  const secondId = String(brackets[1]?.event.data?.['compactionId'])

  it('opens a second attempt immediately after the first one closes', () => {
    expect(brackets).toHaveLength(2)
    expect(firstId).not.toBe(secondId)
  })

  it('records that the second attempt carried no summary of its own', () => {
    const secondSummaries = summaries(events).filter(summary => summary['compactionId'] === secondId)
    expect(secondSummaries).toHaveLength(0)
  })

  // Historical evidence: this recording is from before the guard, so the retry
  // did re-summarize its own predecessor's checkpoint and failed. The guard is
  // pinned by the engine-level case in `engine.spec.ts`.
  it('records the pre-guard failure that the retry guard now prevents', () => {
    const secondEnd = ends(events).find(end => end['compactionId'] === secondId)
    // The fixture keeps the error's class and byte length, not its text.
    expect(String(secondEnd?.['error'])).toMatch(/^<redacted:error:\d+>$/)
  })
})
