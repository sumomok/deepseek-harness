/**
 * Which Electron event reports the end of the user's session on each
 * platform, and that the listener runs once however many sources report it.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { watchSessionEnd, type SessionEndSources } from '../src/session-end.ts'

/** An event source that records its listeners and can fire them. */
class FakeSource<E extends string> {
  readonly listeners = new Map<string, (() => void)[]>()
  on(event: E, listener: () => void): void {
    this.listeners.set(event, [...this.listeners.get(event) ?? [], listener])
  }

  /** Fire every listener registered for `event`. */
  fire(event: E): void {
    for (const listener of this.listeners.get(event) ?? []) listener()
  }
}

/**
 * Sources for `platform` with one window that exists before the watch starts.
 * @param platform - the platform to report.
 * @returns the sources, the existing window, and a way to create another.
 */
function sources(platform: NodeJS.Platform): {
  sources: SessionEndSources
  powerMonitor: FakeSource<'shutdown'>
  existing: FakeSource<'session-end'>
  createWindow: () => FakeSource<'session-end'>
} {
  const powerMonitor = new FakeSource<'shutdown'>()
  const existing = new FakeSource<'session-end'>()
  const created: ((window: FakeSource<'session-end'>) => void)[] = []
  return {
    sources: {
      platform,
      powerMonitor,
      eachWindow: (listener) => {
        listener(existing)
        created.push(listener)
      },
    },
    powerMonitor,
    existing,
    createWindow: () => {
      const window = new FakeSource<'session-end'>()
      for (const listener of created) listener(window)
      return window
    },
  }
}

describe('watchSessionEnd', () => {
  it('hears a window\'s session-end on Windows, from a window that existed or one created later', () => {
    const fake = sources('win32')
    let ends = 0
    watchSessionEnd(fake.sources, () => { ends += 1 })
    const later = fake.createWindow()
    later.fire('session-end')
    expect(ends).toBe(1)
    fake.existing.fire('session-end')
    expect(ends).toBe(1)
    expect(fake.powerMonitor.listeners.size).toBe(0)
  })

  it('hears the first window on Windows too', () => {
    const fake = sources('win32')
    let ends = 0
    watchSessionEnd(fake.sources, () => { ends += 1 })
    fake.existing.fire('session-end')
    expect(ends).toBe(1)
  })

  it('hears powerMonitor shutdown on macOS and Linux, and no window event', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const fake = sources(platform)
      let ends = 0
      watchSessionEnd(fake.sources, () => { ends += 1 })
      expect(fake.existing.listeners.size).toBe(0)
      fake.powerMonitor.fire('shutdown')
      fake.powerMonitor.fire('shutdown')
      expect(ends).toBe(1)
    }
  })
})
