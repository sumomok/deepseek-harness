/**
 * Which declined `will-navigate` targets still reach the OS's own handler.
 * The Electron event wiring itself needs a real BrowserWindow and is not
 * unit-testable; this covers the predicate `main.ts` calls.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { isExternalNavigationTarget, isServerNavigation } from '../src/navigation.ts'

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

describe('isServerNavigation', () => {
  const server = 'http://127.0.0.1:49321'

  it('keeps targets on the server origin, any path', () => {
    expect(isServerNavigation('http://127.0.0.1:49321/', server)).toBe(true)
    expect(isServerNavigation('http://127.0.0.1:49321/?token=t#x', server)).toBe(true)
  })

  it('declines a target that only starts with the origin text', () => {
    expect(isServerNavigation('http://127.0.0.1:49321@evil.example/', server)).toBe(false)
    expect(isServerNavigation('http://127.0.0.1:493210/', server)).toBe(false)
    expect(isServerNavigation('http://127.0.0.1:49321.evil.example/', server)).toBe(false)
  })

  it('declines another port, scheme or host, and anything unparsable', () => {
    expect(isServerNavigation('http://127.0.0.1:49322/', server)).toBe(false)
    expect(isServerNavigation('https://127.0.0.1:49321/', server)).toBe(false)
    expect(isServerNavigation('http://localhost:49321/', server)).toBe(false)
    expect(isServerNavigation('not a url', server)).toBe(false)
  })

  it('is what main.ts\'s will-navigate handler checks', () => {
    const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    expect(source).toContain('!isServerNavigation(target, server.url)')
    expect(source).not.toContain('target.startsWith(server.url)')
  })
})
