/**
 * The fallback half of a transfer: after the library's own retry plan is spent,
 * the shell transfers the frozen artifact itself, stages it in the updater
 * cache, and hands it back to the same library call. That second library run is
 * what validates the cache and raises `update-downloaded` — nothing here
 * declares an update ready, and nothing reaches the installer without the click
 * that follows.
 *
 * electron and electron-updater stand in; the artifact is served by a real local
 * HTTP server, so the bytes the resumable downloader keeps are real bytes with a
 * real digest.
 * @module
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReleaseIdentity } from '../src/release-identity.ts'
import type { UpdateHost } from '../src/updater.ts'

/** The running build. */
const CURRENT = '0.1.0-rc.32'

/** The running build's sequence. */
const CURRENT_BUILD = 32

/** The build the feed offers. */
const NEXT = '0.1.0-rc.33'

/** The offered build's sequence. */
const NEXT_BUILD = 33

/** The artifact's name, as the feed lists it. */
const FILE_NAME = 'DSH Desktop-0.1.0-rc.33-arm64-mac.zip'

/** The artifact's bytes. */
const BYTES = Buffer.from('the update artifact, one block of it'.repeat(64))

/** The base64 SHA-512 of [[BYTES]], as a manifest states it. */
const SHA512 = createHash('sha512').update(BYTES).digest('base64')

/** What the stand-ins read and record. Hoisted because the mock factories run first. */
const fixture = vi.hoisted(() => ({
  home: '',
  appPath: '',
  /** Every request the artifact server answered, as its decoded path. */
  requests: [] as string[],
  /** How many times the library's download was asked to run. */
  runs: 0,
  /** Whether the artifact was already staged when the last run started. */
  stagedWhenRun: [] as boolean[],
  /** Whether the server answers with different bytes than the manifest names. */
  corrupt: false,
  /** The release the held run waits for, so a case can observe "not ready yet". */
  release: (): void => undefined,
  beforeQuit: [] as (() => void)[],
  dialogs: [] as unknown[],
  quitAndInstalls: 0,
  /** The manifest the check reports. */
  info: {} as Record<string, unknown>,
}))

vi.mock('electron-updater', () => {
  /** The library class, with the two calls the module makes. */
  class FakeUpdater {
    isUpdateCandidate?: (info: unknown) => boolean | Promise<boolean>
    private readonly listeners = new Map<string, ((payload: unknown) => void)[]>()

    on(event: string, listener: (payload: unknown) => void): this {
      this.listeners.set(event, [...this.listeners.get(event) ?? [], listener])
      return this
    }

    emit(event: string, payload: unknown): void {
      for (const listener of this.listeners.get(event) ?? []) listener(payload)
    }

    async checkForUpdates(): Promise<unknown> {
      return { isUpdateAvailable: await this.isUpdateCandidate?.(fixture.info) ?? false, updateInfo: fixture.info }
    }

    async downloadUpdate(): Promise<void> {
      fixture.runs += 1
      const staged = join(fixture.home, 'Library', 'Caches', 'DSH Desktop', 'pending', FILE_NAME)
      fixture.stagedWhenRun.push(existsSync(staged))
      // The library's own attempts: a connection that always drops, which is
      // what spends the retry plan and hands the transfer to the shell.
      if (fixture.runs <= 4) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
      // The run the shell hands the staged file back to: the library reads the
      // cache and raises its own event once it is ready.
      await new Promise<void>((resolve) => { fixture.release = resolve })
      this.emit('update-downloaded', { ...fixture.info, downloadedFile: staged })
    }

    quitAndInstall(): void {
      fixture.quitAndInstalls += 1
    }
  }
  return { MacUpdater: FakeUpdater, NsisUpdater: FakeUpdater }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: (): string => fixture.home }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: (): string => CURRENT,
    getName: (): string => 'DSH Desktop',
    getAppPath: (): string => fixture.appPath,
    getPath: (name: string): string => name === 'exe'
      ? join(fixture.home, 'DSH Desktop.app', 'Contents', 'MacOS', 'DSH Desktop')
      : join(fixture.home, name),
    getLocale: (): string => 'zh-CN',
    once: (event: string, listener: () => void): void => {
      if (event === 'before-quit') fixture.beforeQuit.push(listener)
    },
    quit: (): void => undefined,
    dock: undefined,
  },
  BrowserWindow: { getAllWindows: (): unknown[] => [], getFocusedWindow: (): unknown => null },
  dialog: {
    showMessageBox: async (options: unknown): Promise<{ response: number }> => {
      fixture.dialogs.push(options)
      return { response: 0 }
    },
  },
  Menu: { setApplicationMenu: (): void => undefined, buildFromTemplate: (template: unknown): unknown => template },
  nativeTheme: { shouldUseDarkColors: false },
  shell: { openExternal: async (): Promise<void> => undefined },
}))

/** The identity the running build declares. */
function runningIdentity(): ReleaseIdentity {
  return {
    version: CURRENT,
    dshRelease: {
      schemaVersion: 2, runtimeVersion: CURRENT, buildSequence: CURRENT_BUILD, revision: 'a'.repeat(40), kind: 'standard',
    },
  }
}

/** The manifest the check reports for the offered build. */
function manifest(): Record<string, unknown> {
  return {
    version: NEXT,
    dshRelease: {
      schemaVersion: 2, runtimeVersion: NEXT, buildSequence: NEXT_BUILD, revision: 'b'.repeat(40), kind: 'standard',
    },
    files: [{ url: FILE_NAME, sha512: SHA512, size: BYTES.length }],
    path: FILE_NAME,
    releaseNotes: 'fixes the thing',
  }
}

/** The platform this process reports outside these cases. */
const realPlatform = process.platform

/** The feed this process names outside these cases. */
const realFeed = process.env.DSH_UPDATE_FEED

/** The local artifact server. */
let server: Server

beforeAll(async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    fixture.requests.push(path)
    const body = fixture.corrupt ? Buffer.from('not the artifact the manifest names') : BYTES
    response.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(body.length) })
    response.end(body)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  process.env.DSH_UPDATE_FEED = `http://127.0.0.1:${String(port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  if (realFeed === undefined) delete process.env.DSH_UPDATE_FEED
  else process.env.DSH_UPDATE_FEED = realFeed
})

beforeEach(() => {
  vi.resetModules()
  fixture.home = mkdtempSync(join(tmpdir(), 'dsh-resume-'))
  mkdirSync(join(fixture.home, 'userData'))
  // The library's own download would have created the cache directory before
  // the shell's resumable transfer takes over.
  mkdirSync(join(fixture.home, 'Library', 'Caches', 'DSH Desktop'), { recursive: true })
  const signature = join(fixture.home, 'DSH Desktop.app', 'Contents', '_CodeSignature')
  mkdirSync(signature, { recursive: true })
  writeFileSync(join(signature, 'CodeResources'), '<plist/>\n')
  fixture.appPath = join(fixture.home, 'app')
  mkdirSync(fixture.appPath, { recursive: true })
  writeFileSync(join(fixture.appPath, 'package.json'), JSON.stringify(runningIdentity()))
  fixture.requests.length = 0
  fixture.runs = 0
  fixture.stagedWhenRun.length = 0
  fixture.corrupt = false
  fixture.dialogs.length = 0
  fixture.quitAndInstalls = 0
  fixture.info = manifest()
})

afterEach(() => {
  for (const listener of fixture.beforeQuit.splice(0)) listener()
  vi.useRealTimers()
  rmSync(fixture.home, { recursive: true, force: true })
})

/**
 * A log sink a case can wait on.
 * @returns the host and a waiter for one line.
 */
function sink(): { host: UpdateHost; lines: string[]; waitFor: (fragment: string) => Promise<void> } {
  const lines: string[] = []
  const waiting: { fragment: string; resolve: () => void }[] = []
  const host: UpdateHost = {
    log: (line) => {
      lines.push(line)
      for (let index = waiting.length - 1; index >= 0; index--) {
        const waiter = waiting[index]
        if (waiter !== undefined && line.includes(waiter.fragment)) {
          waiting.splice(index, 1)
          waiter.resolve()
        }
      }
    },
    openLog: (): void => undefined,
    prepareQuit: async () => undefined,
    resumeAfterFailedInstall: async () => undefined,
  }
  const waitFor = async (fragment: string): Promise<void> => {
    if (lines.some(line => line.includes(fragment))) return
    await new Promise<void>((resolve) => { waiting.push({ fragment, resolve }) })
  }
  return { host, lines, waitFor }
}

describe('a transfer the library gave up on', () => {
  it('stages the frozen artifact, hands it back to the library, and waits for the library’s event (U12)', async () => {
    const { host, waitFor } = sink()
    const { updateActions } = await import('../src/updater.ts')
    const actions = updateActions(host)

    // Only the retry waits are faked; the transfer itself runs on real I/O.
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    actions.check()
    await vi.advanceTimersByTimeAsync(30_000)
    await waitFor('handing it back to electron-updater')
    vi.useRealTimers()
    // The library is asked again once the staged file is in place.
    await vi.waitFor(() => { expect(fixture.runs).toBe(5) })

    // Four attempts of the library's own, then the shell's transfer, then the
    // same library call again — which is what validates the cache.
    expect(fixture.runs).toBe(5)
    expect(fixture.stagedWhenRun).toEqual([false, false, false, false, true])
    expect(fixture.requests).toEqual([`/v2/mac/${FILE_NAME}`])
    // The artifact is staged, not installed: nothing asked a user anything.
    expect(actions.state()).toMatchObject({ phase: 'downloading', latestVersion: NEXT, latestBuild: NEXT_BUILD })
    expect(fixture.quitAndInstalls).toBe(0)
    expect(fixture.dialogs).toEqual([])

    // Only the library's own `update-downloaded` makes it installable.
    fixture.release()
    await waitFor(`downloaded ${NEXT} · 构建 ${NEXT_BUILD}; waiting for an explicit install`)
    expect(actions.state().phase).toBe('ready')
    expect(fixture.quitAndInstalls).toBe(0)
  })

  it('does not stage bytes the manifest’s digest refuses, and never reports them ready (U13)', async () => {
    fixture.corrupt = true
    const { host, waitFor } = sink()
    const { updateActions } = await import('../src/updater.ts')
    const actions = updateActions(host)

    vi.useFakeTimers({ toFake: ['setTimeout'] })
    actions.check()
    await vi.advanceTimersByTimeAsync(30_000)
    await waitFor('resume did not finish')
    vi.useRealTimers()

    // The resumed transfer was refused by the frozen artifact's digest, so the
    // library was never asked again and nothing became installable.
    expect(fixture.runs).toBe(4)
    expect(existsSync(join(fixture.home, 'Library', 'Caches', 'DSH Desktop', 'pending', FILE_NAME))).toBe(false)
    await vi.waitFor(() => { expect(actions.state().phase).toBe('failed') })
    expect(actions.state().latestVersion).toBe(NEXT)
    expect(fixture.quitAndInstalls).toBe(0)
  })
})
