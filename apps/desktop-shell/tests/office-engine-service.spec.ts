/**
 * The loopback Office engine protocol and the state machine behind it: what
 * each route refuses, how a download goes from the confirmation to the engine
 * on disk, and what cancelling, failing, and quitting leave. The installer and
 * the confirmation are injected, so nothing here runs a package manager or a
 * dialog.
 * @module
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EngineRequirement, InstallOutcome, InstallSpec, RequirementResult } from '../src/office-engine.ts'
import {
  CANCEL_PATH, confirmRequest, ENDPOINT_ENV, INSTALL_PATH, OfficeEngineManager, startOfficeEngineService, STATE_PATH,
  TOKEN_ENV, type EngineConfirmRequest, type OfficeEngineServiceHandle,
} from '../src/office-engine-service.ts'

const REQUIREMENT: EngineRequirement = {
  target: 'darwin-arm64',
  name: '@deepseek-ai/libreoffice-kit-darwin-arm64',
  version: '0.1.1',
  downloadBytes: 66_711_287,
}

const made: string[] = []
let service: OfficeEngineServiceHandle | undefined

afterEach(async () => {
  await service?.close()
  service = undefined
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Put a complete engine where the manager looks, the way a finished install leaves it. */
function placeEngine(root: string, version = REQUIREMENT.version): void {
  const dir = join(root, version, 'node_modules', REQUIREMENT.name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: REQUIREMENT.name, version }))
  writeFileSync(join(dir, 'prebuilds.json'), '{}')
}

/** A promise the case settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** What one harness recorded and lets the case drive. */
interface Harness {
  root: string
  manager: OfficeEngineManager
  handle: OfficeEngineServiceHandle
  asked: EngineConfirmRequest[]
  answer: (yes: boolean) => void
  installs: InstallSpec[]
  finish: (outcome: InstallOutcome) => void
  log: string[]
}

/**
 * Start one service over an injected confirmation and installer. The
 * confirmation waits for {@link Harness.answer}; the installer waits for
 * {@link Harness.finish} and, on success, places the engine as a real one would.
 */
async function start(requirement: RequirementResult = { ok: true, requirement: REQUIREMENT }): Promise<Harness> {
  const root = join(mkdtempSync(join(tmpdir(), 'dsh-engine-svc-')), 'engines', 'office')
  made.push(join(root, '..', '..'))
  const asked: EngineConfirmRequest[] = []
  const installs: InstallSpec[] = []
  const log: string[] = []
  let answer = deferred<boolean>()
  let finish = deferred<InstallOutcome>()
  const manager = new OfficeEngineManager({
    requirement,
    root,
    pnpm: { command: 'pnpm', prefixArgs: [] },
    confirm: async (request) => {
      asked.push(request)
      const verdict = await answer.promise
      answer = deferred<boolean>()
      return verdict
    },
    log: (line) => { log.push(line) },
    installTimeoutMs: 1000,
    install: async (spec) => {
      installs.push(spec)
      spec.signal.addEventListener('abort', () => { finish.resolve({ ok: false, cancelled: true, reason: 'cancelled' }) })
      const outcome = await finish.promise
      finish = deferred<InstallOutcome>()
      if (outcome.ok) placeEngine(spec.root)
      return outcome
    },
  })
  service = await startOfficeEngineService(manager)
  return {
    root, manager, handle: service, asked, installs, log,
    answer: (yes) => { answer.resolve(yes) },
    finish: (outcome) => { finish.resolve(outcome) },
  }
}

/** Call one route with this service's token, unless the case passes another header. */
async function call(handle: OfficeEngineServiceHandle, method: string, path: string, authorization = `Bearer ${handle.token}`): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${handle.endpoint}${path}`, { method, headers: { authorization } })
  const text = await response.text()
  const json = response.headers.get('content-type')?.startsWith('application/json') ?? false
  const body: unknown = json ? JSON.parse(text) : text.trim()
  return { status: response.status, body }
}

/** Let the manager's background steps run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
}

describe('the office engine protocol', () => {
  it('names its two variables the way the plugin reads them', () => {
    expect([ENDPOINT_ENV, TOKEN_ENV]).toEqual(['DSH_DESKTOP_OFFICE_ENGINE_ENDPOINT', 'DSH_DESKTOP_OFFICE_ENGINE_TOKEN'])
  })

  it('answers an unknown route 404 before it reads the token, and a known one 401 without it', async () => {
    const { handle } = await start()
    expect((await call(handle, 'GET', '/other', 'Bearer nope')).status).toBe(404)
    expect((await call(handle, 'GET', INSTALL_PATH)).status).toBe(404)
    expect((await call(handle, 'POST', STATE_PATH)).status).toBe(404)
    expect((await call(handle, 'GET', STATE_PATH, 'Bearer nope')).status).toBe(401)
    expect((await call(handle, 'POST', INSTALL_PATH, '')).status).toBe(401)
  })

  it('reports an engine that is not installed, with its version and download size', async () => {
    const { handle } = await start()
    expect(await call(handle, 'GET', STATE_PATH)).toEqual({ status: 200, body: { phase: 'absent', version: '0.1.1', downloadBytes: 66_711_287 } })
  })

  it('reports an installed engine read from disk, and refuses to install it again', async () => {
    const { handle, root } = await start()
    placeEngine(root)
    expect((await call(handle, 'GET', STATE_PATH)).body).toEqual({ phase: 'installed', version: '0.1.1', downloadBytes: 66_711_287 })
    expect(await call(handle, 'POST', INSTALL_PATH)).toEqual({ status: 409, body: 'the preview engine is already installed' })
  })

  it('reports a host with no engine, and refuses every command there', async () => {
    const { handle } = await start({ ok: false, reason: 'no LibreOffice engine is built for linux-x64' })
    expect((await call(handle, 'GET', STATE_PATH)).body).toEqual({ phase: 'unsupported', reason: 'no LibreOffice engine is built for linux-x64' })
    expect(await call(handle, 'POST', INSTALL_PATH)).toEqual({ status: 409, body: 'no LibreOffice engine is built for linux-x64' })
    expect((await call(handle, 'POST', CANCEL_PATH)).status).toBe(409)
  })
})

describe('a download', () => {
  it('asks first, answers at once, and installs only after the person says yes', async () => {
    const harness = await start()
    const { handle } = harness
    expect(await call(handle, 'POST', INSTALL_PATH)).toEqual({ status: 202, body: { phase: 'confirming', version: '0.1.1', downloadBytes: 66_711_287 } })
    await settle()
    expect(harness.asked).toEqual([confirmRequest(REQUIREMENT)])
    expect(harness.installs).toEqual([])
    expect(await call(handle, 'POST', INSTALL_PATH)).toEqual({ status: 409, body: 'a download of the preview engine is already being confirmed or running' })

    harness.answer(true)
    await settle()
    expect(harness.installs.map(spec => [spec.root, spec.requirement, spec.timeoutMs])).toEqual([[harness.root, REQUIREMENT, 1000]])
    expect((await call(handle, 'GET', STATE_PATH)).body).toEqual({
      phase: 'installing', version: '0.1.1', downloadBytes: 66_711_287, transferredBytes: 0, totalBytes: 66_711_287,
    })
    harness.installs[0]?.onProgress({ transferredBytes: 1234, totalBytes: 5000 })
    expect((await call(handle, 'GET', STATE_PATH)).body).toMatchObject({ phase: 'installing', transferredBytes: 1234, totalBytes: 5000 })

    harness.finish({ ok: true })
    await settle()
    expect((await call(handle, 'GET', STATE_PATH)).body).toEqual({ phase: 'installed', version: '0.1.1', downloadBytes: 66_711_287 })
  })

  it('removes other versions once the new one is in place', async () => {
    const harness = await start()
    placeEngine(harness.root, '0.1.0')
    await call(harness.handle, 'POST', INSTALL_PATH)
    harness.answer(true)
    await settle()
    harness.finish({ ok: true })
    await settle()
    expect(readdirSync(harness.root)).toEqual(['0.1.1'])
  })

  it('downloads nothing when the person declines, and can be asked again', async () => {
    const harness = await start()
    await call(harness.handle, 'POST', INSTALL_PATH)
    harness.answer(false)
    await settle()
    expect(harness.installs).toEqual([])
    expect((await call(harness.handle, 'GET', STATE_PATH)).body).toMatchObject({ phase: 'absent' })
    expect((await call(harness.handle, 'POST', INSTALL_PATH)).status).toBe(202)
  })

  it('goes back to absent when the confirmation cannot be shown', async () => {
    const manager = new OfficeEngineManager({
      requirement: { ok: true, requirement: REQUIREMENT },
      root: join(tmpdir(), 'dsh-engine-never-created'),
      pnpm: { command: 'pnpm', prefixArgs: [] },
      confirm: () => Promise.reject(new Error('no display')),
      log: () => {},
      installTimeoutMs: 1000,
    })
    expect(manager.requestInstall()).toBeUndefined()
    await settle()
    expect(manager.snapshot().phase).toBe('absent')
  })

  it('reports a failure with its reason, and offers the download again', async () => {
    const harness = await start()
    await call(harness.handle, 'POST', INSTALL_PATH)
    harness.answer(true)
    await settle()
    harness.finish({ ok: false, cancelled: false, reason: 'the package manager exited with 1: 404' })
    await settle()
    expect((await call(harness.handle, 'GET', STATE_PATH)).body).toEqual({
      phase: 'failed', version: '0.1.1', downloadBytes: 66_711_287, reason: 'the package manager exited with 1: 404',
    })
    expect((await call(harness.handle, 'POST', INSTALL_PATH)).status).toBe(202)
    harness.answer(true)
    await settle()
    // A new attempt clears the earlier failure while it runs.
    expect((await call(harness.handle, 'GET', STATE_PATH)).body).toMatchObject({ phase: 'installing' })
    expect(harness.log.some(line => line.includes('install failed: the package manager exited with 1: 404'))).toBe(true)
  })

  it('stops on cancel, reports absent rather than failed, and refuses a cancel with nothing running', async () => {
    const harness = await start()
    expect(await call(harness.handle, 'POST', CANCEL_PATH)).toEqual({ status: 409, body: 'no download of the preview engine is running' })
    await call(harness.handle, 'POST', INSTALL_PATH)
    expect((await call(harness.handle, 'POST', CANCEL_PATH)).status).toBe(409)
    harness.answer(true)
    await settle()
    expect((await call(harness.handle, 'POST', CANCEL_PATH)).status).toBe(202)
    await settle()
    expect((await call(harness.handle, 'GET', STATE_PATH)).body).toEqual({ phase: 'absent', version: '0.1.1', downloadBytes: 66_711_287 })
  })

  it('aborts a running download when the service closes, and waits for it to end', async () => {
    const harness = await start()
    await call(harness.handle, 'POST', INSTALL_PATH)
    harness.answer(true)
    await settle()
    const signal = harness.installs[0]?.signal
    await harness.handle.close()
    service = undefined
    expect(signal?.aborted).toBe(true)
  })

  it('does not wait on a confirmation when it closes, and a yes that arrives after does not download', async () => {
    const harness = await start()
    await call(harness.handle, 'POST', INSTALL_PATH)
    await settle()
    await harness.handle.close()
    service = undefined
    harness.answer(true)
    await settle()
    expect(harness.installs).toEqual([])
  })
})

describe('confirmRequest', () => {
  it('quotes the download size in whole megabytes, and leaves it out when unknown', () => {
    expect(confirmRequest(REQUIREMENT).detail).toBe('约 64 MB，下载后保存在这台电脑上，之后在应用里打开这类文件会直接显示内容。')
    const { downloadBytes: _omitted, ...unknown } = REQUIREMENT
    expect(confirmRequest(unknown).detail).toBe('下载后保存在这台电脑上，之后在应用里打开这类文件会直接显示内容。')
  })
})
