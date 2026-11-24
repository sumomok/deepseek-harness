// @vitest-environment jsdom
/** The comparison store: served and missing comparisons stay, failures retry, resets and disposal forget. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { changesDiffUrl, changesSummaryUrl, type ChangesDiff } from '../src/changes.ts'
import { ChangesDiffStore } from '../src/client/changes-diff.ts'
import { ChangesSummaryStore } from '../src/client/changes-summary.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

afterEach(() => { vi.unstubAllGlobals() })

const SESSION = brandString<SessionId>('viewed')
const URL_ = changesDiffUrl(SESSION, 5, 1)
const text: ChangesDiff = {
  kind: 'text', path: 'a.ts', display: 'a.ts', before: true, after: true, coarse: false,
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
}

describe('ChangesDiffStore', () => {
  it('keeps served and missing comparisons, retries failures, and forgets on reset and disposal', async () => {
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
    vi.stubGlobal('fetch', fetcher)
    const store = new ChangesDiffStore()
    fetcher.mockResolvedValueOnce(Response.json(text))
    await store.load(SESSION, 5, 1)
    expect(store.state.getSnapshot()[URL_]).toEqual(text)
    await store.load(SESSION, 5, 1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    fetcher.mockResolvedValueOnce(new Response('gone', { status: 404 }))
    await store.load(SESSION, 5, 2)
    expect(store.state.getSnapshot()[changesDiffUrl(SESSION, 5, 2)]).toBe('missing')
    await store.load(SESSION, 5, 2)
    expect(fetcher).toHaveBeenCalledTimes(2)
    fetcher.mockResolvedValueOnce(new Response('boom', { status: 500 }))
    await store.load(SESSION, 5, 3)
    expect(store.state.getSnapshot()[changesDiffUrl(SESSION, 5, 3)]).toBe('error')
    fetcher.mockResolvedValueOnce(Response.json({ kind: 'text' }))
    await store.load(SESSION, 5, 3)
    expect(store.state.getSnapshot()[changesDiffUrl(SESSION, 5, 3)]).toBe('error')
    fetcher.mockRejectedValueOnce(new Error('offline'))
    await store.load(SESSION, 5, 3)
    expect(store.state.getSnapshot()[changesDiffUrl(SESSION, 5, 3)]).toBe('error')
    fetcher.mockResolvedValueOnce(Response.json({ kind: 'oversized', path: 'p', display: 'p' }))
    await store.load(SESSION, 5, 3)
    expect(store.state.getSnapshot()[changesDiffUrl(SESSION, 5, 3)]).toEqual({ kind: 'oversized', path: 'p', display: 'p' })
    store.reset()
    expect(store.state.getSnapshot()).toEqual({})
    let settle!: (response: Response) => void
    fetcher.mockReturnValueOnce(new Promise<Response>((resolve) => { settle = resolve }))
    const stale = store.load(SESSION, 5, 1)
    expect(store.state.getSnapshot()[URL_]).toBe('loading')
    store.reset()
    settle(Response.json(text))
    await stale
    expect(store.state.getSnapshot()[URL_]).toBeUndefined()
    fetcher.mockReturnValueOnce(new Promise<Response>((resolve) => { settle = resolve }))
    const late = store.load(SESSION, 5, 1)
    const disposal = store.dispose()
    settle(Response.json(text))
    await Promise.all([late, disposal])
    expect(store.state.getSnapshot()[URL_]).toBe('loading')
    await store.load(SESSION, 6, 0)
    expect(store.state.getSnapshot()[changesDiffUrl(SESSION, 6, 0)]).toBeUndefined()
  })

  it('evicts least-recently-used unpinned entries while keeping pinned and in-flight entries intact', async () => {
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
    vi.stubGlobal('fetch', fetcher)
    const store = new ChangesDiffStore(2)
    const u0 = changesDiffUrl(SESSION, 5, 0)
    const u1 = changesDiffUrl(SESSION, 5, 1)
    const u2 = changesDiffUrl(SESSION, 5, 2)
    const u3 = changesDiffUrl(SESSION, 5, 3)

    fetcher.mockImplementation(async () => Response.json(text))
    await store.load(SESSION, 5, 0)
    await store.load(SESSION, 5, 1)
    // Cache hit refreshes u0 recency so u1 becomes least recently used.
    await store.load(SESSION, 5, 0)
    await store.load(SESSION, 5, 2)
    expect(store.state.getSnapshot()[u1]).toBeUndefined()
    expect(Object.hasOwn(store.state.getSnapshot(), u1)).toBe(false)
    expect(store.state.getSnapshot()[u0]).toEqual(text)
    expect(store.state.getSnapshot()[u2]).toEqual(text)

    // Ref-counted pinning protects active URLs across loads and connection reset.
    const release0a = store.retain(u0)
    const release0b = store.retain(u0)
    const release2 = store.retain(u2)
    await store.load(SESSION, 5, 3)
    expect(store.state.getSnapshot()[u0]).toEqual(text)
    expect(store.state.getSnapshot()[u2]).toEqual(text)
    expect(store.state.getSnapshot()[u3]).toEqual(text)

    // Releasing one of two pins keeps u0 retained; duplicate release is idempotent.
    release0a()
    release0a()
    expect(store.state.getSnapshot()[u0]).toEqual(text)

    // Releasing the last pin on u0 triggers eviction while over cap.
    release0b()
    expect(store.state.getSnapshot()[u0]).toBeUndefined()
    expect(store.state.getSnapshot()[u2]).toEqual(text)
    expect(store.state.getSnapshot()[u3]).toEqual(text)

    // Releasing u2 while at cap leaves entries untouched.
    release2()
    expect(store.state.getSnapshot()[u2]).toEqual(text)

    // Reset clears cache order and values while preserving active pins for mounted consumers.
    const keepAcrossReset = store.retain(u0)
    store.reset()
    await store.load(SESSION, 5, 0)
    await store.load(SESSION, 5, 1)
    await store.load(SESSION, 5, 2)
    expect(store.state.getSnapshot()[u0]).toEqual(text)
    expect(store.state.getSnapshot()[u1]).toBeUndefined()
    expect(store.state.getSnapshot()[u2]).toEqual(text)
    keepAcrossReset()

    // In-flight entries are not evicted while loading; settled unpinned entries are evicted on load and settlement.
    store.reset()
    let settle0!: (response: Response) => void
    let settle1!: (response: Response) => void
    fetcher.mockReturnValueOnce(new Promise<Response>((resolve) => { settle0 = resolve }))
    fetcher.mockReturnValueOnce(new Promise<Response>((resolve) => { settle1 = resolve }))
    const inflight0 = store.load(SESSION, 5, 0)
    const inflight1 = store.load(SESSION, 5, 1)
    await store.load(SESSION, 5, 2)
    expect(store.state.getSnapshot()[u0]).toBe('loading')
    expect(store.state.getSnapshot()[u1]).toBe('loading')
    expect(store.state.getSnapshot()[u2]).toEqual(text)
    // Settling u0 while u1 is still loading evicts settled unpinned u2 to return to maxEntries.
    settle0(Response.json(text))
    await inflight0
    expect(store.state.getSnapshot()[u0]).toEqual(text)
    expect(store.state.getSnapshot()[u1]).toBe('loading')
    expect(store.state.getSnapshot()[u2]).toBeUndefined()
    settle1(Response.json(text))
    await inflight1
    expect(store.state.getSnapshot()[u1]).toEqual(text)

    // ChangesSummaryStore uses the same bounded LRU with explicit maxEntries.
    const summaries = new ChangesSummaryStore(1)
    const s1 = changesSummaryUrl(SESSION, 1)
    const s2 = changesSummaryUrl(SESSION, 2)
    fetcher.mockImplementation(async () => Response.json({ turn: 1, cwd: '/w', files: [], total: 0, added: 0, deleted: 0 }))
    await summaries.load(SESSION, 1)
    await summaries.load(SESSION, 2)
    expect(summaries.state.getSnapshot()[s1]).toBeUndefined()
    expect(summaries.state.getSnapshot()[s2]).toBeDefined()
  })
})
