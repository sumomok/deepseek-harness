/**
 * The readings shared by this row's renderers, on their own.
 *
 * Not a hostile-input suite: a block's properties reach a renderer typed
 * `unknown` because one table type serves every component, and these are the
 * readings that turn one of those values into something a Vue prop record can
 * hold. What is pinned here is which values each reading answers for and which
 * it does not, since the renderers that call them draw a component around the
 * answer and cannot show the difference.
 */
import { describe, expect, it } from 'vitest'
import { readBoolean, readList, readNumber, readRecord, readText } from '../src/client/props.ts'

describe('readText', () => {
  it('answers for text that names something', () => {
    expect(readText('名称')).toBe('名称')
  })

  it('answers for nothing else, the empty string included', () => {
    for (const value of ['', 0, false, null, undefined, {}, ['x']]) expect(readText(value)).toBeUndefined()
  })
})

describe('readBoolean', () => {
  it('answers for a boolean, either way', () => {
    expect(readBoolean(true)).toBe(true)
    expect(readBoolean(false)).toBe(false)
  })

  it('answers for nothing a component would have to coerce', () => {
    for (const value of ['true', 1, 0, null, undefined]) expect(readBoolean(value)).toBeUndefined()
  })
})

describe('readNumber', () => {
  it('answers for a finite number, zero and negatives included', () => {
    expect(readNumber(0)).toBe(0)
    expect(readNumber(-3.5)).toBe(-3.5)
  })

  it('answers for nothing that is not a finite number', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '90', null, undefined]) {
      expect(readNumber(value)).toBeUndefined()
    }
  })
})

describe('readRecord', () => {
  it('answers for a record of further properties', () => {
    const record = { a: 1 }
    expect(readRecord(record)).toBe(record)
  })

  it('answers for nothing else, a list and null included', () => {
    for (const value of [[1, 2], null, undefined, 'x', 3]) expect(readRecord(value)).toBeUndefined()
  })
})

describe('readList', () => {
  it('keeps the items the reader made sense of, in order', () => {
    expect(readList(['a', '', 'b'], readText)).toEqual(['a', 'b'])
  })

  it('answers with nothing at all when the value is not a list', () => {
    expect(readList('a,b', readText)).toEqual([])
  })
})
