// @vitest-environment jsdom
/**
 * The watch that notices the application inside a frame routing itself.
 *
 * The frame here is a stub over this environment's own window and document,
 * because that is exactly what the watch reads: a window it can listen on and
 * ask where it is. An `about:blank` iframe cannot answer a `pushState` at all,
 * and the route change nothing fires an event for is the case this watch exists
 * for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_HEADER_CHARS } from '../src/access/wire.ts'
import { NAVIGATION_SETTLE_MS, watchFrame, type FrameAddress } from '../src/client/perception/navigation.ts'

/** The address the page under test was opened at. */
const ENTRY_URL = '/content-app/'

/** A frame over this environment's own window: a window to listen on, a document to read. */
function frameOverWindow(): HTMLIFrameElement {
  return { contentWindow: window, contentDocument: window.document } as unknown as HTMLIFrameElement
}

/** Start one watch over {@link frameOverWindow}, recording every move it reports. */
function watch(frame: HTMLIFrameElement = frameOverWindow()): {
  moves: FrameAddress[]
  reload: () => void
  poll: () => void
  dispose: () => void
} {
  const moves: FrameAddress[] = []
  const watching = watchFrame({
    frame,
    entryUrl: ENTRY_URL,
    onNavigated: (address) => { moves.push(address) },
  })
  return { moves, ...watching }
}

/** Let the settling window pass. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(NAVIGATION_SETTLE_MS)
}

beforeEach(() => {
  vi.useFakeTimers()
  window.history.replaceState({}, '', ENTRY_URL)
  document.title = 'Console'
})

afterEach(() => {
  vi.useRealTimers()
  window.history.replaceState({}, '', '/')
  document.title = ''
})

describe('watching a frame for the application inside it moving', () => {
  it('reports a hash route change once the frame has held still', async () => {
    const watching = watch()
    window.location.hash = '#/device'
    document.title = 'Devices'
    expect(watching.moves).toEqual([])

    await settle()
    expect(watching.moves).toEqual([{ url: '/content-app/#/device', title: 'Devices' }])
    watching.dispose()
  })

  it('reports one move for a burst of changes, at where the frame ended up', async () => {
    const watching = watch()
    window.location.hash = '#/a'
    await vi.advanceTimersByTimeAsync(NAVIGATION_SETTLE_MS - 50)
    window.location.hash = '#/b'
    await settle()
    expect(watching.moves).toEqual([{ url: '/content-app/#/b', title: 'Console' }])
    watching.dispose()
  })

  it('reports a route change made through pushState, which fires no event at all', async () => {
    const watching = watch()
    window.history.pushState({}, '', '/content-app/reports/?open=1')
    // Nothing has happened yet: no event was fired, and the watch has not
    // looked.
    await settle()
    expect(watching.moves).toEqual([])

    watching.poll()
    await settle()
    expect(watching.moves).toEqual([{ url: '/content-app/reports/?open=1', title: 'Console' }])

    // And only once: a second poll at the same address starts nothing.
    watching.poll()
    await settle()
    expect(watching.moves).toHaveLength(1)
    watching.dispose()
  })

  it('says nothing when the frame is where its page was opened, and only for the first report', async () => {
    const watching = watch()
    watching.poll()
    await settle()
    expect(watching.moves).toEqual([])

    // Away and back: the return is a real move, because the frame did move.
    window.location.hash = '#/device'
    await settle()
    window.location.hash = ''
    await settle()
    expect(watching.moves.map(move => move.url)).toEqual(['/content-app/#/device', '/content-app/'])
    watching.dispose()
  })

  it('does not report the same address and title twice', async () => {
    const watching = watch()
    window.location.hash = '#/device'
    await settle()
    watching.poll()
    watching.reload()
    await settle()
    expect(watching.moves).toEqual([{ url: '/content-app/#/device', title: 'Console' }])

    // A title the page writes late is a move of its own, at the same address.
    document.title = 'Devices'
    watching.reload()
    await settle()
    expect(watching.moves).toHaveLength(2)
    expect(watching.moves[1]).toEqual({ url: '/content-app/#/device', title: 'Devices' })
    watching.dispose()
  })

  it('cuts a title to what the log carries', async () => {
    const watching = watch()
    document.title = 'T'.repeat(MAX_HEADER_CHARS + 40)
    window.location.hash = '#/long'
    await settle()
    expect(watching.moves).toEqual([{
      url: '/content-app/#/long',
      title: `${'T'.repeat(MAX_HEADER_CHARS - 1)}…`,
    }])
    watching.dispose()
  })

  it('cuts a title beside a surrogate pair rather than through one', async () => {
    // The command that records this refuses a lone surrogate half, so a cut
    // landing inside a pair takes the whole pair with it.
    const watching = watch()
    document.title = '\u{1f600}'.repeat(MAX_HEADER_CHARS)
    window.location.hash = '#/emoji'
    await settle()
    expect(watching.moves).toEqual([{
      url: '/content-app/#/emoji',
      // One short of the odd cut the bound alone would have made.
      title: `${'\u{1f600}'.repeat(MAX_HEADER_CHARS / 2 - 1)}…`,
    }])
    expect(watching.moves[0]?.title.isWellFormed()).toBe(true)
    watching.dispose()
  })

  it('drops from a title what a log should not carry', async () => {
    const watching = watch()
    document.title = `Fleet${String.fromCharCode(1)} console`
    window.location.hash = '#/clean'
    await settle()
    expect(watching.moves).toEqual([{ url: '/content-app/#/clean', title: 'Fleet console' }])
    watching.dispose()
  })

  it('reports nothing at all once it is disposed', async () => {
    const watching = watch()
    watching.dispose()
    window.location.hash = '#/after'
    watching.poll()
    watching.reload()
    await settle()
    expect(watching.moves).toEqual([])
  })

  it('says nothing about a frame that has left this origin', async () => {
    const crossOrigin = {
      contentWindow: {
        addEventListener: () => { throw new DOMException('cross-origin', 'SecurityError') },
        removeEventListener: () => { throw new DOMException('cross-origin', 'SecurityError') },
        get location(): Location { throw new DOMException('cross-origin', 'SecurityError') },
        get document(): Document { throw new DOMException('cross-origin', 'SecurityError') },
      },
    } as unknown as HTMLIFrameElement
    const watching = watch(crossOrigin)
    watching.poll()
    watching.reload()
    await settle()
    expect(watching.moves).toEqual([])
    expect(() => { watching.dispose() }).not.toThrow()
  })

  it('stays inert after disposal even for a listener the frame would not give back', async () => {
    // A frame that goes cross-origin refuses `removeEventListener` too, so the
    // listener outlives the watch and its event has to find a watch that is
    // over.
    const listeners = new Map<string, () => void>()
    const stubborn = {
      contentWindow: {
        addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener) },
        removeEventListener: () => { throw new DOMException('cross-origin', 'SecurityError') },
        get location(): Location { return window.location },
        get document(): Document { return window.document },
      },
    } as unknown as HTMLIFrameElement
    const watching = watch(stubborn)
    watching.dispose()

    window.location.hash = '#/orphan'
    listeners.get('hashchange')?.()
    await settle()
    expect(watching.moves).toEqual([])
  })

  it('says nothing about a frame with no window', async () => {
    const watching = watch({ contentWindow: null } as unknown as HTMLIFrameElement)
    watching.poll()
    watching.reload()
    await settle()
    expect(watching.moves).toEqual([])
    watching.dispose()
  })

  it('checks where the frame is after a whole document load', async () => {
    const watching = watch()
    window.history.pushState({}, '', '/content-app/reports/')
    // No poll and no event — the load is what the seat reports, and re-arming
    // on the new document is what the watch does with it.
    watching.reload()
    await settle()
    expect(watching.moves).toEqual([{ url: '/content-app/reports/', title: 'Console' }])
    watching.dispose()
  })
})
