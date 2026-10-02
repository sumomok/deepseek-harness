// @vitest-environment jsdom
/**
 * The build check against a page the spec drives: the first different build
 * reloads once and records it, the same build again offers the reload instead,
 * an unusable session storage offers it too, the same build clears the record,
 * an answer without a readable build changes nothing, a later trigger
 * supersedes an open request, and nothing reloads or shows a notice after the
 * check is disposed.
 *
 * The fake page is what makes the reload count observable at all: a real one
 * would have left before the assertion.
 */

import { describe, expect, it } from 'vitest'
import type { RefreshNotice } from '../src/client/banner-state.ts'
import { BuildCheck, RELOADED_FOR_STORAGE_KEY } from '../src/client/check.ts'
import { bootEntriesOf, buildKey } from '../src/client/identity.ts'
import { DOCUMENT_URL, FakePage, ORIGIN, servedIndex, settle, type Entry } from './fake-browser.client.ts'

/** The build the page booted with. */
const BOOTED: Entry[] = [{ id: 'a', rev: '1' }, { id: 'b', rev: '2' }]
/** The same build, listed in another order. */
const SAME = servedIndex([{ id: 'b', rev: '2' }, { id: 'a', rev: '1' }])
/** A build with one revision moved on. */
const NEWER = servedIndex([{ id: 'a', rev: '1' }, { id: 'b', rev: '3' }])
/** The guard key of {@link NEWER}. */
const NEWER_KEY = buildKey({ entries: new Map([['a', '1'], ['b', '3']]), shell: [`${ORIGIN}/assets/index-A.js`] })

/** A check over a fresh fake page, recording its notices and diagnostics. */
function bench(reloadDelayMs = 0) {
  const page = new FakePage()
  const notices: (RefreshNotice | null)[] = []
  const logs: string[] = []
  const check = new BuildCheck({
    browser: page,
    documentUrl: DOCUMENT_URL,
    current: { entries: bootEntriesOf({ entries: BOOTED })!, shell: page.moduleScripts() },
    reloadDelayMs,
    showNotice: (notice) => { notices.push(notice) },
    log: (message) => { logs.push(message) },
  })
  /** Trigger one check and answer its request with `body`. */
  const answer = async (body: string): Promise<void> => {
    check.trigger()
    await settle()
    page.lastRequest().answer({ body })
    await settle()
  }
  return { page, check, notices, logs, answer }
}

describe('a different build', () => {
  it('records the build and reloads the page at once', async () => {
    const { page, notices, answer } = bench()
    await answer(NEWER)
    expect(page.session.get(RELOADED_FOR_STORAGE_KEY)).toBe(NEWER_KEY)
    expect(page.reloads).toBe(1)
    // A reload with no delay is not announced: the page is already leaving.
    expect(notices).toEqual([])
  })

  it('offers the reload instead when this tab already reloaded for that build', async () => {
    const { page, notices, logs, answer } = bench()
    page.session.set(RELOADED_FOR_STORAGE_KEY, NEWER_KEY)
    await answer(NEWER)
    expect(page.reloads).toBe(0)
    expect(notices).toEqual(['update'])
    expect(logs).toEqual(['page-refresh: this tab already reloaded for the served build, offering the reload instead'])
  })

  it('reloads again for a build other than the one it last reloaded for', async () => {
    const { page, answer } = bench()
    page.session.set(RELOADED_FOR_STORAGE_KEY, 'a build from before')
    await answer(NEWER)
    expect(page.reloads).toBe(1)
    expect(page.session.get(RELOADED_FOR_STORAGE_KEY)).toBe(NEWER_KEY)
  })

  it('offers the reload instead when session storage cannot be read', async () => {
    const { page, notices, logs, answer } = bench()
    page.failRead = true
    await answer(NEWER)
    expect(page.reloads).toBe(0)
    expect(notices).toEqual(['update'])
    expect(logs).toEqual(['page-refresh: session storage is unavailable, offering the reload instead: Error: session storage is disabled'])
  })

  it('offers the reload instead when session storage cannot be written', async () => {
    const { page, notices, logs, answer } = bench()
    page.failWrite = true
    await answer(NEWER)
    expect(page.reloads).toBe(0)
    expect(notices).toEqual(['update'])
    expect(logs).toEqual(['page-refresh: session storage is unavailable, offering the reload instead: Error: session storage is full'])
  })

  it('announces a configured delay, then reloads once it has passed', async () => {
    const { page, notices, answer } = bench(1500)
    await answer(NEWER)
    expect(notices).toEqual(['reloading'])
    page.advance(1499)
    expect(page.reloads).toBe(0)
    page.advance(1)
    expect(page.reloads).toBe(1)
  })

  it('ignores every trigger once it has decided to reload', async () => {
    const { page, check, answer } = bench(1500)
    await answer(NEWER)
    check.trigger()
    page.showPage()
    expect(page.requests).toHaveLength(1)
  })
})

describe('the same build', () => {
  it('clears the reload record and any offer, and reloads nothing', async () => {
    const { page, notices, answer } = bench()
    page.session.set(RELOADED_FOR_STORAGE_KEY, NEWER_KEY)
    await answer(SAME)
    expect(page.reloads).toBe(0)
    expect(page.session.has(RELOADED_FOR_STORAGE_KEY)).toBe(false)
    expect(notices).toEqual([null])
  })

  it('withdraws an earlier offer once the server serves the booted build again', async () => {
    const { page, notices, answer } = bench()
    page.session.set(RELOADED_FOR_STORAGE_KEY, NEWER_KEY)
    await answer(NEWER)
    await answer(SAME)
    expect(notices).toEqual(['update', null])
  })

  it('tolerates a session storage that cannot be cleared', async () => {
    const { page, notices, answer } = bench()
    page.failRemove = true
    await answer(SAME)
    expect(notices).toEqual([null])
    expect(page.reloads).toBe(0)
  })
})

describe('an answer without a readable build', () => {
  it('changes nothing and records why', async () => {
    const { page, notices, logs, check } = bench()
    check.trigger()
    await settle()
    page.lastRequest().answer({ status: 401 })
    await settle()
    expect({ reloads: page.reloads, notices, logs }).toEqual({
      reloads: 0, notices: [], logs: [`page-refresh: no build read from ${DOCUMENT_URL}: the index answered 401`],
    })
  })

  it('treats a failed request the same way', async () => {
    const { page, notices, logs, check } = bench()
    check.trigger()
    await settle()
    page.lastRequest().fail(new TypeError('Failed to fetch'))
    await settle()
    expect({ reloads: page.reloads, notices, logs }).toEqual({
      reloads: 0, notices: [], logs: [`page-refresh: could not read ${DOCUMENT_URL}: TypeError: Failed to fetch`],
    })
  })
})

describe('triggers while a request is open', () => {
  it('abort the open request and decide on the newer one alone', async () => {
    const { page, check, notices, logs } = bench()
    check.trigger()
    await settle()
    const first = page.lastRequest()
    check.trigger()
    await settle()
    const second = page.lastRequest()
    expect(page.requests).toHaveLength(2)
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
    second.answer({ body: SAME })
    await settle()
    expect({ reloads: page.reloads, notices, logs }).toEqual({ reloads: 0, notices: [null], logs: [] })
  })

  it('ignore the verdict of a superseded request that answered before it was aborted', async () => {
    const { page, check, notices } = bench()
    check.trigger()
    await settle()
    const first = page.lastRequest()
    first.answer({ body: NEWER })
    // The answer has arrived, but its continuation has not run yet.
    check.trigger()
    await settle()
    expect(page.reloads).toBe(0)
    page.lastRequest().answer({ body: SAME })
    await settle()
    expect(page.reloads).toBe(0)
    expect(notices).toEqual([null])
  })
})

describe('disposal', () => {
  it('leaves a request that answers afterwards without effect', async () => {
    const { page, check, notices, logs } = bench()
    check.trigger()
    await settle()
    const request = page.lastRequest()
    check.dispose()
    expect(request.signal.aborted).toBe(true)
    request.answer({ body: NEWER })
    await settle()
    expect({ reloads: page.reloads, notices, logs }).toEqual({ reloads: 0, notices: [], logs: [] })
  })

  it('cancels a reload waiting out its delay', async () => {
    const { page, check, answer } = bench(1500)
    await answer(NEWER)
    check.dispose()
    page.advance(1500)
    expect(page.reloads).toBe(0)
    expect(page.pendingTimers()).toBe(0)
  })

  it('makes later triggers do nothing', async () => {
    const { page, check } = bench()
    check.dispose()
    check.trigger()
    await settle()
    expect(page.requests).toHaveLength(0)
  })
})
