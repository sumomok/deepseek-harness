// @vitest-environment jsdom
/**
 * The wait a read spends on a page that has loaded but not finished drawing
 * itself, and the busy marks it reads afterwards.
 *
 * Both answers reach the model — one decides a line of the listing header, the
 * other names what the page says it is loading — so what is pinned here is the
 * behavior those lines rest on: a page that goes quiet is waited out, a page
 * that never does is read anyway, and the two shares of the report deadline
 * leave the walk and the trip back room to happen.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOAD_WAIT_SHARE, MAX_BUSY_NAMES, SETTLE_WAIT_SHARE } from '../src/access/wire.ts'
import { busyNames, settlePage, whenQuiet } from '../src/client/perception/settle.ts'

/** The quiet window and budget these cases are written against. */
const QUIET_MS = 100
const BUDGET_MS = 1000

/** Every element is visible unless a case says otherwise. */
const visible = (): boolean => true

/** Every frame mounted for a case, taken down after it. */
const mounted: HTMLIFrameElement[] = []

/**
 * A fresh frame document, so one case's markup never reaches another — and a
 * document with a window, which is what the reader's naming ladder needs.
 * @param html - the page's markup.
 * @returns that frame's document.
 */
function page(html = ''): Document {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  mounted.push(frame)
  const doc = frame.contentDocument
  if (doc === null) throw new Error('the frame has no document')
  doc.body.innerHTML = html
  return doc
}

afterEach(() => {
  vi.useRealTimers()
  for (const frame of mounted.splice(0)) frame.remove()
})

describe('waiting for a page to stop changing', () => {
  it('answers as soon as the document has held still for the quiet window', async () => {
    vi.useFakeTimers()
    const doc = page()
    const waiting = whenQuiet(doc, { quietMs: QUIET_MS, budgetMs: BUDGET_MS })
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    expect(await waiting).toBe(true)
  })

  it('restarts the window on every change, so a page painting in bursts is waited out', async () => {
    vi.useFakeTimers()
    const doc = page()
    const waiting = whenQuiet(doc, { quietMs: QUIET_MS, budgetMs: BUDGET_MS })
    for (let burst = 0; burst < 4; burst += 1) {
      await vi.advanceTimersByTimeAsync(QUIET_MS - 20)
      doc.body.append(doc.createElement('div'))
    }
    // Past the first window several times over, and still waiting.
    await vi.advanceTimersByTimeAsync(QUIET_MS - 20)
    let settled: boolean | undefined
    void waiting.then((answer) => { settled = answer })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBeUndefined()

    await vi.advanceTimersByTimeAsync(QUIET_MS)
    expect(await waiting).toBe(true)
  })

  it('gives up at the budget and says so, rather than holding the read open', async () => {
    vi.useFakeTimers()
    const doc = page()
    const churn = setInterval(() => { doc.body.append(doc.createElement('div')) }, QUIET_MS / 2)
    const waiting = whenQuiet(doc, { quietMs: QUIET_MS, budgetMs: BUDGET_MS })
    await vi.advanceTimersByTimeAsync(BUDGET_MS)
    expect(await waiting).toBe(false)
    clearInterval(churn)
  })

  it('answers each kind of change a page makes, not only added nodes', async () => {
    vi.useFakeTimers()
    const doc = page('<p id="x">one</p>')
    const node = doc.getElementById('x')!
    for (const change of [
      () => { node.setAttribute('data-state', 'loading') },
      () => { node.firstChild!.textContent = 'two' },
    ]) {
      const waiting = whenQuiet(doc, { quietMs: QUIET_MS, budgetMs: BUDGET_MS })
      await vi.advanceTimersByTimeAsync(QUIET_MS - 20)
      change()
      await vi.advanceTimersByTimeAsync(QUIET_MS - 20)
      let settled: boolean | undefined
      void waiting.then((answer) => { settled = answer })
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBeUndefined()
      await vi.advanceTimersByTimeAsync(QUIET_MS)
      expect(await waiting).toBe(true)
    }
  })

  it('leaves the two shares of the report deadline room for the walk and the trip back', () => {
    expect(LOAD_WAIT_SHARE + SETTLE_WAIT_SHARE).toBeLessThan(1)
  })
})

describe('what the page says it is loading', () => {
  it('names a busy region the way the reader would name it', () => {
    const doc = page('<section aria-busy="true" aria-label="Fleet status"></section>')
    expect(busyNames(doc, visible)).toEqual(['Fleet status'])
  })

  it('falls back to a heading inside the region, then to the tag when it has neither', () => {
    const doc = page(
      '<section aria-busy="true"><h2>Alerts</h2></section>'
      + '<div aria-busy="true"></div>',
    )
    expect(busyNames(doc, visible)).toEqual(['Alerts', 'div'])
  })

  it('skips a busy region the page is not showing', () => {
    const doc = page('<section aria-busy="true" aria-label="Hidden"></section>'
      + '<section aria-busy="true" aria-label="Shown"></section>')
    const shown = (el: Element): boolean => el.getAttribute('aria-label') !== 'Hidden'
    expect(busyNames(doc, shown)).toEqual(['Shown'])
  })

  it('names the first few rather than every region of a page that is loading', () => {
    const many = Array.from(
      { length: MAX_BUSY_NAMES + 2 },
      (_unused, at) => `<section aria-busy="true" aria-label="r${String(at)}"></section>`,
    )
    expect(busyNames(page(many.join('')), visible)).toEqual(['r0', 'r1', 'r2'])
  })

  it('reads a progress bar as content rather than as a busy mark', () => {
    // A page can draw one as its subject; only the attribute a page writes to
    // say "this is loading" is read that way.
    expect(busyNames(page('<div role="progressbar" aria-valuenow="40">40%</div>'), visible)).toEqual([])
  })

  it('reads no framework loading class, which this reader has never heard of', () => {
    expect(busyNames(page('<div class="el-loading-mask"></div><div class="ant-spin"></div>'), visible)).toEqual([])
  })
})

describe('the whole wait one read spends', () => {
  it('answers both halves, reading the busy marks as they stand when the wait ends', async () => {
    vi.useFakeTimers()
    const doc = page('<section aria-busy="true" aria-label="Fleet status"></section>')
    const waiting = settlePage(doc, { quietMs: QUIET_MS, budgetMs: BUDGET_MS }, visible)
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    expect(await waiting).toEqual({ settled: true, busy: ['Fleet status'] })
  })

  it('reads a page that never settled, and says which it was', async () => {
    vi.useFakeTimers()
    const doc = page()
    const churn = setInterval(() => { doc.body.append(doc.createElement('div')) }, QUIET_MS / 2)
    const waiting = settlePage(doc, { quietMs: QUIET_MS, budgetMs: BUDGET_MS }, visible)
    await vi.advanceTimersByTimeAsync(BUDGET_MS)
    expect(await waiting).toEqual({ settled: false, busy: [] })
    clearInterval(churn)
  })
})
