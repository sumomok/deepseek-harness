/**
 * The footer's identity read: dropping the login page's `Bearer` scheme,
 * decoding a payload nothing verifies, resolving the configured claim,
 * reading the node half's settings route, and the storage watch the display
 * name follows.
 *
 * The page's globals are stubbed rather than run under jsdom (the same shape
 * `@deepseek-ai/dsh-experimental-auth-gate`'s own browser spec uses), so each
 * assertion states exactly what storage held and what the page was told.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDisplayNameSource,
  decodeJwtPayload,
  displayNameFrom,
  readIdentitySettings,
  storedToken,
  subscribeIdentity,
} from '../src/client/identity.ts'
import { SERVER_IDENTITY_ROUTE } from '../src/route.ts'

/** Build a JWT-shaped string carrying one payload; no signature is produced or checked. */
function jwt(payload: Record<string, unknown>): string {
  const body = btoa(JSON.stringify(payload)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  return `header.${body}.signature`
}

/** Stub `localStorage` plus the two listener globals, and expose the registered storage listener. */
function stubPage(stored: string | null): { listeners: Map<string, (event: StorageEvent) => void> } {
  const listeners = new Map<string, (event: StorageEvent) => void>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => (key === 'accessToken' ? stored : null) })
  vi.stubGlobal('addEventListener', (type: string, listener: (event: StorageEvent) => void) => {
    listeners.set(type, listener)
  })
  vi.stubGlobal('removeEventListener', (type: string) => { listeners.delete(type) })
  return { listeners }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('storedToken', () => {
  it('drops the login page\'s Bearer scheme in any casing, and leaves everything else alone', () => {
    expect(storedToken('Bearer a.b.c')).toBe('a.b.c')
    expect(storedToken('  bearer   a.b.c')).toBe('a.b.c')
    expect(storedToken('a.b.c')).toBe('a.b.c')
  })

  it('answers nothing stored as nothing', () => {
    expect(storedToken(null)).toBeNull()
  })
})

describe('decodeJwtPayload', () => {
  it('reads the claim set out of the middle segment', () => {
    expect(decodeJwtPayload(jwt({ login_uname: 'Signed-in Person', sub: 'u-1' }))).toEqual({ login_uname: 'Signed-in Person', sub: 'u-1' })
  })

  it('refuses a payload that is not base64url-encoded JSON', () => {
    expect(decodeJwtPayload('header.@@@@.signature')).toBeUndefined()
  })

  it('refuses a payload that decodes to something other than a claim set', () => {
    const array = btoa(JSON.stringify(['nope'])).replaceAll('=', '')
    expect(decodeJwtPayload(`header.${array}.signature`)).toBeUndefined()
  })
})

describe('displayNameFrom', () => {
  it('answers the configured claim', () => {
    expect(displayNameFrom(`Bearer ${jwt({ login_uname: 'Signed-in Person' })}`, 'login_uname')).toBe('Signed-in Person')
  })

  it('answers nothing when nothing is stored', () => {
    expect(displayNameFrom(null, 'login_uname')).toBeUndefined()
  })

  it('answers nothing when the claim is absent, empty, or not a string', () => {
    expect(displayNameFrom(jwt({ sub: 'u-1' }), 'login_uname')).toBeUndefined()
    expect(displayNameFrom(jwt({ login_uname: '' }), 'login_uname')).toBeUndefined()
    expect(displayNameFrom(jwt({ login_uname: 42 }), 'login_uname')).toBeUndefined()
  })
})

describe('readIdentitySettings', () => {
  /** Stub one answer from the identity route. */
  function stubRoute(answer: { ok?: boolean; body?: unknown; reject?: boolean }): ReturnType<typeof vi.fn> {
    const fetcher = vi.fn((input: string) => {
      expect(input).toBe(SERVER_IDENTITY_ROUTE)
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a transport failure with no Error is the case under test.
      if (answer.reject === true) return Promise.reject('offline')
      return Promise.resolve({
        ok: answer.ok ?? true,
        status: answer.ok === false ? 404 : 200,
        json: () => Promise.resolve(answer.body),
      })
    })
    vi.stubGlobal('fetch', fetcher)
    return fetcher
  }

  it('reads the configured claim, uncached', async () => {
    const fetcher = stubRoute({ body: { displayNameClaim: 'login_uname' } })
    await expect(readIdentitySettings()).resolves.toEqual({ displayNameClaim: 'login_uname' })
    expect(fetcher).toHaveBeenCalledWith(SERVER_IDENTITY_ROUTE, { cache: 'no-store' })
  })

  it('contains a route the composition never claimed', async () => {
    stubRoute({ ok: false })
    await expect(readIdentitySettings()).resolves.toBeUndefined()
  })

  it('contains a document with no usable claim name', async () => {
    stubRoute({ body: { displayNameClaim: '' } })
    await expect(readIdentitySettings()).resolves.toBeUndefined()
    stubRoute({ body: { displayNameClaim: 7 } })
    await expect(readIdentitySettings()).resolves.toBeUndefined()
  })

  it('contains a transport failure rather than failing the row', async () => {
    stubRoute({ reject: true })
    await expect(readIdentitySettings()).resolves.toBeUndefined()
  })
})

describe('subscribeIdentity', () => {
  it('reacts to the token key and to a cleared store, and to nothing else', () => {
    const page = stubPage(null)
    const seen: number[] = []
    const unsubscribe = subscribeIdentity(() => seen.push(1))
    const deliver = (key: string | null): void => { page.listeners.get('storage')?.({ key } as StorageEvent) }
    deliver('accessToken')
    deliver(null)
    deliver('unrelated')
    expect(seen).toHaveLength(2)
    unsubscribe()
    expect(page.listeners.has('storage')).toBe(false)
  })
})

describe('createDisplayNameSource', () => {
  it('reads the name out of the stored token', () => {
    stubPage(`Bearer ${jwt({ login_uname: 'Signed-in Person' })}`)
    expect(createDisplayNameSource('login_uname').getSnapshot()).toBe('Signed-in Person')
  })

  it('answers nothing when the settings route named no claim', () => {
    stubPage(jwt({ login_uname: 'Signed-in Person' }))
    expect(createDisplayNameSource(undefined).getSnapshot()).toBeUndefined()
  })

  it('notifies every subscriber when another tab replaces the token', () => {
    let stored: string | null = jwt({ login_uname: 'Signed-in Person' })
    const listeners = new Set<(event: StorageEvent) => void>()
    vi.stubGlobal('localStorage', { getItem: () => stored })
    vi.stubGlobal('addEventListener', (type: string, listener: (event: StorageEvent) => void) => {
      if (type === 'storage') listeners.add(listener)
    })
    vi.stubGlobal('removeEventListener', (type: string, listener: (event: StorageEvent) => void) => {
      if (type === 'storage') listeners.delete(listener)
    })
    const source = createDisplayNameSource('login_uname')
    const first: number[] = []
    const second: number[] = []
    const unsubscribeFirst = source.subscribe(() => first.push(1))
    const unsubscribeSecond = source.subscribe(() => second.push(1))
    const deliver = (): void => {
      for (const listener of [...listeners]) listener({ key: 'accessToken' } as StorageEvent)
    }

    stored = jwt({ login_uname: 'The Other Person' })
    deliver()
    // Neither subscriber may eat the other's notification: each is told, and
    // both read the new name.
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(source.getSnapshot()).toBe('The Other Person')

    unsubscribeFirst()
    unsubscribeSecond()
    expect(listeners.size).toBe(0)
  })

  it('reads the name afresh, so a token that moved while nobody listened is still current', () => {
    let stored: string | null = jwt({ login_uname: 'Signed-in Person' })
    vi.stubGlobal('localStorage', { getItem: () => stored })
    const source = createDisplayNameSource('login_uname')
    expect(source.getSnapshot()).toBe('Signed-in Person')

    // No subscription is live here — the sidebar between an unmount and the
    // next mount, or between this factory and the first mount.
    stored = null
    expect(source.getSnapshot()).toBeUndefined()
  })
})
