/**
 * The order of the steps around the server's end, run with recording fakes:
 * an unexpected exit forgets the port and removes the cookies before the
 * recovery ladder, a crash rebind asks for a system-picked port, a quit
 * removes the cookies before sending the stop and sends it even when the
 * removal never answers, and reopening while quitting does nothing.
 * @module
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SENTINEL_DIRECTORY, SENTINEL_FILE, writeIntentionalStop } from '../src/crash-resume-sentinel.ts'
import {
  COOKIE_CLEAR_BOUND_MS, markIntentionalStop, rebindOnNewPort, respondToCrash, resumeAfterFailedInstall, revealApp,
  stopForMandatoryUpdate, stopForQuit, stopServerForQuit,
} from '../src/server-lifecycle.ts'
import type { ServerHandle, ServerSpec } from '../src/server.ts'

let home: string | undefined

afterEach(() => {
  vi.useRealTimers()
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  home = undefined
})

/**
 * A fresh Harness home under the system temporary directory, and where the
 * sentinel would land in it.
 * @returns the home and the sentinel path.
 */
function sentinelHome(): { home: string; sentinel: string } {
  const created = mkdtempSync(join(tmpdir(), 'dsh-lifecycle-'))
  expect(created.startsWith(tmpdir())).toBe(true)
  home = created
  return { home: created, sentinel: join(created, SENTINEL_DIRECTORY, SENTINEL_FILE) }
}

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
    const handle: ServerHandle = { url: 'http://127.0.0.1:52000', authenticatedUrl: 'http://127.0.0.1:52000/?token=t', pid: undefined, stop: async () => {}, exited: () => false, onExit: () => {} }
    const spec: ServerSpec = { nodeBin: 'node', entry: 'bin.js', cwd: '/', reportDirectory: '/', env: {}, port: 49_321 }
    const started = await rebindOnNewPort(spec, async (s) => { asked.push(s.port); return handle }, () => {})
    expect(asked).toEqual([0])
    expect(started.spec.port).toBe(52_000)
  })

  it('starts the new server with the recorded environment, the loopback services\' variables included', async () => {
    const env = {
      NODE_PATH: '/data/engines/office/0.1.1/node_modules',
      DSH_DESKTOP_OFFICE_ENGINE_ENDPOINT: 'http://127.0.0.1:53000',
      DSH_DESKTOP_OFFICE_ENGINE_TOKEN: 'secret',
    }
    const handle: ServerHandle = { url: 'http://127.0.0.1:52000', authenticatedUrl: 'http://127.0.0.1:52000/?token=t', pid: undefined, stop: async () => {}, exited: () => false, onExit: () => {} }
    const spec: ServerSpec = { nodeBin: 'node', entry: 'bin.js', cwd: '/', reportDirectory: '/', env, port: 49_321 }
    const seen: Array<Record<string, string>> = []
    const started = await rebindOnNewPort(spec, async (s) => { seen.push(s.env); return handle }, () => {})
    expect(seen).toEqual([env])
    expect(started.spec.env).toEqual(env)
  })
})

describe('stopForQuit', () => {
  it('removes the cookies, then sends the stop', async () => {
    const steps: string[] = []
    const outcome = await stopForQuit({
      markIntentional: () => { steps.push('marked') },
      clearCookies: async () => { await Promise.resolve(); steps.push('cleared') },
      stop: async () => { steps.push('stop') },
      log: () => {},
      timeoutMs: 1_000,
    })
    expect(steps).toEqual(['marked', 'cleared', 'stop'])
    expect(outcome).toBe('stopped')
  })

  it('sends the stop after the bound when the removal never answers', async () => {
    vi.useFakeTimers()
    let stopped = false
    const lines: string[] = []
    const done = stopForQuit({
      markIntentional: () => {}, clearCookies: never, stop: async () => { stopped = true },
      log: (line) => { lines.push(line) }, timeoutMs: 1_000,
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
    await stopForQuit({ markIntentional: () => {}, clearCookies: async () => { throw new Error('store gone') }, stop: async () => { stopped = true }, log: () => {}, timeoutMs: 1_000 })
    expect(stopped).toBe(true)
  })

  it('gives up on a stop that outlasts the deadline', async () => {
    vi.useFakeTimers()
    const lines: string[] = []
    const done = stopForQuit({
      markIntentional: () => {}, clearCookies: async () => {}, stop: never, log: (line) => { lines.push(line) }, timeoutMs: 1_000,
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await done).toBe('timeout')
    expect(lines.join('')).toContain('did not stop within 1000ms')
  })

  it('has the sentinel on disk by the time the stop is sent', async () => {
    const { home: target, sentinel } = sentinelHome()
    let presentAtStop = false
    await stopForQuit({
      markIntentional: () => { writeIntentionalStop(target, 'quit', () => {}) },
      clearCookies: async () => {},
      stop: async () => { presentAtStop = existsSync(sentinel) },
      log: () => {},
      timeoutMs: 1_000,
    })
    expect(presentAtStop).toBe(true)
  })
})

/**
 * A server stand-in whose stop records whether the sentinel was on disk.
 * @param sentinel - where the sentinel would land.
 * @param exited - whether its child already exited.
 * @returns the handle, and whether the sentinel existed when `stop` ran.
 */
function recordingHandle(sentinel: string, exited: boolean): { handle: ServerHandle; presentAtStop: () => boolean | undefined } {
  let present: boolean | undefined
  return {
    handle: {
      url: 'http://127.0.0.1:52000', authenticatedUrl: 'http://127.0.0.1:52000/?token=t', pid: undefined,
      stop: async () => { present = existsSync(sentinel) }, exited: () => exited, onExit: () => {},
    },
    presentAtStop: () => present,
  }
}

describe('stopForMandatoryUpdate', () => {
  it('has the sentinel on disk by the time the stop is sent', async () => {
    const { home: target, sentinel } = sentinelHome()
    const { handle, presentAtStop } = recordingHandle(sentinel, false)
    await stopForMandatoryUpdate(handle, { home: target, log: () => {} })
    expect(presentAtStop()).toBe(true)
    expect(JSON.parse(readFileSync(sentinel, 'utf8'))).toMatchObject({ by: 'shell', reason: 'update' })
  })
})

describe('stopServerForQuit', () => {
  it('has the sentinel on disk by the time the stop is sent', async () => {
    const { home: target, sentinel } = sentinelHome()
    const { handle, presentAtStop } = recordingHandle(sentinel, false)
    await stopServerForQuit(handle, { home: target, log: () => {}, clearCookies: async () => {}, timeoutMs: 1_000 })
    expect(presentAtStop()).toBe(true)
    expect(JSON.parse(readFileSync(sentinel, 'utf8'))).toMatchObject({ by: 'shell', reason: 'quit' })
  })

  it('writes nothing for a server that already exited, and still sends the stop', async () => {
    const { home: target, sentinel } = sentinelHome()
    const { handle, presentAtStop } = recordingHandle(sentinel, true)
    await stopServerForQuit(handle, { home: target, log: () => {}, clearCookies: async () => {}, timeoutMs: 1_000 })
    expect(presentAtStop()).toBe(false)
    expect(existsSync(sentinel)).toBe(false)
  })
})

describe('markIntentionalStop', () => {
  it('writes the reason for a running server and nothing without one', () => {
    const { home: target, sentinel } = sentinelHome()
    expect(markIntentionalStop(undefined, 'shutdown', { home: target, log: () => {} })).toBe(false)
    expect(existsSync(sentinel)).toBe(false)
    expect(markIntentionalStop({ exited: () => false }, 'shutdown', { home: target, log: () => {} })).toBe(true)
    expect(JSON.parse(readFileSync(sentinel, 'utf8'))).toMatchObject({ by: 'shell', reason: 'shutdown' })
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
    expect(body('stopServerBounded')).toMatch(/await stopServerForQuit\(handle, \{ home: resolveHarnessHome\(\), log: logLine, clearCookies: clearAuthCookies,/u)
    expect(body('reveal')).toContain('quitting: () => quitting,')
    expect(source).toMatch(new RegExp([
      'resumeAfterFailedInstall: \\(blocking: boolean\\) => resumeAfterFailedInstall\\(\\{\\s+blocking,',
      '\\s+clearQuitting: \\(\\) => \\{ quitting = false \\},\\s+restartServer: \\(\\) => restartAfterStop\\(\'the failed install\'\\),\\s+reveal,',
    ].join(''), 'u'))
    expect(body('restartAfterStop')).toContain('await choosePort(readState().serverPort, isPortFree)')
    expect(body('carryMoveFromSettings')).toContain("await restartAfterStop('the withdrawn data move')")
  })

  it('writes the intentional-stop sentinel at a quit, the mandatory-update stop, and a session end, and nowhere else', () => {
    expect(source).toContain('await stopForMandatoryUpdate(server, { home: resolveHarnessHome(), log: sink })')
    expect(source).toContain("}, () => { markIntentionalStop(server, 'shutdown', { home: resolveHarnessHome(), log: logLine }) })")
    expect(source).not.toContain('writeIntentionalStop(')
    expect(source.match(/markIntentionalStop\(|stopServerForQuit\(|stopForMandatoryUpdate\(/gu)).toHaveLength(3)
    // The server's own stop paths: the startup-timeout kill and the orphan sweep.
    expect(readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')).not.toContain('crash-resume-sentinel')
  })
})

describe('an unexpected exit', () => {
  it('leaves no sentinel, so the next start continues the interrupted turns', async () => {
    const { sentinel } = sentinelHome()
    await respondToCrash({ forgetPort: () => {}, clearCookies: async () => {}, ladder: async () => 'relaunch', log: () => {} })
    expect(existsSync(sentinel)).toBe(false)
  })
})
