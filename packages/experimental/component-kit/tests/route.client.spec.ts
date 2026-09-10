/**
 * The one setting both halves of this package agree on: how a configured base
 * path is judged at load, and how the same document is read back off the wire.
 */
import { describe, expect, it } from 'vitest'
import { COMPONENT_KIT_SETTINGS_ROUTE, readComponentKitSettings, requireBizBasePath } from '../src/route.ts'

describe('the base path a deployment configures', () => {
  it('names the one route both halves address', () => {
    expect(COMPONENT_KIT_SETTINGS_ROUTE).toBe('/component-kit/settings')
  })

  it.each([
    ['/', '/'],
    ['/nrms-server/', '/nrms-server/'],
    ['/nrms-server', '/nrms-server/'],
    ['/a/b', '/a/b/'],
  ])('accepts %s as %s, a root-absolute path ending in a slash', (raw, normalized) => {
    expect(requireBizBasePath(raw)).toBe(normalized)
  })

  it.each([
    ['', 'must be a root-absolute path such as "/" or "/nrms-server/"'],
    ['nrms-server/', 'must be a root-absolute path such as "/" or "/nrms-server/"'],
    ['//evil.example/', 'must be a root-absolute path such as "/" or "/nrms-server/"'],
    ['https://evil.example/', 'must be a root-absolute path such as "/" or "/nrms-server/"'],
    ['/x?y', 'must carry no query, fragment, whitespace, backslash or control character'],
    ['/x#y', 'must carry no query, fragment, whitespace, backslash or control character'],
    ['/x y/', 'must carry no query, fragment, whitespace, backslash or control character'],
    ['/x\n/', 'must carry no query, fragment, whitespace, backslash or control character'],
    ['/\\evil.example.com/', 'must carry no query, fragment, whitespace, backslash or control character'],
    ['/a\\b/', 'must carry no query, fragment, whitespace, backslash or control character'],
  ])('refuses %j', (raw, reason) => {
    expect(() => requireBizBasePath(raw)).toThrow(`component-kit: bizBasePath ${reason}`)
  })

  it.each([
    ['/a/../b/', '/b/'],
    ['/./', '/'],
    ['/%2e%2e/api/', '/api/'],
    ['/%2e/api/', '/api/'],
  ])('refuses %j, which the URL parser resolves to %j rather than to what it spells', (raw, resolved) => {
    expect(() => requireBizBasePath(raw)).toThrow(
      `component-kit: bizBasePath must resolve to the path it spells on this origin; ${JSON.stringify(raw)} resolves to "https://component-kit.invalid${resolved}"`,
    )
  })

  it('refuses a backslash form that a hand-written reading would let through', () => {
    // The whole point of the parser round-trip: `/\\host/` starts with one
    // slash, carries no dot segment and names no scheme, and still reaches
    // another origin once a browser resolves it.
    expect(new URL('/\\evil.example.com/', 'https://console.example.com').origin).toBe('https://evil.example.com')
    expect(() => requireBizBasePath('/\\evil.example.com/')).toThrow('component-kit: bizBasePath')
    expect(readComponentKitSettings({ bizBasePath: '/\\evil.example.com/' })).toBeUndefined()
    expect(readComponentKitSettings({ bizBasePath: '/%2e%2e/api/' })).toBeUndefined()
  })

  it('reads the served document back by the same rule, and reads nothing else', () => {
    expect(readComponentKitSettings({ bizBasePath: '/nrms-server' })).toEqual({ bizBasePath: '/nrms-server/' })
    expect(readComponentKitSettings({ bizBasePath: 'relative' })).toBeUndefined()
    expect(readComponentKitSettings({ bizBasePath: 7 })).toBeUndefined()
    expect(readComponentKitSettings({})).toBeUndefined()
    expect(readComponentKitSettings(null)).toBeUndefined()
    expect(readComponentKitSettings('/')).toBeUndefined()
  })
})
