/**
 * `freezeDeep`: what Vue 2 is allowed to see. The proof that it is deep enough
 * is in the bridge suite, which hands a real Vue root a frozen record and looks
 * for the observer; here the shape of the operation is pinned on its own.
 */
import { describe, expect, it } from 'vitest'
import { freezeDeep } from '../src/client/freeze.ts'

describe('freezeDeep', () => {
  it('freezes the value it is given, in place', () => {
    const record = { label: 'first' }
    expect(freezeDeep(record)).toBe(record)
    expect(Object.isFrozen(record)).toBe(true)
  })

  it('reaches nested objects and arrays, which a shallow freeze leaves open', () => {
    const record = { rows: [{ label: 'first', tags: ['a'] }] }
    freezeDeep(record)
    expect(Object.isFrozen(record.rows)).toBe(true)
    expect(Object.isFrozen(record.rows[0])).toBe(true)
    expect(Object.isFrozen(record.rows[0]?.tags)).toBe(true)
  })

  it('returns primitives, null, and functions untouched', () => {
    const callback = (): void => {}
    expect(freezeDeep(null)).toBeNull()
    expect(freezeDeep(7)).toBe(7)
    expect(freezeDeep(callback)).toBe(callback)
    expect(Object.isFrozen(callback)).toBe(false)
  })

  it('stops at a value that is already frozen, so a cycle terminates', () => {
    const cyclic: Record<string, unknown> = { label: 'first' }
    cyclic.self = cyclic
    expect(() => freezeDeep(cyclic)).not.toThrow()
    expect(Object.isFrozen(cyclic)).toBe(true)
  })
})
