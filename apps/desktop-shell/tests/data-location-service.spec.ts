/**
 * The loopback data-location protocol: the order it decides in (route, then
 * token, then body), what it answers, and that `/start` answers before the
 * move is carried on. What the routes drive is injected, so everything here
 * runs without electron and without moving anything.
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  CHOOSE_PATH, ENDPOINT_ENV, MAX_BODY_BYTES, parseMoveBody, PREFLIGHT_PATH, RETRY_CLEANUP_PATH, START_PATH, startDataLocationService,
  STATE_PATH, TOKEN_ENV,
  type DataLocationServiceHandle, type DataLocationServiceSpec, type MoveBody,
} from '../src/data-location-service.ts'
import type { MoveStartOutcome } from '../src/move-start.ts'
import type { MoveJournal } from '../src/move/journal.ts'
import type { PreflightResult } from '../src/move/preflight.ts'

const services: DataLocationServiceHandle[] = []

afterEach(async () => {
  for (const running of services.splice(0)) await running.close()
})

const VERDICT: PreflightResult = {
  ok: true, target: { target: '/Volumes/Data/DSH-Data', parent: '/Volumes/Data', preexisting: false },
  sameVolume: false, copyBytes: 10, neededBytes: 20, refusals: [], warnings: [],
}

/** What the routes were asked to do, in order. */
type Call = { route: 'choose' } | { route: 'preflight' | 'begin'; body: MoveBody } | { route: 'carry'; journal: MoveJournal } | { route: 'retry' }

/**
 * Start one service whose routes record what they were asked.
 * @param changes - replacements for the recording stand-ins.
 * @returns the handle and the calls.
 */
async function start(changes: Partial<DataLocationServiceSpec> = {}): Promise<{ handle: DataLocationServiceHandle; calls: Call[] }> {
  const calls: Call[] = []
  const journal = { moveId: 'm1' } as Pick<MoveJournal, 'moveId'> as MoveJournal
  const service = await startDataLocationService({
    state: () => ({ home: '/Users/p/.dsh', moving: false }),
    choose: async () => { calls.push({ route: 'choose' }); return '/Volumes/Data' },
    preflight: async (body) => { calls.push({ route: 'preflight', body }); return VERDICT },
    begin: async (body) => { calls.push({ route: 'begin', body }); return { kind: 'started', journal, preflight: VERDICT } },
    carry: (carried) => { calls.push({ route: 'carry', journal: carried }) },
    retryCleanup: () => { calls.push({ route: 'retry' }); return 'started' },
    ...changes,
  })
  services.push(service)
  return { handle: service, calls }
}

/**
 * Call one route.
 * @param handle - the service.
 * @param path - the route.
 * @param init - the method, the body, and the token (this service's unless named).
 * @returns the response.
 */
async function call(
  handle: DataLocationServiceHandle, path: string, init: { method?: string; body?: string; token?: string | null } = {},
): Promise<Response> {
  const token = init.token === undefined ? handle.token : init.token
  return await fetch(`${handle.endpoint}${path}`, {
    method: init.method ?? 'POST',
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    ...init.body === undefined ? {} : { body: init.body },
  })
}

const BODY = JSON.stringify({ target: '/Volumes/Data', workspaces: ['/Users/p/work'] })

describe('the data location service', () => {
  it('listens on the loopback address with a fresh token, and puts neither in this process\'s environment', async () => {
    const { handle } = await start()
    expect(handle.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(handle.token).toMatch(/^[0-9a-f]{64}$/)
    expect(process.env[ENDPOINT_ENV]).toBeUndefined()
    expect(process.env[TOKEN_ENV]).toBeUndefined()
  })

  it('answers 404 for an unknown route before it looks at the token, and 401 for a known route without the right one', async () => {
    const { handle, calls } = await start()
    expect((await call(handle, '/nope', { token: null })).status).toBe(404)
    expect((await call(handle, STATE_PATH, { token: null })).status).toBe(404)
    expect((await call(handle, START_PATH, { method: 'GET' })).status).toBe(404)
    expect((await call(handle, START_PATH, { token: null, body: BODY })).status).toBe(401)
    expect((await call(handle, STATE_PATH, { method: 'GET', token: 'f'.repeat(64) })).status).toBe(401)
    expect(calls).toEqual([])
  })

  it('reports the state, and what the folder picker returned', async () => {
    const { handle } = await start()
    expect(await (await call(handle, STATE_PATH, { method: 'GET' })).json()).toEqual({ home: '/Users/p/.dsh', moving: false })
    expect(await (await call(handle, CHOOSE_PATH)).json()).toEqual({ path: '/Volumes/Data' })
    const cancelled = await start({ choose: async () => undefined })
    expect(await (await call(cancelled.handle, CHOOSE_PATH)).json()).toEqual({})
  })

  it('refuses a body that is too large or not a move, before it checks anything', async () => {
    const { handle, calls } = await start()
    const large = JSON.stringify({ target: 'x'.repeat(MAX_BODY_BYTES), workspaces: [] })
    expect((await call(handle, PREFLIGHT_PATH, { body: large })).status).toBe(413)
    expect((await call(handle, START_PATH, { body: '{' })).status).toBe(400)
    expect((await call(handle, START_PATH, { body: JSON.stringify({ target: '/x' }) })).status).toBe(400)
    expect(calls).toEqual([])
    expect(parseMoveBody('[]')).toBe('target must be a non-empty string')
    expect(parseMoveBody(JSON.stringify({ target: '', workspaces: [] }))).toBe('target must be a non-empty string')
    expect(parseMoveBody(JSON.stringify({ target: '/x', workspaces: [1] }))).toBe('workspaces must be an array of strings')
    expect(parseMoveBody(BODY)).toEqual({ target: '/Volumes/Data', workspaces: ['/Users/p/work'] })
  })

  it('passes the verdict of a check through', async () => {
    const refused: PreflightResult = { ...VERDICT, ok: false, refusals: [{ kind: 'not-empty' }] }
    const { handle, calls } = await start({ preflight: async () => refused })
    const response = await call(handle, PREFLIGHT_PATH, { body: BODY })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(refused)
    expect(calls).toEqual([])
  })

  it('answers a start with 202 before the move is carried on, and never carries a move that did not start', async () => {
    // The move stops the server the caller is waiting on: here the listener and its connections go down at once.
    let carried = 0
    const { handle, calls } = await start({ carry: () => { carried += 1; void services[0]?.close() } })
    const response = await call(handle, START_PATH, { body: BODY })
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ ok: true })
    expect(carried).toBe(1)
    expect(calls).toEqual([{ route: 'begin', body: { target: '/Volumes/Data', workspaces: ['/Users/p/work'] } }])
    const refusal: MoveStartOutcome = { kind: 'refused', refusal: { kind: 'in-progress' } }
    const neverCarried: string[] = []
    const refused = await start({ begin: async () => refusal, carry: () => { neverCarried.push('carried') } })
    const answer = await call(refused.handle, START_PATH, { body: BODY })
    expect(answer.status).toBe(409)
    expect(await answer.json()).toEqual({ kind: 'in-progress' })
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(neverCarried).toEqual([])
  })

  it('carries a waiting cleanup on again, and says why not when it does not', async () => {
    const { handle } = await start()
    expect((await call(handle, RETRY_CLEANUP_PATH)).status).toBe(202)
    for (const reason of ['none-waiting', 'running', 'no-window'] as const) {
      const refused = await start({ retryCleanup: () => reason })
      const response = await call(refused.handle, RETRY_CLEANUP_PATH)
      expect(response.status, reason).toBe(409)
      expect(await response.json(), reason).toEqual({ reason })
    }
  })

  it('opens one folder picker at a time, and another once it closed', async () => {
    let close: (picked: string | undefined) => void = () => undefined
    let opened = 0
    const { handle } = await start({
      choose: () => { opened += 1; return new Promise((resolve) => { close = resolve }) },
    })
    const first = call(handle, CHOOSE_PATH)
    await expect.poll(() => opened).toBe(1)
    const second = await call(handle, CHOOSE_PATH)
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({ reason: 'choosing' })
    close('/Volumes/Data')
    expect(await (await first).json()).toEqual({ path: '/Volumes/Data' })
    const third = call(handle, CHOOSE_PATH)
    await expect.poll(() => opened).toBe(2)
    close(undefined)
    expect(await (await third).json()).toEqual({})
  })

  it('frees the picker slot when the picker fails', async () => {
    let attempts = 0
    const { handle } = await start({ choose: async () => { attempts += 1; if (attempts === 1) throw new Error('no window'); return '/x' } })
    expect((await call(handle, CHOOSE_PATH)).status).toBe(500)
    expect(await (await call(handle, CHOOSE_PATH)).json()).toEqual({ path: '/x' })
  })

  it('answers 500 with the error when a route fails', async () => {
    const { handle } = await start({ preflight: async () => { throw new Error('statfs failed') } })
    const response = await call(handle, PREFLIGHT_PATH, { body: BODY })
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('statfs failed')
  })
})
