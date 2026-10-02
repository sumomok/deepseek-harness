// @vitest-environment jsdom
/**
 * The window-backed browser against page globals the spec assembles: which
 * navigation entry and address it reads, which module scripts it finds in the
 * live document and in a served index, the exact request it makes for the
 * index, session storage, the reload, the clock, and the foreground and
 * network subscriptions.
 */

import { describe, expect, it, vi } from 'vitest'
import { moduleScriptsOf, windowPageRefreshBrowser, type PageGlobals } from '../src/client/browser.ts'

/** Page globals over a jsdom document, with every impure member recorded. */
function bench(options: { navigation?: { name: string }[]; boot?: unknown } = {}) {
  const document = new DOMParser().parseFromString(
    '<html><head><base href="https://console.example/console/">'
      + '<script type="module" src="./assets/index-A.js"></script>'
      + '<script type="module">inline()</script>'
      + '<script src="plugins/x.js"></script></head><body></body></html>',
    'text/html',
  )
  let visibility: DocumentVisibilityState = 'visible'
  const storage = new Map<string, string>()
  const windowListeners = new Map<string, Set<() => void>>()
  const reload = vi.fn()
  const fetch = vi.fn(async (_input: string, _init: RequestInit) => new Response('<html></html>', {
    status: 200, headers: { 'content-type': 'text/html' },
  }))
  const setTimeout = vi.fn((_run: () => void, _delayMs: number) => 7)
  const clearTimeout = vi.fn()
  const page: PageGlobals = {
    location: { href: 'https://console.example/console/#x', reload },
    sessionStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value) },
      removeItem: (key) => { storage.delete(key) },
    },
    performance: { getEntriesByType: () => (options.navigation ?? []) as never },
    document: Object.assign(document, {}),
    navigator: { onLine: true },
    DOMParser,
    __DSH_BOOT__: options.boot,
    fetch,
    setTimeout,
    clearTimeout,
    addEventListener: (type, listener) => {
      const listeners = windowListeners.get(type) ?? new Set()
      listeners.add(listener)
      windowListeners.set(type, listeners)
    },
    removeEventListener: (type, listener) => { windowListeners.get(type)?.delete(listener) },
  }
  Object.defineProperty(document, 'visibilityState', { get: () => visibility })
  return {
    browser: windowPageRefreshBrowser(page),
    page, document, storage, reload, fetch, setTimeout, clearTimeout, windowListeners,
    setVisibility: (next: DocumentVisibilityState) => {
      visibility = next
      document.dispatchEvent(new Event('visibilitychange'))
    },
  }
}

describe('the page\'s own document', () => {
  it('reads the navigation entry\'s URL, and nothing when the page records none', () => {
    expect(bench({ navigation: [{ name: 'https://console.example/console/' }] }).browser.navigationUrl())
      .toBe('https://console.example/console/')
    expect(bench().browser.navigationUrl()).toBeUndefined()
  })

  it('reads the current address and the boot global as assigned', () => {
    const boot = { entries: [] }
    const { browser } = bench({ boot })
    expect(browser.currentHref()).toBe('https://console.example/console/#x')
    expect(browser.bootGraph()).toBe(boot)
  })

  it('lists the module scripts that name a source, resolved against the document base', () => {
    expect(bench().browser.moduleScripts()).toEqual(['https://console.example/console/assets/index-A.js'])
  })
})

describe('a served index', () => {
  it('resolves module sources against the index\'s own base, relative to the address it came from', () => {
    const { browser } = bench()
    const html = '<html><head><base href="./"><script type="module" src="./assets/index-B.js"></script></head></html>'
    expect(browser.moduleScriptsIn(html, 'https://console.example/console/'))
      .toEqual(['https://console.example/console/assets/index-B.js'])
  })

  it('resolves against the address itself when the index carries no base', () => {
    const { browser } = bench()
    const html = '<html><head><script type="module" src="assets/index-B.js"></script></head></html>'
    expect(browser.moduleScriptsIn(html, 'https://console.example/a/index.html'))
      .toEqual(['https://console.example/a/assets/index-B.js'])
  })

  it('sorts the scripts so their order in the document plays no part', () => {
    const root = new DOMParser().parseFromString(
      '<script type="module" src="b.js"></script><script type="module" src="a.js"></script>', 'text/html',
    )
    expect(moduleScriptsOf(root, 'https://x.example/')).toEqual(['https://x.example/a.js', 'https://x.example/b.js'])
  })

  it('leaves out module scripts whose source lies outside the base directory', () => {
    const root = new DOMParser().parseFromString(
      '<script type="module" src="./assets/index-A.js"></script>'
        + '<script type="module" src="https://extension.invalid/main-world-inject.js"></script>'
        + '<script type="module" src="/elsewhere/inject.js"></script>'
        + '<script type="module" src="chrome-extension://abc/inject.js"></script>',
      'text/html',
    )
    expect(moduleScriptsOf(root, 'https://console.example/console/'))
      .toEqual(['https://console.example/console/assets/index-A.js'])
    // A base that names a file reads its directory.
    expect(moduleScriptsOf(root, 'https://console.example/console/index.html'))
      .toEqual(['https://console.example/console/assets/index-A.js'])
  })

  it('reads the same build from a live page carrying a foreign module script as from its served index', () => {
    const { browser, document } = bench()
    const foreign = document.createElement('script')
    foreign.type = 'module'
    foreign.src = 'https://extension.invalid/main-world-inject.js'
    document.head.append(foreign)
    const served = '<html><head><base href="./"><script type="module" src="./assets/index-A.js"></script></head></html>'
    expect(browser.moduleScripts()).toEqual(browser.moduleScriptsIn(served, 'https://console.example/console/'))
  })

  it('leaves out a module script whose source does not parse, on the live page and in a served index alike', () => {
    const { browser, document } = bench()
    const sources = ['https://exa mple.com/x.js', '//']
    for (const src of sources) {
      const script = document.createElement('script')
      script.type = 'module'
      script.setAttribute('src', src)
      document.head.append(script)
    }
    const unparsable = sources.map(src => `<script type="module" src="${src}"></script>`).join('')
    const served = `<html><head><base href="./"><script type="module" src="./assets/index-A.js"></script>${unparsable}</head></html>`
    expect(browser.moduleScripts()).toEqual(['https://console.example/console/assets/index-A.js'])
    expect(browser.moduleScriptsIn(served, 'https://console.example/console/')).toEqual(browser.moduleScripts())
  })

  it('requests it uncached, without following redirects, with the page\'s own cookies', async () => {
    const { browser, fetch } = bench()
    const signal = new AbortController().signal
    const answer = await browser.fetchDocument('https://console.example/console/', signal)
    expect(fetch).toHaveBeenCalledWith('https://console.example/console/', {
      cache: 'no-store', redirect: 'manual', credentials: 'same-origin', signal,
    })
    expect({ status: answer.status, contentType: answer.contentType, body: await answer.text() })
      .toEqual({ status: 200, contentType: 'text/html', body: '<html></html>' })
  })
})

describe('the page operations', () => {
  it('reads, writes, and removes session storage', () => {
    const { browser, storage } = bench()
    expect(browser.readSession('k')).toBeNull()
    browser.writeSession('k', 'v')
    expect(storage.get('k')).toBe('v')
    expect(browser.readSession('k')).toBe('v')
    browser.removeSession('k')
    expect(storage.has('k')).toBe(false)
  })

  it('reloads through the location', () => {
    const { browser, reload } = bench()
    browser.reload()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('schedules on the page clock and cancels what it scheduled', () => {
    const { browser, setTimeout, clearTimeout } = bench()
    const run = vi.fn()
    const cancel = browser.schedule(250, run)
    expect(setTimeout).toHaveBeenCalledWith(run, 250)
    cancel()
    expect(clearTimeout).toHaveBeenCalledWith(7)
  })

  it('reports the page returning to the foreground, and not leaving it', () => {
    const { browser, setVisibility } = bench()
    const listener = vi.fn()
    const stop = browser.onVisible(listener)
    setVisibility('hidden')
    expect(listener).not.toHaveBeenCalled()
    setVisibility('visible')
    expect(listener).toHaveBeenCalledOnce()
    stop()
    setVisibility('visible')
    expect(listener).toHaveBeenCalledOnce()
  })

  it('reads the network state and follows both of its changes', () => {
    const { browser, windowListeners } = bench()
    expect(browser.online()).toBe(true)
    const listener = vi.fn()
    const stop = browser.onOnlineChange(listener)
    for (const listeners of windowListeners.values()) for (const subscriber of listeners) subscriber()
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
    expect([...windowListeners.values()].every(listeners => listeners.size === 0)).toBe(true)
  })
})
