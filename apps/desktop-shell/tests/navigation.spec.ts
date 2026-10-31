/**
 * The boot window's navigation policy against a fake web contents: popups are
 * denied after resolution, foreign navigations are cancelled before the OS is
 * asked, same-origin navigations stay, and redirects never launch a browser.
 * The fake registers the same handlers main.ts registers, so the behavior under
 * test is the real handler code rather than a source-string assertion.
 * @module
 */

import { describe, expect, it, vi } from 'vitest'
import type { NavigationContents } from '../src/navigation.ts'
import { installNavigationPolicy, isServerNavigation } from '../src/navigation.ts'

type NavigationListener = (event: { preventDefault(): void }, target: string, isInPlace: boolean, isMainFrame: boolean) => void

/** A cancellable event that records whether the policy stopped it. */
interface FakeEvent {
  preventDefault: () => void
}

/** A web contents stand-in that records handlers and invokes them like Electron. */
class FakeContents implements NavigationContents {
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

  /**
   * Invoke the registered popup handler.
   * @param url - popup target.
   * @returns the deny decision the real handler returns.
   */
  popup(url: string): { action: 'deny' } {
    if (this.windowOpen === undefined) throw new Error('no popup handler registered')
    return this.windowOpen({ url })
  }

  /**
   * Invoke every listener for one navigation event with a fresh cancellable event.
   * @param event - `will-navigate` or `will-redirect`.
   * @param target - navigation target.
   * @param isMainFrame - whether the target belongs to the main frame.
   * @returns the event the listeners saw.
   */
  emit(event: 'will-navigate' | 'will-redirect', target: string, isMainFrame = true): FakeEvent {
    return this.emitWith(event, { preventDefault: vi.fn() }, target, isMainFrame)
  }

  /**
   * Invoke every listener with a caller-owned event, so a case can observe order.
   * @param event - `will-navigate` or `will-redirect`.
   * @param target - the event object the listeners receive.
   * @param url - navigation target.
   * @param isMainFrame - whether the target belongs to the main frame.
   * @returns the same event object.
   */
  emitWith(event: 'will-navigate' | 'will-redirect', target: FakeEvent, url: string, isMainFrame = true): FakeEvent {
    for (const listener of this.listeners.get(event) ?? []) listener(target, url, false, isMainFrame)
    return target
  }
}

/** The server origin every case treats as the running app. */
const SERVER = 'http://127.0.0.1:49321'

/**
 * Install the policy with a recording opener and log.
 * @param serverUrl - the server URL source; the running default unless overridden.
 * @returns the fake web contents and the observed calls.
 */
function setup(serverUrl: () => string | undefined = () => SERVER): {
  contents: FakeContents
  opened: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
} {
  const contents = new FakeContents()
  const opened = vi.fn(async () => undefined)
  const log = vi.fn()
  installNavigationPolicy(contents, { serverUrl, openExternal: opened, log })
  return { contents, opened, log }
}

describe('isServerNavigation', () => {
  const server = SERVER

  it('keeps targets on the server origin, any path', () => {
    expect(isServerNavigation('http://127.0.0.1:49321/', server)).toBe(true)
    expect(isServerNavigation('http://127.0.0.1:49321/?token=t#x', server)).toBe(true)
  })

  it('declines a target that only starts with the origin text', () => {
    expect(isServerNavigation('http://127.0.0.1:49321@evil.example/', server)).toBe(false)
    expect(isServerNavigation('http://127.0.0.1:493210/', server)).toBe(false)
    expect(isServerNavigation('http://127.0.0.1:49321.evil.example/', server)).toBe(false)
  })

  it('declines another port, scheme, host, credentials, or anything unparsable', () => {
    expect(isServerNavigation('http://127.0.0.1:49322/', server)).toBe(false)
    expect(isServerNavigation('https://127.0.0.1:49321/', server)).toBe(false)
    expect(isServerNavigation('http://localhost:49321/', server)).toBe(false)
    expect(isServerNavigation('http://user:pass@127.0.0.1:49321/', server)).toBe(false)
    expect(isServerNavigation('not a url', server)).toBe(false)
    expect(isServerNavigation('http://127.0.0.1:49321\\@evil.example/', server)).toBe(false)
  })
})

describe('installNavigationPolicy popups', () => {
  it.each([
    ['https://example.com/page?q=1#x', 'https://example.com/page?q=1#x'],
    ['http://Example.COM', 'http://example.com/'],
    ['mailto:dev@example.com?subject=Hello%20World', 'mailto:dev@example.com?subject=Hello%20World'],
  ])('opens %s after resolving it and always denies the popup', async (target, href) => {
    const { contents, opened } = setup()
    expect(contents.popup(target)).toEqual({ action: 'deny' })
    expect(opened).toHaveBeenCalledExactlyOnceWith(href)
  })

  it.each([
    'httpx://example.com',
    'httpsfoo://example.com',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://example.com/id',
    'about:blank',
    'ftp://example.com/',
    'tel:+123',
    'ms-settings:privacy',
    'custom-app://action',
    'C:\\Windows\\System32',
    '\\\\server\\share',
    'C:/Windows',
    'relative/path',
    '//example.com',
    'https://',
    'https://user:pass@example.com/',
    'https://user@example.com/',
    'mailto://user:pass@example.com/',
    'mailto://user@example.com/',
    ' https://example.com',
    'https://exa\u0000mple.com',
    'https://example.com\\@evil.example/',
  ])('denies %s without calling the opener', (target) => {
    const { contents, opened } = setup()
    expect(contents.popup(target)).toEqual({ action: 'deny' })
    expect(opened).not.toHaveBeenCalled()
  })

  it('logs an opener rejection without leaking the target query or credentials', async () => {
    const contents = new FakeContents()
    const opened = vi.fn(async () => { throw new Error('failed https://example.com/?token=secret') })
    const log = vi.fn()
    installNavigationPolicy(contents, { serverUrl: () => SERVER, openExternal: opened, log })
    contents.popup('https://example.com/path?token=secret#fragment')
    await vi.waitFor(() => { expect(log).toHaveBeenCalledOnce() })
    const line = log.mock.calls[0]![0] as string
    expect(line).toBe('[external] opening the target failed\n')
    expect(line).not.toContain('secret')
    expect(line).not.toContain('token')
  })

  it('logs a synchronous opener failure', () => {
    const contents = new FakeContents()
    const log = vi.fn()
    installNavigationPolicy(contents, {
      serverUrl: () => SERVER,
      openExternal: () => { throw new Error('query=secret') },
      log,
    })
    contents.popup('https://example.com/path')
    expect(log).toHaveBeenCalledExactlyOnceWith('[external] opening the target failed\n')
  })
})

describe('installNavigationPolicy navigations', () => {
  it('keeps a same-origin navigation in the window', () => {
    const { contents, opened } = setup()
    const event = contents.emit('will-navigate', 'http://127.0.0.1:49321/session/1?token=t')
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(opened).not.toHaveBeenCalled()
  })

  it('cancels a foreign navigation before opening the OS', () => {
    const contents = new FakeContents()
    let prevented = false
    let preventedWhenOpened = false
    installNavigationPolicy(contents, {
      serverUrl: () => SERVER,
      openExternal: () => { preventedWhenOpened = prevented },
      log: vi.fn(),
    })
    const event = {
      preventDefault: vi.fn(() => { prevented = true }),
    }
    contents.emitWith('will-navigate', event, 'https://example.com/page')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(preventedWhenOpened).toBe(true)
  })

  it.each([
    ['https://example.com/page?q=1#x', 'https://example.com/page?q=1#x'],
    ['HTTP://EXAMPLE.COM', 'http://example.com/'],
    ['mailto:dev@example.com', 'mailto:dev@example.com'],
  ])('cancels %s and opens the resolved target', (target, href) => {
    const { contents, opened } = setup()
    const event = contents.emit('will-navigate', target)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(opened).toHaveBeenCalledExactlyOnceWith(href)
  })

  it.each([
    'httpx://example.com',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://example.com/id',
    'about:blank',
    'ftp://example.com/',
    'tel:+123',
    'ms-settings:privacy',
    'C:\\Windows',
    'relative/path',
    'https://',
    'https://user:pass@example.com/',
    'https://exa\u0000mple.com',
  ])('cancels %s without opening the OS', (target) => {
    const { contents, opened } = setup()
    const event = contents.emit('will-navigate', target)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(opened).not.toHaveBeenCalled()
  })

  it('cancels an unparsable target without throwing', () => {
    const { contents, opened } = setup()
    const event = contents.emit('will-navigate', 'http://[::1')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(opened).not.toHaveBeenCalled()
  })

  it('cancels a navigation while the server URL is not known yet', () => {
    const { contents, opened } = setup(() => undefined)
    const event = contents.emit('will-navigate', 'https://example.com/page')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(opened).toHaveBeenCalledExactlyOnceWith('https://example.com/page')
  })
})

describe('installNavigationPolicy redirects', () => {
  it('allows a redirect that stays on the server origin', () => {
    const { contents, opened } = setup()
    const event = contents.emit('will-redirect', 'http://127.0.0.1:49321/next')
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(opened).not.toHaveBeenCalled()
  })

  it.each([
    'https://evil.example/',
    'http://127.0.0.1:49322/',
    'http://user:pass@127.0.0.1:49321/',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'relative/path',
  ])('cancels a main-frame redirect to %s without opening the OS', (target) => {
    const { contents, opened } = setup()
    const event = contents.emit('will-redirect', target)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(opened).not.toHaveBeenCalled()
  })

  it.each([
    'https://evil.example/',
    'http://127.0.0.1:49322/',
    'http://user:pass@127.0.0.1:49321/',
    'https://127.0.0.1:49321/after-login',
  ])('keeps a subframe redirect to %s out of the top-level policy', (target) => {
    const { contents, opened } = setup()
    const event = contents.emit('will-redirect', target, false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(opened).not.toHaveBeenCalled()
  })

  it('keeps subframe redirects before the server URL is known', () => {
    const { contents, opened } = setup(() => undefined)
    const event = contents.emit('will-redirect', 'https://evil.example/', false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(opened).not.toHaveBeenCalled()
  })

  it('cancels a main-frame redirect before the server URL is known', () => {
    const { contents } = setup(() => undefined)
    const event = contents.emit('will-redirect', 'https://evil.example/')
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })
})
