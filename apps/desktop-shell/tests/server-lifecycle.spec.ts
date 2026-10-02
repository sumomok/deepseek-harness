/**
 * The order of the steps around the server's end, run with recording fakes:
 * an unexpected exit stops the notification stream, forgets the port unless
 * the shell holds it, and removes the cookies before the recovery ladder; a
 * crash rebind keeps a held socket and otherwise asks for a system-picked
 * port; a quit removes the cookies before sending the stop and sends it even
 * when the removal never answers; reopening while quitting does nothing, and
 * reopening after the stopped-server dialog was dismissed shows it again.
 * @module
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SENTINEL_DIRECTORY, SENTINEL_FILE, writeIntentionalStop } from '../src/crash-resume-sentinel.ts'
import type { HeldListenSocket, ListenHandoff, NativeListenHandle } from '../src/listen-socket.ts'
import {
  COOKIE_CLEAR_BOUND_MS, markIntentionalStop, rebindOnHeldSocket, rebindOnNewPort, respondToCrash, resumeAfterFailedInstall, revealApp,
  stopForMandatoryUpdate, stopForQuit, stopServerForQuit, type RevealHooks,
} from '../src/server-lifecycle.ts'
import { ListenHandoffFailed, type ServerHandle, type ServerSpec } from '../src/server.ts'

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
  /**
   * Respond to a crash with recording fakes.
   * @param keepsPort - whether the shell holds the port.
   * @returns the recorded steps once the ladder ran.
   */
  async function crashSteps(keepsPort: boolean): Promise<string[]> {
    const steps: string[] = []
    await respondToCrash({
      keepsPort,
      stopNotifications: () => { steps.push('stop notifications') },
      forgetPort: () => { steps.push('forget') },
      clearCookies: async () => { await Promise.resolve(); steps.push('cleared') },
      ladder: async () => { steps.push('ladder'); return 'relaunch' },
      log: () => {},
    })
    return steps
  }

  it('stops the notification stream, forgets the port and finishes removing the cookies before the ladder runs', async () => {
    expect(await crashSteps(false)).toEqual(['stop notifications', 'forget', 'cleared', 'ladder'])
  })

  it('keeps the port the shell holds, and still stops the stream and removes the cookies first', async () => {
    expect(await crashSteps(true)).toEqual(['stop notifications', 'cleared', 'ladder'])
  })

  it('returns what the ladder decided', async () => {
    const outcome = await respondToCrash({
      keepsPort: false, stopNotifications: () => {}, forgetPort: () => {}, clearCookies: async () => {}, ladder: async () => 'relaunch', log: () => {},
    })
    expect(outcome).toBe('relaunch')
  })

  it('runs the ladder after the bound when the removal never answers, and says so', async () => {
    vi.useFakeTimers()
    const lines: string[] = []
    let laddered = false
    const done = respondToCrash({
      keepsPort: false,
      stopNotifications: () => {},
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
      keepsPort: false, stopNotifications: () => {}, forgetPort: () => {},
      clearCookies: async () => { throw new Error('store gone') }, ladder: async () => 'recovered', log: () => {},
    })
    expect(outcome).toBe('recovered')
  })
})

describe('rebindOnNewPort', () => {
  it('asks for a system-picked port whatever port the recorded spec names', async () => {
    const asked: Array<number | undefined> = []
    const handle: ServerHandle = { url: 'http://127.0.0.1:52000', authenticatedUrl: 'http://127.0.0.1:52000/?token=t', stop: async () => {}, exited: () => false, onExit: () => {} }
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
    const handle: ServerHandle = { url: 'http://127.0.0.1:52000', authenticatedUrl: 'http://127.0.0.1:52000/?token=t', stop: async () => {}, exited: () => false, onExit: () => {} }
    const spec: ServerSpec = { nodeBin: 'node', entry: 'bin.js', cwd: '/', reportDirectory: '/', env, port: 49_321 }
    const seen: Array<Record<string, string>> = []
    const started = await rebindOnNewPort(spec, async (s) => { seen.push(s.env); return handle }, () => {})
    expect(seen).toEqual([env])
    expect(started.spec.env).toEqual(env)
  })
})

/**
 * A held socket stand-in that records when it is closed.
 * @param steps - receives `close`.
 * @returns the socket.
 */
function recordingSocket(steps: string[]): HeldListenSocket {
  const handle: NativeListenHandle = { getsockname: () => 0, close: () => {} }
  return { port: 49_321, handle, close: () => { steps.push('close') } }
}

describe('rebindOnHeldSocket', () => {
  const handle: ServerHandle = { url: 'http://127.0.0.1:49321', authenticatedUrl: 'http://127.0.0.1:49321/?token=t', stop: async () => {}, exited: () => false, onExit: () => {} }
  const spec: ServerSpec = { nodeBin: 'node', entry: 'bin.js', cwd: '/', reportDirectory: '/', env: {}, port: 49_321 }

  it('starts the new server on the held socket and keeps it, so the port and the origin stay', async () => {
    const steps: string[] = []
    const handoff: ListenHandoff = { socket: recordingSocket(steps), preload: '/lib/listen-handoff.mjs' }
    const asked: ServerSpec[] = []
    const started = await rebindOnHeldSocket(spec, handoff, async (s) => { asked.push(s); return handle }, {
      log: () => {}, forgetPort: () => { steps.push('forget') }, release: () => { steps.push('release') },
    })
    expect(asked.map(s => [s.port, s.listen])).toEqual([[49_321, handoff]])
    expect(started.held).toBe(handoff)
    expect(started.spec.port).toBe(49_321)
    expect(started.spec.listen).toBeUndefined()
    expect(steps).toEqual([])
  })

  it('on a failed handoff forgets the port before releasing the socket, then starts on a system-picked port', async () => {
    const steps: string[] = []
    const lines: string[] = []
    const asked: Array<number | undefined> = []
    const started = await rebindOnHeldSocket(spec, { socket: recordingSocket(steps), preload: '/p.mjs' }, async (s) => {
      asked.push(s.port)
      steps.push(s.listen === undefined ? 'start' : 'start held')
      if (s.listen !== undefined) throw new ListenHandoffFailed('no socket arrived within 10s', '')
      return { ...handle, url: 'http://127.0.0.1:52000' }
    }, { log: (line) => { lines.push(line) }, forgetPort: () => { steps.push('forget') }, release: () => { steps.push('release') } })
    expect(steps).toEqual(['start held', 'release', 'forget', 'close', 'start'])
    expect(asked).toEqual([49_321, 0])
    expect(started.held).toBeUndefined()
    expect(started.spec.port).toBe(52_000)
    expect(lines.join('')).toContain('listen handoff unavailable (no socket arrived within 10s); this run changes origin on every crash rebind')
  })

  it('keeps the socket held through a failure that is not the handoff\'s, for the next attempt', async () => {
    const steps: string[] = []
    const failure = new Error('boom')
    await expect(rebindOnHeldSocket(spec, { socket: recordingSocket(steps), preload: '/p.mjs' }, async () => { throw failure }, {
      log: () => {}, forgetPort: () => { steps.push('forget') }, release: () => { steps.push('release') },
    })).rejects.toBe(failure)
    expect(steps).toEqual([])
  })

  it('has released the socket it closed when the start without it fails too', async () => {
    const steps: string[] = []
    const failure = new Error('no server at all')
    await expect(rebindOnHeldSocket(spec, { socket: recordingSocket(steps), preload: '/p.mjs' }, async (s) => {
      if (s.listen !== undefined) throw new ListenHandoffFailed('no socket arrived within 10s', '')
      throw failure
    }, {
      log: () => {}, forgetPort: () => { steps.push('forget') }, release: () => { steps.push('release') },
    })).rejects.toBe(failure)
    expect(steps).toEqual(['release', 'forget', 'close'])
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
      url: 'http://127.0.0.1:52000', authenticatedUrl: 'http://127.0.0.1:52000/?token=t',
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
  /**
   * Reveal with recording fakes.
   * @param state - whether a quit has begun, a window exists, and the backend was left stopped.
   * @returns the recorded calls.
   */
  function reveal(state: { quitting: boolean; window: boolean; stopped: boolean }): string[] {
    const calls: string[] = []
    const hooks: RevealHooks = {
      quitting: () => state.quitting,
      revealExisting: () => { calls.push('reveal'); return state.window },
      backendStopped: () => state.stopped,
      showStopped: () => { calls.push('stopped dialog') },
      openWindow: () => { calls.push('open') },
    }
    revealApp(hooks)
    return calls
  }

  it('does nothing while quitting', () => {
    expect(reveal({ quitting: true, window: true, stopped: false })).toEqual([])
    expect(reveal({ quitting: true, window: false, stopped: true })).toEqual([])
  })

  it('uncovers the existing window, and opens one only when there is none', () => {
    expect(reveal({ quitting: false, window: true, stopped: false })).toEqual(['reveal'])
    expect(reveal({ quitting: false, window: false, stopped: false })).toEqual(['reveal', 'open'])
  })

  it('shows the stopped-server dialog instead of a window once the user left the backend stopped', () => {
    expect(reveal({ quitting: false, window: false, stopped: true })).toEqual(['reveal', 'stopped dialog'])
    expect(reveal({ quitting: false, window: true, stopped: true })).toEqual(['reveal'])
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
        revealApp({
          quitting: () => quitting, revealExisting: () => { steps.push('shown'); return true },
          backendStopped: () => false, showStopped: () => {}, openWindow: () => {},
        })
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
    expect(body('handleUnexpectedServerExit')).toMatch(new RegExp([
      'respondToCrash\\(\\{\\s+keepsPort: held !== undefined,\\s+stopNotifications,',
      '\\s+forgetPort: forgetServerPort,\\s+clearCookies: clearAuthCookies,',
    ].join(''), 'u'))
    expect(body('handleUnexpectedServerExit')).toContain('ladder: () => runRecoveryLadder(')
    expect(body('performRebind')).toContain('await rebindOnNewPort(spec, startEmbeddedServer, logLine)')
    expect(body('performRebind')).toContain(
      'await rebindOnHeldSocket(spec, held, startEmbeddedServer, { log: logLine, forgetPort: forgetServerPort, release: releaseHeld })',
    )
    expect(body('releaseHeld')).toContain('held = undefined')
    expect(body('stopServerBounded')).toMatch(/await stopServerForQuit\(handle, \{ home: resolveHarnessHome\(\), log: logLine, clearCookies: clearAuthCookies,/u)
    expect(body('reveal')).toContain('quitting: () => quitting,')
    expect(source).toMatch(new RegExp([
      'resumeAfterFailedInstall: \\(blocking: boolean\\) => resumeAfterFailedInstall\\(\\{\\s+blocking,',
      '\\s+clearQuitting: \\(\\) => \\{ quitting = false \\},\\s+restartServer: restartAfterFailedInstall,\\s+reveal,',
    ].join(''), 'u'))
    expect(body('restartAfterFailedInstall')).toContain('await choosePort(readState().serverPort, isPortFree)')
    expect(body('restartAfterFailedInstall')).toContain('{ ...spec, port: held.socket.port }, held, startEmbeddedServer,')
    expect(body('reveal')).toContain("backendStopped: () => stoppedDialog === 'dismissed',")
    expect(body('runStoppedDialog')).toContain("stoppedDialog = 'dismissed'")
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
    await respondToCrash({
      keepsPort: true, stopNotifications: () => {}, forgetPort: () => {}, clearCookies: async () => {}, ladder: async () => 'relaunch', log: () => {},
    })
    expect(existsSync(sentinel)).toBe(false)
  })
})
