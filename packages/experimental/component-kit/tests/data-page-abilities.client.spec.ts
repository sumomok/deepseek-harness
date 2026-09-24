// @vitest-environment jsdom
/**
 * What the visitor may do on one table's data page, as the browser half
 * receives it: the five abilities the vendored page takes, read off the node
 * half's route and read as every ability off whenever no complete verdict
 * arrives.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DATA_PAGE_ABILITY_KEYS } from '@sumomok/toy-crud-kit'
import { readAbilitiesFor } from '../src/client/data-page-abilities.ts'
import {
  COMPONENT_KIT_ABILITIES_ROUTE,
  DATA_PAGE_ABILITIES,
  NO_ABILITIES,
  readDataPageAbilities,
} from '../src/route.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A complete verdict with two abilities on. */
const VERDICT = { create: true, update: false, delete: false, import: false, export: true }

/**
 * Answer the ability route with one response, and record what was asked.
 * @param respond - what the fetch answers with.
 * @returns every URL requested.
 */
function serve(respond: () => Promise<unknown>): string[] {
  const requested: string[] = []
  vi.stubGlobal('fetch', vi.fn((input: URL, init: RequestInit) => {
    requested.push(input.href)
    expect(init.cache).toBe('no-store')
    return respond()
  }))
  return requested
}

describe('the five abilities', () => {
  it('are the vendored page\'s own five, in its order', () => {
    // A key the page takes and this half never sends is an entrance nobody
    // could remove; a key this half sends and the page ignores removes nothing.
    expect(DATA_PAGE_ABILITIES).toEqual([...DATA_PAGE_ABILITY_KEYS])
  })

  it('are all off in the table a page is drawn under before a verdict', () => {
    expect(NO_ABILITIES).toEqual({ create: false, update: false, delete: false, import: false, export: false })
  })

  it('are read off the wire only as a complete table of booleans', () => {
    expect(readDataPageAbilities(VERDICT)).toEqual(VERDICT)
    expect(readDataPageAbilities({ ...VERDICT, extra: true })).toEqual(VERDICT)
    for (const document of [null, 'yes', 7, { ...VERDICT, create: 'true' }, { create: true }, { ...VERDICT, export: null }]) {
      expect(readDataPageAbilities(document)).toBeUndefined()
    }
  })
})

describe('the verdict the node half answers', () => {
  it('asks about the named table on the ability route, and passes the verdict on', async () => {
    const requested = serve(() => Promise.resolve({ ok: true, json: () => Promise.resolve(VERDICT) }))
    expect(await readAbilitiesFor('probe device', new AbortController().signal)).toEqual(VERDICT)
    const url = new URL(requested[0] as string)
    expect(url.pathname).toBe(COMPONENT_KIT_ABILITIES_ROUTE)
    expect(url.searchParams.get('meta')).toBe('probe device')
  })

  it('is every ability off when the route is not there, the answer is not JSON, or the table is incomplete', async () => {
    const answers: readonly (() => Promise<unknown>)[] = [
      () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
      () => Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError('not JSON')) }),
      () => Promise.resolve({ ok: true, json: () => Promise.resolve({ create: true }) }),
      () => Promise.reject(new TypeError('network')),
    ]
    for (const respond of answers) {
      serve(respond)
      expect(await readAbilitiesFor('probe_device', new AbortController().signal)).toEqual(NO_ABILITIES)
    }
  })
})
