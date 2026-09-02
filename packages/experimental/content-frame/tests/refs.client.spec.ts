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

  it('keeps the refs of elements the page still has when it sweeps', () => {
    const refs = new RefTable()
    const el = element()
    const ref = refs.ref(el)
    refs.sweep()
    expect(refs.ref(el)).toBe(ref)
    expect(refs.resolve(ref)).toBe(el)
  })

  it('forgets an element the page took away, so the same element coming back is a new one', () => {
    const refs = new RefTable()
    const el = element()
    expect(refs.ref(el)).toBe('e1')
    el.remove()
    refs.sweep()
    document.body.append(el)
    // The model's e1 named the element the page had then; what came back is a
    // different element as far as anything that read the old page is concerned.
    expect(refs.ref(el)).toBe('e2')
    expect(refs.resolve('e1')).toBeUndefined()
  })

  it('winds the numbering back to a mark, so a row measured and dropped keeps no number', () => {
    const refs = new RefTable()
    const kept = element()
    const measured = element()
    expect(refs.ref(kept)).toBe('e1')
    const mark = refs.mark()
    expect(refs.ref(measured)).toBe('e2')
    refs.rollback(mark)
    // The model never saw e2, so the number is free again and the element that
    // held it is unknown until something prints it.
    expect(refs.resolve('e2')).toBeUndefined()
    expect(refs.ref(element())).toBe('e2')
    expect(refs.ref(kept)).toBe('e1')
    expect(refs.ref(measured)).toBe('e3')
  })

  it('sizes the widest ref a listing could yet mint', () => {
    const refs = new RefTable()
    expect(refs.widthAfter(0)).toBe(2)
    expect(refs.widthAfter(8)).toBe(2)
    expect(refs.widthAfter(9)).toBe(3)
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
