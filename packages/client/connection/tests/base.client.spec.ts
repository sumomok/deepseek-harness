/**
 * Deployment-base resolution: the one decision every browser URL in this
 * client is built from.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientUrl, INTERNAL_BASE, resolveClientBase } from '../src/client/base.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('resolveClientBase', () => {
  it('falls back to the internal authority in a carrier with no page', () => {
    expect(resolveClientBase()).toBe(INTERNAL_BASE)
  })

  it('treats a sandboxed null origin as no page', () => {
    vi.stubGlobal('location', { origin: 'null' })
    expect(resolveClientBase()).toBe(INTERNAL_BASE)
  })

  it('uses the page root when nothing declares a prefix', () => {
    vi.stubGlobal('location', { origin: 'https://harness.example' })
    expect(resolveClientBase()).toBe('https://harness.example/')
  })

  it('takes the directory of a same-origin document base', () => {
    vi.stubGlobal('location', { origin: 'https://harness.example' })
    vi.stubGlobal('document', { baseURI: 'https://harness.example/console/index.html' })
    expect(resolveClientBase()).toBe('https://harness.example/console/')
  })

  it('ignores a document base that is not on the page origin', () => {
    vi.stubGlobal('location', { origin: 'https://harness.example' })
    vi.stubGlobal('document', { baseURI: 'about:blank' })
    expect(resolveClientBase()).toBe('https://harness.example/')
  })

  it('ignores a document base whose host merely starts with the page host', () => {
    vi.stubGlobal('location', { origin: 'https://harness.example' })
    vi.stubGlobal('document', { baseURI: 'https://harness.example.attacker.test/pwn/' })
    expect(resolveClientBase()).toBe('https://harness.example/')
  })

  it('takes only the path from a declared prefix that names an authority of its own', () => {
    vi.stubGlobal('location', { origin: 'https://harness.example' })
    for (const declared of ['https://attacker.test/console/', '//attacker.test/console/']) {
      vi.stubGlobal('__DSH_BASE__', declared)
      expect(resolveClientBase()).toBe('https://harness.example/console/')
    }
  })

  it('prefers the injected prefix and tolerates one written without its trailing slash', () => {
    vi.stubGlobal('location', { origin: 'https://harness.example' })
    vi.stubGlobal('document', { baseURI: 'https://harness.example/' })
    vi.stubGlobal('__DSH_BASE__', '/console/')
    expect(resolveClientBase()).toBe('https://harness.example/console/')
    vi.stubGlobal('__DSH_BASE__', '/console')
    expect(resolveClientBase()).toBe('https://harness.example/console/')
  })

  it('ignores a prefix global that is not a non-empty string', () => {
    vi.stubGlobal('location', { origin: 'https://harness.example' })
    vi.stubGlobal('__DSH_BASE__', '')
    expect(resolveClientBase()).toBe('https://harness.example/')
    vi.stubGlobal('__DSH_BASE__', 7)
    expect(resolveClientBase()).toBe('https://harness.example/')
  })
})

describe('clientUrl', () => {
  it('extends the deployment prefix instead of replacing it', () => {
    vi.stubGlobal('location', { origin: 'https://harness.example' })
    vi.stubGlobal('__DSH_BASE__', '/console/')
    for (const path of ['/api/session.list', '///api/session.list', 'api/session.list']) {
      expect(clientUrl(path).href).toBe('https://harness.example/console/api/session.list')
    }
  })

  it('resolves a Host route against the page root when nothing declares a prefix', () => {
    vi.stubGlobal('location', { origin: 'https://harness.example' })
    expect(clientUrl('/plugins/events').href).toBe('https://harness.example/plugins/events')
  })
})
