// @vitest-environment jsdom
/**
 * The numbering the model points at. What matters is that a ref keeps naming
 * the same element for as long as that element lives, and names nothing at all
 * once it does not — a ref that quietly moved to another element would have the
 * model clicking something it never read.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { RefTable } from '../src/client/access/refs.ts'

afterEach(() => {
  document.body.innerHTML = ''
})

/** One element in the document, ready to be numbered. */
function element(tag = 'div'): Element {
  const el = document.createElement(tag)
  document.body.append(el)
  return el
}

describe('RefTable', () => {
  it('numbers elements in the order it first sees them, and keeps the number', () => {
    const refs = new RefTable()
    const first = element()
    const second = element()
    expect(refs.ref(first)).toBe('e1')
    expect(refs.ref(second)).toBe('e2')
    expect(refs.ref(first)).toBe('e1')
    expect(refs.ref(second)).toBe('e2')
  })

  it('resolves a ref to the element it numbered', () => {
    const refs = new RefTable()
    const el = element()
    expect(refs.resolve(refs.ref(el))).toBe(el)
  })

  it('resolves nothing for a ref it never minted', () => {
    expect(new RefTable().resolve('e404')).toBeUndefined()
  })

  it('resolves nothing once the element has left the document', () => {
    const refs = new RefTable()
    const el = element()
    const ref = refs.ref(el)
    el.remove()
    expect(refs.resolve(ref)).toBeUndefined()
  })

  it('forgets every ref on reset, and never hands an old number to a new element', () => {
    const refs = new RefTable()
    const before = element()
    const ref = refs.ref(before)
    refs.reset()
    expect(refs.resolve(ref)).toBeUndefined()
    // The next element gets a fresh number, so the ref the model still holds
    // from the page before the reload cannot resolve to it.
    expect(refs.ref(element())).toBe('e2')
    expect(refs.resolve(ref)).toBeUndefined()
  })
})
