/**
 * The loopback update protocol: what it refuses, in what order it decides, and
 * what it does with the requests it accepts. The channel behind it is injected,
 * so everything here runs without electron and without a feed.
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  CHECK_PATH, DOWNLOAD_PATH, ENDPOINT_ENV, INSTALL_PATH, startUpdateService, STATE_PATH, TOKEN_ENV,
  type UpdateServiceHandle,
} from '../src/update-service.ts'
import { UpdateState } from '../src/update-state.ts'

/** The running build every case reports as installed. */
const CURRENT = '0.1.0-rc.32'

/** The version the feed offers in every case that has one. */
const NEXT = '0.1.0-rc.33'

let service: UpdateServiceHandle | undefined

afterEach(async () => {
  await service?.close()
  service = undefined
})

/** What one started service recorded about the calls it made. */
interface Recorded {
  /** How many background checks were asked for. */
  checks: number
  /** How many transfers were asked for. */
  downloads: number
  /** How many installs were asked for. */
  installs: number
}

/**
 * Start one service over a state machine this case drives directly.
 * @param state - the channel state to report; a fresh idle one by default.
 * @returns the handle, the state it reports, and the record of what it drove.
 */
async function start(state: UpdateState = new UpdateState(CURRENT)): Promise<{
  handle: UpdateServiceHandle
  state: UpdateState
  recorded: Recorded
}> {
  const recorded: Recorded = { checks: 0, downloads: 0, installs: 0 }
  service = await startUpdateService({
    state: () => state.snapshot(),
    check: () => { recorded.checks++ },
    download: () => { recorded.downloads++ },
    install: () => { recorded.installs++ },
  })
  return { handle: service, state, recorded }
}

/** Call one of this service's routes with its own token. */
async function call(
  handle: UpdateServiceHandle,
  path: string,
  method = 'POST',
  token: string | null = handle.token,
): Promise<Response> {
  return fetch(`${handle.endpoint}${path}`, {
    method,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  })
}

/** The parsed JSON body of one answer. */
async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

/** A machine with an update downloaded, verified and waiting. */
function readyState(): UpdateState {
  const state = new UpdateState(CURRENT)
  state.downloadStarted(NEXT)
  state.downloadReady(NEXT, 'fixes the thing')
  return state
}

describe('the listener', () => {
  it('binds the loopback address on an ephemeral port', async () => {
    const { handle } = await start()
    expect(handle.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('mints a fresh 32-byte token per launch, and puts it in no environment', async () => {
    const { handle } = await start()
    expect(handle.token).toMatch(/^[0-9a-f]{64}$/)
    expect(process.env[ENDPOINT_ENV]).toBeUndefined()
    expect(process.env[TOKEN_ENV]).toBeUndefined()
  })
})

describe('admission', () => {
  it('answers 401 without a token', async () => {
    const { handle, recorded } = await start()
    const response = await call(handle, STATE_PATH, 'GET', null)
    expect(response.status).toBe(401)
    expect(recorded.checks).toBe(0)
  })

  it('answers 401 for another service\'s token', async () => {
    const { handle } = await start()
    expect((await call(handle, CHECK_PATH, 'POST', 'f'.repeat(64))).status).toBe(401)
  })

  it('decides the route before the token, so an unknown path is 404 either way', async () => {
    const { handle } = await start()
    expect((await call(handle, '/quit', 'POST', null)).status).toBe(404)
    expect((await call(handle, '/quit')).status).toBe(404)
  })

  it('answers 404 for the wrong method on a known path', async () => {
    const { handle } = await start()
    expect((await call(handle, STATE_PATH)).status).toBe(404)
    expect((await call(handle, CHECK_PATH, 'GET')).status).toBe(404)
  })
})

describe('GET /state', () => {
  it('answers the whole snapshot', async () => {
    const { handle } = await start(readyState())
    const response = await call(handle, STATE_PATH, 'GET')
    expect(response.status).toBe(200)
    expect(await jsonOf(response)).toEqual({
      phase: 'ready',
      currentVersion: CURRENT,
      latestVersion: NEXT,
      releaseNotes: 'fixes the thing',
    })
  })

  it('reports the phase and the progress of a transfer in flight', async () => {
    const state = new UpdateState(CURRENT)
    state.downloadStarted(NEXT)
    state.downloadProgress({ percent: 42.5, transferred: 425, total: 1000 })
    const { handle } = await start(state)
    expect(await jsonOf(await call(handle, STATE_PATH, 'GET'))).toEqual({
      phase: 'downloading',
      currentVersion: CURRENT,
      latestVersion: NEXT,
      percent: 42.5,
      transferredBytes: 425,
      totalBytes: 1000,
    })
  })

  it('drives nothing', async () => {
    const { handle, recorded } = await start()
    await call(handle, STATE_PATH, 'GET')
    expect(recorded).toEqual({ checks: 0, downloads: 0, installs: 0 })
  })
})

describe('the three actions', () => {
  it('accept a check and a transfer and answer with the state', async () => {
    const { handle, recorded } = await start()
    const checked = await call(handle, CHECK_PATH)
    expect(checked.status).toBe(202)
    expect(await jsonOf(checked)).toEqual({ phase: 'idle', currentVersion: CURRENT })
    expect((await call(handle, DOWNLOAD_PATH)).status).toBe(202)
    expect(recorded).toEqual({ checks: 1, downloads: 1, installs: 0 })
  })

  it('install the update that is ready, without asking anything further', async () => {
    const { handle, recorded } = await start(readyState())
    const response = await call(handle, INSTALL_PATH)
    expect(response.status).toBe(202)
    expect(recorded.installs).toBe(1)
  })

  it('refuse to install anything that is not downloaded and verified', async () => {
    const downloading = new UpdateState(CURRENT)
    downloading.downloadStarted(NEXT)
    const { handle, recorded } = await start(downloading)
    const response = await call(handle, INSTALL_PATH)
    expect(response.status).toBe(409)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(recorded.installs).toBe(0)
  })

  it('refuse to install from an idle channel', async () => {
    const { handle, recorded } = await start()
    expect((await call(handle, INSTALL_PATH)).status).toBe(409)
    expect(recorded.installs).toBe(0)
  })
})

describe('the stop', () => {
  it('closes the listener', async () => {
    const { handle } = await start()
    const endpoint = handle.endpoint
    await handle.close()
    service = undefined
    await expect(fetch(`${endpoint}${STATE_PATH}`)).rejects.toThrow()
  })
})
