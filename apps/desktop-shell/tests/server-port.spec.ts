/**
 * The embedded server's port choice: the remembered port is asked for again
 * while it is free, a taken one falls back to a system-picked port, and the
 * port the server actually listens on is what the next launch remembers.
 * Port checks run against real loopback listeners this file opens itself.
 * @module
 */

import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { choosePort, isAddressInUse, isListenPort, isPortFree, portOf, startOnPort } from '../src/server-port.ts'
import { ServerExitedBeforeUrl, type ServerHandle, type ServerSpec } from '../src/server.ts'

/** Listeners a case opened, closed after it. */
const listeners: Server[] = []

afterEach(async () => {
  await Promise.all(listeners.splice(0).map(listener => new Promise((resolve) => { listener.close(resolve) })))
})

/**
 * Hold a loopback port for the rest of the case.
 * @returns the port.
 */
async function holdPort(): Promise<number> {
  const listener = createServer()
  listeners.push(listener)
  await new Promise<void>((resolve) => { listener.listen(0, '127.0.0.1', resolve) })
  const address = listener.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

/** A launch whose paths do not matter to the port logic. */
const SPEC: ServerSpec = { nodeBin: 'node', entry: 'bin.js', cwd: '/', reportDirectory: '/', env: {} }

/**
 * A started server stand-in listening on `port`.
 * @param port - the port its origin names.
 * @returns the handle.
 */
function handleOn(port: number): ServerHandle {
  return {
    url: `http://127.0.0.1:${String(port)}`,
    authenticatedUrl: `http://127.0.0.1:${String(port)}/?token=t`,
    stop: async () => {},
    onExit: () => {},
  }
}

/** The failure `startServer` rejects with when `--port` is held by another process. */
const IN_USE = new ServerExitedBeforeUrl('dsh server exited before its URL line (code 1).',
  'Error: listen EADDRINUSE: address already in use 127.0.0.1:49321\n')

describe('isListenPort', () => {
  it('accepts integers from 1 to 65535 and nothing else', () => {
    expect([1, 49_321, 65_535].every(isListenPort)).toBe(true)
    expect([0, 65_536, -1, 1.5, '49321', null, undefined].some(isListenPort)).toBe(false)
  })
})

describe('isPortFree', () => {
  it('answers false for a port a listener holds, and true once it is released', async () => {
    const port = await holdPort()
    expect(await isPortFree(port)).toBe(false)
    await new Promise((resolve) => { listeners.pop()?.close(resolve) })
    expect(await isPortFree(port)).toBe(true)
  })
})

describe('choosePort', () => {
  it('lets the system pick when nothing is remembered', async () => {
    const choice = await choosePort(undefined, async () => true)
    expect(choice.port).toBe(0)
    expect(choice.line).toContain('none remembered')
  })

  it('reuses a remembered port that is free', async () => {
    const choice = await choosePort(49_321, async port => port === 49_321)
    expect(choice).toEqual({ port: 49_321, line: '[desktop] server port: reusing 49321\n' })
  })

  it('falls back to a system-picked port when the remembered one is taken', async () => {
    const taken = await holdPort()
    const choice = await choosePort(taken, isPortFree)
    expect(choice.port).toBe(0)
    expect(choice.line).toContain(`${String(taken)} is in use`)
  })
})

describe('portOf', () => {
  it('reads the port from a server origin', () => {
    expect(portOf('http://127.0.0.1:49321')).toBe(49_321)
  })

  it('answers undefined for an origin with no explicit port', () => {
    expect(portOf('http://127.0.0.1')).toBeUndefined()
  })
})

describe('isAddressInUse', () => {
  it('recognizes an exit whose output names EADDRINUSE', () => {
    expect(isAddressInUse(IN_USE)).toBe(true)
  })

  it('does not treat other exits or errors as a taken port', () => {
    expect(isAddressInUse(new ServerExitedBeforeUrl('exit', 'Error: boom\n'))).toBe(false)
    expect(isAddressInUse(new Error('listen EADDRINUSE'))).toBe(false)
  })
})

describe('startOnPort', () => {
  it('returns the spec with the port the server listens on', async () => {
    const asked: Array<number | undefined> = []
    const started = await startOnPort({ ...SPEC, port: 0 }, async (spec) => {
      asked.push(spec.port)
      return handleOn(51_000)
    }, () => {})
    expect(asked).toEqual([0])
    expect(started.spec.port).toBe(51_000)
    expect(started.server.url).toBe('http://127.0.0.1:51000')
  })

  it('retries once on a system-picked port when the asked port was taken at bind time', async () => {
    const asked: Array<number | undefined> = []
    const lines: string[] = []
    const started = await startOnPort({ ...SPEC, port: 49_321 }, async (spec) => {
      asked.push(spec.port)
      if (spec.port === 49_321) throw IN_USE
      return handleOn(52_000)
    }, (line) => { lines.push(line) })
    expect(asked).toEqual([49_321, 0])
    expect(started.spec.port).toBe(52_000)
    expect(lines.join('')).toContain('49321 was taken')
  })

  it('does not retry a failure that is not a taken port', async () => {
    const failure = new ServerExitedBeforeUrl('exit', 'Error: boom\n')
    let calls = 0
    await expect(startOnPort({ ...SPEC, port: 49_321 }, async () => {
      calls += 1
      throw failure
    }, () => {})).rejects.toBe(failure)
    expect(calls).toBe(1)
  })

  it('does not retry a taken-port failure of a start that asked for no particular port', async () => {
    let calls = 0
    await expect(startOnPort({ ...SPEC, port: 0 }, async () => {
      calls += 1
      throw IN_USE
    }, () => {})).rejects.toBe(IN_USE)
    await expect(startOnPort(SPEC, async () => {
      calls += 1
      throw IN_USE
    }, () => {})).rejects.toBe(IN_USE)
    expect(calls).toBe(2)
  })

  it('keeps the asked port when the origin names none', async () => {
    const started = await startOnPort({ ...SPEC, port: 49_321 }, async () => ({ ...handleOn(1), url: 'http://127.0.0.1' }), () => {})
    expect(started.spec.port).toBe(49_321)
  })
})

describe('the launch sequence in main.ts', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')

  it('checks the remembered port after the orphan sweep and the loopback services, and just before the spawn', () => {
    const choice = source.indexOf('await choosePort(')
    expect(choice).toBeGreaterThan(-1)
    expect(source.indexOf('await sweepOrphanedServers(')).toBeLessThan(choice)
    expect(source.indexOf('await startRenderServiceForServer(')).toBeLessThan(choice)
    expect(source.indexOf('await startUpdateForServer(')).toBeLessThan(choice)
    expect(source.lastIndexOf('await startOnPort(')).toBeGreaterThan(choice)
  })

  it('starts both the launch and the crash rebind through startOnPort and records the port each time', () => {
    expect([...source.matchAll(/await startOnPort\(/g)]).toHaveLength(2)
    expect([...source.matchAll(/rememberServerPort\(started\.spec\)/g)]).toHaveLength(2)
  })
})
