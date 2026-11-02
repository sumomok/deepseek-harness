/**
 * The sign-in window's navigation policy: OAuth hand-offs may cross HTTP(S)
 * origins in the same window, while dangerous protocols, credentials, and
 * malformed targets are cancelled in place and never reach the OS.
 * @module
 */

import { describe, expect, it, vi } from 'vitest'
import type { LoginNavigationContents } from '../src/login-window.ts'
import { installLoginNavigationPolicy, loginNavigationTarget } from '../src/login-window.ts'

vi.mock('electron', () => ({
  BrowserWindow: class { readonly testDouble = true },
  session: { fromPartition: () => ({ clearStorageData: async () => undefined }) },
}))

type NavigationListener = (event: { preventDefault(): void }, target: string) => void

/** A cancellable event that records whether the policy stopped it. */
interface FakeEvent {
  preventDefault: () => void
}

/** A web contents stand-in that records the policy's handlers. */
class FakeContents implements LoginNavigationContents {
  windowOpen: ((details: { url: string }) => { action: 'deny' }) | undefined
  readonly listeners = new Map<'will-navigate' | 'will-redirect', NavigationListener[]>()

  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): unknown {
    this.windowOpen = handler
    return this
  }

  on(event: 'will-navigate' | 'will-redirect', listener: NavigationListener): unknown {
    this.listeners.set(event, [...this.listeners.get(event) ?? [], listener])
    return this
  }

  popup(url: string): { action: 'deny' } {
    if (this.windowOpen === undefined) throw new Error('no popup handler registered')
    return this.windowOpen({ url })
  }

  emit(event: 'will-navigate' | 'will-redirect', target: string): FakeEvent {
    const cancelled = { preventDefault: vi.fn() }
    for (const listener of this.listeners.get(event) ?? []) listener(cancelled, target)
    return cancelled
  }
}

/**
 * Install the sign-in policy on a fake contents.
 * @param load - what the policy loads in the sign-in window.
 * @returns the fake contents and the loader.
 */
function setup(load: (url: string) => Promise<unknown> = async () => undefined): {
  contents: FakeContents
  load: ReturnType<typeof vi.fn>
} {
  const contents = new FakeContents()
  const loader = vi.fn(load)
  installLoginNavigationPolicy(contents, loader)
  return { contents, load: loader }
}

describe('loginNavigationTarget', () => {
  it.each([
    ['https://identity.example/authorize?client=1', 'https://identity.example/authorize?client=1'],
    ['http://localhost:3000/callback', 'http://localhost:3000/callback'],
    ['HTTP://EXAMPLE.COM/Path', 'http://example.com/Path'],
  ])('accepts credential-free HTTP(S) %s', (target, href) => {
    expect(loginNavigationTarget(target)).toBe(href)
  })

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://identity.example/id',
    'about:blank',
    'ftp://identity.example/',
    'tel:+123',
    'ms-settings:privacy',
    'custom-app://callback',
    'C:\\Windows',
    '\\\\server\\share',
    'relative/path',
    '//identity.example/authorize',
    'https://',
    'https://user:pass@identity.example/',
    'https://user@identity.example/',
    ' https://identity.example/',
    'https://identity.example\\@evil.example/',
    'https://identity\u0000.example/',
  ])('refuses %s', (target) => {
    expect(loginNavigationTarget(target)).toBeUndefined()
  })
})

describe('installLoginNavigationPolicy', () => {
  it('follows a cross-origin HTTP(S) popup in the same window and denies a second window', async () => {
    const { contents, load } = setup()
    expect(contents.popup('https://identity.example/authorize?client=1')).toEqual({ action: 'deny' })
    expect(load).toHaveBeenCalledExactlyOnceWith('https://identity.example/authorize?client=1')
    await Promise.resolve()
  })

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'about:blank',
    'https://user:pass@identity.example/',
  ])('does not load dangerous popup %s', (target) => {
    const { contents, load } = setup()
    expect(contents.popup(target)).toEqual({ action: 'deny' })
    expect(load).not.toHaveBeenCalled()
  })

  it('swallows a rejected hand-off load without reporting it as unhandled', async () => {
    const { contents } = setup(async () => { throw new Error('load failed') })
    expect(contents.popup('https://identity.example/authorize')).toEqual({ action: 'deny' })
    await Promise.resolve()
  })

  it.each([
    'https://identity.example/authorize?client=1',
    'http://localhost:3000/callback',
    'https://other-idp.example/login',
  ])('keeps a cross-origin top-level navigation %s', (target) => {
    const { contents } = setup()
    expect(contents.emit('will-navigate', target).preventDefault).not.toHaveBeenCalled()
  })

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'ftp://identity.example/',
    'https://user:pass@identity.example/',
    'relative/path',
  ])('cancels a dangerous top-level navigation %s', (target) => {
    const { contents } = setup()
    expect(contents.emit('will-navigate', target).preventDefault).toHaveBeenCalledOnce()
  })

  it.each([
    'https://identity.example/authorize?client=1',
    'https://other-idp.example/login',
  ])('keeps a cross-origin redirect %s', (target) => {
    const { contents } = setup()
    expect(contents.emit('will-redirect', target).preventDefault).not.toHaveBeenCalled()
  })

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'https://user:pass@identity.example/',
    'https://',
  ])('cancels a dangerous redirect %s', (target) => {
    const { contents } = setup()
    expect(contents.emit('will-redirect', target).preventDefault).toHaveBeenCalledOnce()
  })
})
