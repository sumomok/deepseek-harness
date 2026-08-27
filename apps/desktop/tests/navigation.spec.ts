/**
 * Which declined `will-navigate` targets still reach the OS's own handler.
 * The Electron event wiring itself needs a real BrowserWindow and is not
 * unit-testable; this covers the predicate `main.ts` calls.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { isExternalNavigationTarget } from '../src/navigation.ts'

describe('isExternalNavigationTarget', () => {
  it('forwards http(s) and mailto targets', () => {
    expect(isExternalNavigationTarget('https://example.com')).toBe(true)
    expect(isExternalNavigationTarget('http://example.com')).toBe(true)
    expect(isExternalNavigationTarget('mailto:dev@example.com')).toBe(true)
  })

  it('drops every other target', () => {
    expect(isExternalNavigationTarget('file:///etc/passwd')).toBe(false)
    expect(isExternalNavigationTarget('javascript:alert(1)')).toBe(false)
    expect(isExternalNavigationTarget('about:blank')).toBe(false)
    expect(isExternalNavigationTarget('')).toBe(false)
  })
})
