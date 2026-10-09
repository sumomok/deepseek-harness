// @vitest-environment jsdom
/**
 * The names a point carries on an original-system page are the names the
 * console's own page reader prints: over every page of point-anchor's naming
 * corpus, the walk point-anchor copied and the content-frame reader this
 * console runs print the same items — kind, role, name, mark and the region
 * around each — for every element, under the same injected visibility,
 * clickability and pseudo-element style.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { contentFrameCopy } from '@haoran/dsh-point-anchor/page'
import { collect } from '@deepseek-ai/dsh-experimental-content-frame/src/client/access/collect.ts'

/** Where the vendored point-anchor's naming corpus is installed. */
const CORPUS = join(dirname(createRequire(import.meta.url).resolve('@haoran/dsh-point-anchor/package.json')), 'fixtures', 'naming')

const PAGES = ['controls', 'tables', 'row-values', 'drawings'] as const

/** The computed `content` an icon font's rule gives the `::before` of an element marked `data-glyph`. */
const GLYPH_CONTENT = '"\u{e78c}"'

/** The injections the corpus is read under, as point-anchor's own specs inject them. */
const ENV = {
  isVisible: (el: Element): boolean => el.closest('[data-hidden]') === null,
  isClickable: (el: Element): boolean => el.closest('[data-pointer]') !== null,
  computedStyle: (el: Element, pseudo?: '::before' | '::after') => {
    if (pseudo === undefined) return (el.ownerDocument.defaultView ?? window).getComputedStyle(el)
    const content = pseudo === '::before' && el.hasAttribute('data-glyph') ? GLYPH_CONTENT : 'none'
    return { getPropertyValue: (property: string): string => (property === 'content' ? content : '') }
  },
}

/**
 * An item as both readers print it, its element named by its probe or its tag and classes.
 * @param item - the item.
 * @returns the plain record.
 */
function printed(item: unknown): unknown {
  return JSON.parse(JSON.stringify(item, (key: string, value: unknown) => {
    if (typeof value === 'object' && value !== null && 'localName' in value && 'getAttribute' in value) {
      const el = value as Element
      return el.getAttribute('data-probe') ?? `<${el.localName}${[...el.classList].map(name => `.${name}`).join('')}>`
    }
    return key === 'opens' || key === 'ref' ? undefined : value
  }))
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe.each(PAGES)('the %s page of the naming corpus', (page) => {
  it('is read item for item alike by point-anchor\'s copied walk and the console\'s content-frame reader', () => {
    document.body.innerHTML = readFileSync(join(CORPUS, `${page}.html`), 'utf8')
    const refs = { ref: (): string => '' }
    const copied = contentFrameCopy.collect(document, { refs, ...ENV }, undefined).map(printed)
    const own = collect(document, { refs, budgetChars: Number.MAX_SAFE_INTEGER, ...ENV }, undefined).map(printed)
    expect(copied.length).toBeGreaterThan(0)
    expect(own).toEqual(copied)
  })
})
