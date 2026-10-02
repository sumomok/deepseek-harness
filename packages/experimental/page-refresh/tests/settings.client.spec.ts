/**
 * The browser half's reading of the settings global: the four fields the node
 * half publishes are accepted as they are, and anything else is refused with
 * the global and the field named.
 */

import { describe, expect, it } from 'vitest'
import { readPageRefreshSettings } from '../src/client/settings.ts'

const VALID = { checkOnVisible: true, reloadDelayMs: 0, disconnectNotice: false, stuckAfterSeconds: 60 }

describe('the settings global', () => {
  it('reads the four published fields', () => {
    expect(readPageRefreshSettings({ ...VALID, extra: 'ignored' })).toEqual(VALID)
  })

  it.each([undefined, null, 'settings'])('refuses a page that carries %s, naming the node half', (value) => {
    expect(() => readPageRefreshSettings(value)).toThrow(
      `page-refresh: the page carries no usable __DSH_PAGE_REFRESH_CONFIG__: ${String(value)}. `
      + 'The row\'s node half publishes it when it activates; a missing value means it did not, and the host\'s startup warning names why.',
    )
  })

  it.each([
    ['checkOnVisible', 'yes', '"yes"'],
    ['reloadDelayMs', -1, '-1'],
    ['reloadDelayMs', 1.5, '1.5'],
    ['reloadDelayMs', 2_147_483_648, '2147483648'],
    ['disconnectNotice', undefined, 'undefined'],
    ['stuckAfterSeconds', 0, '0'],
    ['stuckAfterSeconds', '60', '"60"'],
    ['stuckAfterSeconds', 2_147_484, '2147484'],
  ])('refuses %s when it is %s, naming the field', (field, value, shown) => {
    expect(() => readPageRefreshSettings({ ...VALID, [field]: value }))
      .toThrow(`page-refresh: __DSH_PAGE_REFRESH_CONFIG__.${field} is unusable: ${shown}`)
  })
})
