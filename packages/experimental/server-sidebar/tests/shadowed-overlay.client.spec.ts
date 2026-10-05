/**
 * `shadowed-overlay.ts`: reading the face of a `shell.overlay` entry this
 * package shadows — the face's members checked before use, one read per
 * entry, the replacement itself skipped — and an observable member of it that
 * keeps one snapshot identity per published value and follows the owner's
 * entry as it is registered, replaced, and removed.
 */
import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import {
  followShadowed, hookOf, isAction, isSessionAction, type OverlayLedger, REPLACING_PRIORITY, shadowedFace,
} from '../src/client/shadowed-overlay.ts'

/** The id the owner and the replacement below share. */
const ID = 'owner.entry'

/** The replacement component the reader skips. */
function Replacement() {
  return null
}

/** A ledger whose entries the test sets and whose change notice it sends. */
function ledgerBench() {
  let entries: StoredEntry[] = []
  const listeners = new Set<() => void>()
  const ledger: OverlayLedger = {
    entries: () => entries,
    subscribe: (_key, fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
  const set = (next: StoredEntry[]): void => {
    entries = next
    for (const listener of [...listeners]) listener()
  }
  return { ledger, set, listeners }
}

/**
 * An owner entry whose face carries one source under `hooks.value`.
 * @param initial - the source's first value.
 * @returns the entry, its source, and the inject spy.
 */
function ownerEntry(initial: unknown = null) {
  const value = createSnapshotStore<unknown>(initial)
  const inject = vi.fn(() => ({ hooks: { value } }))
  const entry: StoredEntry = { component: () => null, options: { id: ID }, inject }
  return { entry, value, inject }
}

/** The face the readers below pick: the one source. */
const pickValue = (face: Record<string, unknown>) => {
  const value = hookOf(face, 'value')
  return value === undefined ? undefined : { value }
}

describe('hookOf', () => {
  it('hands on the observable under the name in the face\'s hooks compartment', () => {
    const value = createSnapshotStore(1)
    expect(hookOf({ hooks: { value } }, 'value')).toBe(value)
  })

  it('finds nothing in a face without a hooks compartment, or without an observable under the name', () => {
    const listen = () => () => {}
    for (const face of [
      {},
      { hooks: null },
      { hooks: 'value' },
      { hooks: {} },
      { hooks: { value: null } },
      { hooks: { value: 'value' } },
      { hooks: { value: { getSnapshot: () => 1 } } },
      { hooks: { value: { subscribe: listen } } },
      { hooks: { value: { getSnapshot: 1, subscribe: listen } } },
      { hooks: { value: { getSnapshot: () => 1, subscribe: 1 } } },
    ]) {
      expect({ face, hook: hookOf(face, 'value') }).toEqual({ face, hook: undefined })
    }
  })
})

describe('isAction and isSessionAction', () => {
  it('accept a function and nothing else', () => {
    for (const guard of [isAction, isSessionAction]) {
      expect(guard(() => {})).toBe(true)
      expect(guard(undefined)).toBe(false)
      expect(guard({})).toBe(false)
    }
  })
})

describe('shadowedFace', () => {
  it('reads the owner\'s face under the id, skipping the replacement and other ids, once per entry', () => {
    const { ledger, set } = ledgerBench()
    const owner = ownerEntry()
    const replacementInject = vi.fn(() => ({ hooks: { value: createSnapshotStore(0) } }))
    const elsewhere = vi.fn(() => ({ hooks: { value: createSnapshotStore(0) } }))
    const face = shadowedFace(ledger, ID, Replacement, pickValue)
    expect(face()).toBeUndefined()
    set([
      { component: Replacement, options: { id: ID }, inject: replacementInject },
      { component: () => null, options: { id: 'other.entry' }, inject: elsewhere },
      owner.entry,
    ])
    expect(face()?.value).toBe(owner.value)
    expect(face()?.value).toBe(owner.value)
    expect(owner.inject).toHaveBeenCalledOnce()
    expect(replacementInject).not.toHaveBeenCalled()
    expect(elsewhere).not.toHaveBeenCalled()
    expect(REPLACING_PRIORITY).toBe(-1)
  })

  it('reads nothing from an entry without a face, or with one it does not recognise, and reads that face once', () => {
    const { ledger, set } = ledgerBench()
    const face = shadowedFace(ledger, ID, Replacement, pickValue)
    set([{ component: () => null, options: { id: ID } }])
    expect(face()).toBeUndefined()
    const inject = vi.fn(() => ({ hooks: {} }))
    set([{ component: () => null, options: { id: ID }, inject }])
    expect(face()).toBeUndefined()
    expect(face()).toBeUndefined()
    expect(inject).toHaveBeenCalledOnce()
  })

  it('reads a re-registered owner\'s face afresh', () => {
    const { ledger, set } = ledgerBench()
    const face = shadowedFace(ledger, ID, Replacement, pickValue)
    const first = ownerEntry()
    set([first.entry])
    expect(face()?.value).toBe(first.value)
    const second = ownerEntry()
    set([second.entry])
    expect(face()?.value).toBe(second.value)
  })
})

describe('followShadowed', () => {
  /**
   * A parsed source over the bench's owner entry: a number doubled, anything else nothing.
   * @param ledger - the bench ledger.
   * @returns the source and the parse spy.
   */
  function doubled(ledger: OverlayLedger) {
    const parse = vi.fn((raw: unknown) => (typeof raw === 'number' ? { doubled: raw * 2 } : null))
    const face = shadowedFace(ledger, ID, Replacement, pickValue)
    const source: HostObservable<{ doubled: number } | null> = followShadowed(ledger, face, current => current.value, parse)
    return { source, parse }
  }

  it('answers null while no owner entry is registered, and parses each published value once', () => {
    const { ledger, set } = ledgerBench()
    const { source, parse } = doubled(ledger)
    expect(source.getSnapshot()).toBeNull()
    const owner = ownerEntry(2)
    set([owner.entry])
    const first = source.getSnapshot()
    expect(first).toEqual({ doubled: 4 })
    // The same published value keeps one snapshot identity.
    expect(source.getSnapshot()).toBe(first)
    expect(parse).toHaveBeenCalledOnce()
    owner.value.set('two')
    expect(source.getSnapshot()).toBeNull()
    owner.value.set(null)
    expect(source.getSnapshot()).toBeNull()
  })

  it('follows an owner registered after the subscriber, then replaced, then removed, and lets go of each source it leaves', () => {
    const { ledger, set, listeners } = ledgerBench()
    const { source } = doubled(ledger)
    const listener = vi.fn()
    const stop = source.subscribe(listener)

    const first = ownerEntry(1)
    set([first.entry])
    expect(listener).toHaveBeenCalledOnce()
    expect(source.getSnapshot()).toEqual({ doubled: 2 })
    first.value.set(3)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(source.getSnapshot()).toEqual({ doubled: 6 })

    // A ledger change that leaves the same owner says nothing.
    set([first.entry, { component: () => null, options: { id: 'other.entry' } }])
    expect(listener).toHaveBeenCalledTimes(2)

    const second = ownerEntry(5)
    set([second.entry])
    expect(listener).toHaveBeenCalledTimes(3)
    expect(source.getSnapshot()).toEqual({ doubled: 10 })
    first.value.set(7)
    expect(listener).toHaveBeenCalledTimes(3)

    set([])
    expect(listener).toHaveBeenCalledTimes(4)
    expect(source.getSnapshot()).toBeNull()
    second.value.set(9)
    expect(listener).toHaveBeenCalledTimes(4)

    stop()
    expect(listeners.size).toBe(0)
    set([ownerEntry(11).entry])
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('lets go of the owner\'s source and the ledger when the subscriber stops', () => {
    const { ledger, set, listeners } = ledgerBench()
    const owner = ownerEntry(1)
    set([owner.entry])
    const { source } = doubled(ledger)
    const listener = vi.fn()
    const stop = source.subscribe(listener)
    owner.value.set(2)
    expect(listener).toHaveBeenCalledOnce()
    stop()
    owner.value.set(3)
    expect(listener).toHaveBeenCalledOnce()
    expect(listeners.size).toBe(0)
  })
})
