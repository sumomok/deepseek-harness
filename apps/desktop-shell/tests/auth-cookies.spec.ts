/**
 * Clearing the browser-session cookies earlier launches left on `127.0.0.1`:
 * which cookies go, at which path, what a failure costs, and where the launch
 * sequence runs it.
 * @module
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AUTH_COOKIE_PREFIX, clearStaleAuthCookies, type CookieStore, type StoredCookie } from '../src/auth-cookies.ts'

/** A cookie store holding `cookies`, recording every call made on it. */
function fakeStore(cookies: StoredCookie[], options: { failRemoving?: string; failReading?: boolean } = {}) {
  const reads: { domain: string }[] = []
  const removals: { url: string; name: string }[] = []
  const store: CookieStore = {
    get: (filter) => {
      reads.push(filter)
      return options.failReading === true ? Promise.reject(new Error('store closed')) : Promise.resolve(cookies)
    },
    remove: (url, name) => {
      removals.push({ url, name })
      return name === options.failRemoving ? Promise.reject(new Error('locked')) : Promise.resolve()
    },
  }
  return { store, reads, removals }
}

/** Sixty stale session cookies, every tenth one under a path other than `/`, and one with no path at all. */
function staleCookies(): StoredCookie[] {
  return Array.from({ length: 60 }, (_, index) => {
    const name = `${AUTH_COOKIE_PREFIX}${index.toString(16).padStart(64, '0')}`
    if (index === 59) return { name }
    return { name, path: index % 10 === 0 ? '/app' : '/' }
  })
}

describe('clearStaleAuthCookies', () => {
  it('removes every dsh-auth-* cookie on 127.0.0.1 and leaves the others', async () => {
    const others = [{ name: 'theme', path: '/' }, { name: 'dsh-authority', path: '/' }]
    const { store, reads, removals } = fakeStore([...staleCookies(), ...others])
    const removed = await clearStaleAuthCookies(store, () => {})
    expect(reads).toEqual([{ domain: '127.0.0.1' }])
    expect(removed).toBe(60)
    expect(removals.map(removal => removal.name).sort()).toEqual(staleCookies().map(cookie => cookie.name).sort())
    expect(removals.some(removal => others.some(other => other.name === removal.name))).toBe(false)
  })

  it('removes each cookie at its own path, and at / for a cookie stored without one', async () => {
    const { store, removals } = fakeStore(staleCookies())
    await clearStaleAuthCookies(store, () => {})
    const at = (index: number): string | undefined => removals.find(removal => removal.name.endsWith(index.toString(16).padStart(64, '0')))?.url
    expect(at(0)).toBe('http://127.0.0.1/app')
    expect(at(1)).toBe('http://127.0.0.1/')
    expect(at(59)).toBe('http://127.0.0.1/')
  })

  it('keeps going past a removal that fails, and logs it', async () => {
    const cookies = staleCookies()
    const failing = cookies[3]?.name ?? ''
    const { store, removals } = fakeStore(cookies, { failRemoving: failing })
    const lines: string[] = []
    const removed = await clearStaleAuthCookies(store, (line) => { lines.push(line) })
    expect(removals).toHaveLength(60)
    expect(removed).toBe(59)
    expect(lines.some(line => line.includes(`could not remove cookie ${failing}`))).toBe(true)
    expect(lines.some(line => line.includes('removed 59 browser-session cookies'))).toBe(true)
  })

  it('resolves rather than throws when the store cannot be read, and logs it', async () => {
    const { store, removals } = fakeStore(staleCookies(), { failReading: true })
    const lines: string[] = []
    await expect(clearStaleAuthCookies(store, (line) => { lines.push(line) })).resolves.toBe(0)
    expect(removals).toEqual([])
    expect(lines).toEqual([expect.stringContaining('could not read the 127.0.0.1 cookies')])
  })

  it('writes nothing to the log when there is nothing to remove', async () => {
    const { store } = fakeStore([{ name: 'theme', path: '/' }])
    const lines: string[] = []
    await clearStaleAuthCookies(store, (line) => { lines.push(line) })
    expect(lines).toEqual([])
  })
})

describe('the launch sequence in main.ts', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')

  it('awaits the clearing exactly once, after the orphan sweep and before the server spawn', () => {
    const calls = [...source.matchAll(/clearStaleAuthCookies\(/g)].map(match => match.index)
    expect(calls).toHaveLength(1)
    const [call = -1] = calls
    expect(source.slice(call - 'await '.length, call)).toBe('await ')
    expect(source.indexOf('await sweepOrphanedServers(')).toBeLessThan(call)
    // The launch's spawn is its `startOnPort` call, the last one in the file;
    // the one before it is the crash rebind's.
    expect(source.lastIndexOf('await startOnPort(')).toBeGreaterThan(call)
  })

  it('leaves cookies alone on every path that reopens a window or rebinds the server', () => {
    const bodyOf = (signature: string): string => {
      const start = source.indexOf(signature)
      expect(start).toBeGreaterThan(-1)
      return source.slice(start, source.indexOf('\n}\n', start))
    }
    for (const signature of ['function reveal(', 'function createAppWindow(', 'function createBootWindow(', 'async function performRebind(', 'function retargetWindows(']) {
      expect(bodyOf(signature)).not.toMatch(/cookies|clearStaleAuthCookies/)
    }
  })
})
