/**
 * The order of the steps around the server's end, run with recording fakes:
 * an unexpected exit forgets the port and removes the cookies before the
 * recovery ladder, a crash rebind asks for a system-picked port, a quit
 * removes the cookies before sending the stop and sends it even when the
 * removal never answers, and reopening while quitting does nothing.
 * @module
 */

import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COOKIE_CLEAR_BOUND_MS, rebindOnNewPort, respondToCrash, resumeAfterFailedInstall, revealApp, stopForQuit,
} from '../src/server-lifecycle.ts'
import type { ServerHandle, ServerSpec } from '../src/server.ts'

afterEach(() => { vi.useRealTimers() })

/** A removal that never settles, as a cookie store that stopped answering. */
const never = (): Promise<never> => new Promise(() => {})

describe('respondToCrash', () => {
  it('forgets the port and finishes removing the cookies before the ladder runs', async () => {
    const steps: string[] = []
    const outcome = await respondToCrash({
      forgetPort: () => { steps.push('forget') },
      clearCookies: async () => { await Promise.resolve(); steps.push('cleared') },
      ladder: async () => { steps.push('ladder'); return 'relaunch' },
      log: () => {},
    })
    expect(steps).toEqual(['forget', 'cleared', 'ladder'])
    expect(outcome).toBe('relaunch')
  })

  it('runs the ladder after the bound when the removal never answers, and says so', async () => {
    vi.useFakeTimers()
    const lines: string[] = []
    let laddered = false
    const done = respondToCrash({
      forgetPort: () => {},
      clearCookies: never,
      ladder: async () => { laddered = true; return 'stop' },
      log: (line) => { lines.push(line) },
    })
    await vi.advanceTimersByTimeAsync(COOKIE_CLEAR_BOUND_MS - 1)
    expect(laddered).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await done).toBe('stop')
    expect(lines.join('')).toContain('did not finish')
  })

  it('runs the ladder after a removal that failed', async () => {
    const outcome = await respondToCrash({
      forgetPort: () => {}, clearCookies: async () => { throw new Error('store gone') }, ladder: async () => 'recovered', log: () => {},
    })
    expect(outcome).toBe('recovered')
  })
})

describe('rebindOnNewPort', () => {
  it('asks for a system-picked port whatever port the recorded spec names', async () => {
    const asked: Array<number | undefined> = []
    const handle: ServerHandle = { url: 'http://127.0.0.1:52000', authenticatedUrl: 'http://127.0.0.1:52000/?token=t', stop: async () => {}, onExit: () => {} }
    const spec: ServerSpec = { nodeBin: 'node', entry: 'bin.js', cwd: '/', reportDirectory: '/', env: {}, port: 49_321 }
    const started = await rebindOnNewPort(spec, async (s) => { asked.push(s.port); return handle }, () => {})
    expect(asked).toEqual([0])
    expect(started.spec.port).toBe(52_000)
  })
})

describe('stopForQuit', () => {
  it('removes the cookies, then sends the stop', async () => {
    const steps: string[] = []
    const outcome = await stopForQuit({
      clearCookies: async () => { await Promise.resolve(); steps.push('cleared') },
      stop: async () => { steps.push('stop') },
      log: () => {},
      timeoutMs: 1_000,
    })
    expect(steps).toEqual(['cleared', 'stop'])
    expect(outcome).toBe('stopped')
  })

  it('sends the stop after the bound when the removal never answers', async () => {
    vi.useFakeTimers()
    let stopped = false
    const lines: string[] = []
    const done = stopForQuit({
      clearCookies: never, stop: async () => { stopped = true }, log: (line) => { lines.push(line) }, timeoutMs: 1_000,
    })
    await vi.advanceTimersByTimeAsync(COOKIE_CLEAR_BOUND_MS - 1)
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(stopped).toBe(true)
    expect(await done).toBe('stopped')
    expect(lines.join('')).toContain('stopping the server anyway')
  })

  it('sends the stop after a removal that failed', async () => {
    let stopped = false
    await stopForQuit({ clearCookies: async () => { throw new Error('store gone') }, stop: async () => { stopped = true }, log: () => {}, timeoutMs: 1_000 })
    expect(stopped).toBe(true)
  })

  it('gives up on a stop that outlasts the deadline', async () => {
    vi.useFakeTimers()
    const lines: string[] = []
    const done = stopForQuit({ clearCookies: async () => {}, stop: never, log: (line) => { lines.push(line) }, timeoutMs: 1_000 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await done).toBe('timeout')
    expect(lines.join('')).toContain('did not stop within 1000ms')
  })
})

describe('revealApp', () => {
  it('does nothing while quitting', () => {
    const calls: string[] = []
    revealApp({ quitting: () => true, revealExisting: () => { calls.push('reveal'); return true }, openWindow: () => { calls.push('open') } })
    expect(calls).toEqual([])
  })

  it('uncovers the existing window, and opens one only when there is none', () => {
    const calls: string[] = []
    revealApp({ quitting: () => false, revealExisting: () => { calls.push('reveal'); return true }, openWindow: () => { calls.push('open') } })
    revealApp({ quitting: () => false, revealExisting: () => { calls.push('reveal'); return false }, openWindow: () => { calls.push('open') } })
    expect(calls).toEqual(['reveal', 'reveal', 'open'])
  })
})

describe('resumeAfterFailedInstall', () => {
  /**
   * A shell whose quitting flag gates the reveal the way `main.ts` wires it.
   * @param blocking - whether the mandatory block holds the app.
   * @returns the recorded steps once the resume finished.
   */
  async function resume(blocking: boolean): Promise<string[]> {
    const steps: string[] = []
    let quitting = true
    await resumeAfterFailedInstall({
      blocking,
      clearQuitting: () => { quitting = false; steps.push('clear') },
      restartServer: async () => { await Promise.resolve(); steps.push('restart') },
      reveal: () => {
        revealApp({ quitting: () => quitting, revealExisting: () => { steps.push('shown'); return true }, openWindow: () => {} })
      },
    })
    return steps
  }

  it('clears the quitting state, restarts the server, then shows the window', async () => {
    expect(await resume(false)).toEqual(['clear', 'restart', 'shown'])
  })

  it('shows the window without the server while the mandatory block holds the app', async () => {
    expect(await resume(true)).toEqual(['clear', 'shown'])
  })
})

describe('main.ts', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')

  /**
   * The body of one top-level function in main.ts.
   * @param name - the function's name.
   * @returns its source, up to the closing brace at column 0.
   */
  function body(name: string): string {
    const start = source.indexOf(`function ${name}(`)
    expect(start).toBeGreaterThan(-1)
    return source.slice(start, source.indexOf('\n}\n', start))
  }

  it('runs these steps at each of the five points', () => {
    expect(body('handleUnexpectedServerExit')).toMatch(/respondToCrash\(\{\s+forgetPort: forgetServerPort,\s+clearCookies: clearAuthCookies,/u)
    expect(body('handleUnexpectedServerExit')).toContain('ladder: () => runRecoveryLadder(')
    expect(body('performRebind')).toContain('await rebindOnNewPort(spec, startEmbeddedServer, logLine)')
    expect(body('stopServerBounded')).toContain('await stopForQuit({ stop: handle.stop, clearCookies: clearAuthCookies,')
    expect(body('reveal')).toContain('quitting: () => quitting,')
    expect(source).toMatch(new RegExp([
      'resumeAfterFailedInstall: \\(blocking: boolean\\) => resumeAfterFailedInstall\\(\\{\\s+blocking,',
      '\\s+clearQuitting: \\(\\) => \\{ quitting = false \\},\\s+restartServer: restartAfterFailedInstall,\\s+reveal,',
    ].join(''), 'u'))
    expect(body('restartAfterFailedInstall')).toContain('await choosePort(readState().serverPort, isPortFree)')
  })
})
