// @vitest-environment jsdom
/**
 * A key named `__proto__` in what the `toy.data-page` readings copy: a block's
 * region table, and a row the page hands over. Both arrive as JSON, where the
 * key is an ordinary one, and each reading keeps it one, beside the others,
 * rather than dropping it or making the value under it a prototype.
 */
import { describe, expect, it } from 'vitest'
import { readDataPage, readSaved } from '../src/client/data-page-read.ts'

describe('a key named __proto__', () => {
  it('stays one more region in the table the page is handed', () => {
    const regions = readDataPage({ relatedMeta: 'device', regions: JSON.parse('{"__proto__":true,"infoCard":false}') })?.regions
    expect(JSON.stringify(regions)).toBe('{"__proto__":true,"infoCard":false}')
    expect(regions === undefined ? undefined : Object.getPrototypeOf(regions)).toBe(Object.prototype)
  })

  it('stays one more cell of a row read through a column of that name', () => {
    const { record } = readSaved(JSON.parse('{"__proto__":"内部","zh_label":"新建-01"}'), [{ attr: 'zh_label' }, { attr: '__proto__' }])
    expect(JSON.stringify(record)).toBe('{"zh_label":"新建-01","__proto__":"内部"}')
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype)
  })
})
