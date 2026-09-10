/**
 * Which tier a macOS check ends on, and what the channel reports when the
 * in-place one could not be reached. `updater.ts` drives electron and
 * electron-updater; both stand in here, while the app bundle the signature
 * probe reads and the manifest the download-page tier fetches are real.
 * @module
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateHost } from '../src/updater.ts'

/** The running build every case reports as installed. */
const CURRENT = '0.1.0-rc.32'

/** The version the feed offers in every case that has one. */
const NEXT = '0.1.0-rc.33'

/** What the transfer this feed offers is called. */
const ARTIFACT = 'DSH Desktop-0.1.0-rc.33-arm64-mac.zip'

/** The line [[checkGeneric]] ends a silent check on once it has found a version. */
const FOUND_LINE = `${NEXT} is available; not interrupting the session`

/**
 * What the electron and electron-updater stand-ins read and record. Hoisted
 * because both mock factories run before this file's own initializers.
 */
const shell = vi.hoisted(() => ({
  /** What `app.getPath('exe')` answers; the bundle the signature probe reads sits two levels above it. */
  exePath: '',
  /** What `app.isPackaged` answers. */
  packaged: true,
  /** Every dialog the run put up, in order. */
  dialogs: [] as { message?: unknown; title?: unknown }[],
  /** Every updater the run built, so a case can raise the library's own events. */
  instances: [] as { emit: (event: string, payload: unknown) => void }[],
  /** What one `checkForUpdates()` answers. */
  checkForUpdates: async (): Promise<unknown> => null,
  /** What one `downloadUpdate()` answers. */
  downloadUpdate: async (): Promise<void> => undefined,
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged(): boolean { return shell.packaged },
    getVersion: (): string => CURRENT,
    getName: (): string => 'DSH Desktop',
    getPath: (): string => shell.exePath,
    getLocale: (): string => 'zh-CN',
    once: (): void => undefined,
    quit: (): void => undefined,
    dock: undefined,
  },
  BrowserWindow: {
    getAllWindows: (): unknown[] => [],
    getFocusedWindow: (): unknown => null,
  },
  dialog: {
    showMessageBox: async (options: { message?: unknown; title?: unknown }): Promise<{ response: number }> => {
      shell.dialogs.push(options)
      return { response: 0 }
    },
  },
  Menu: {
    setApplicationMenu: (): void => undefined,
    buildFromTemplate: (template: unknown): unknown => template,
  },
  nativeTheme: { shouldUseDarkColors: false },
  shell: { openExternal: async (): Promise<void> => undefined },
}))

vi.mock('electron-updater', () => {
  /** Both platform classes: the module drives them through one set of members. */
  class FakeUpdater {
    autoDownload = true
    autoInstallOnAppQuit = true
    logger: unknown = undefined
    private readonly listeners = new Map<string, ((payload: unknown) => void)[]>()

    constructor() {
      shell.instances.push(this)
    }

    on(event: string, listener: (payload: unknown) => void): this {
      this.listeners.set(event, [...this.listeners.get(event) ?? [], listener])
      return this
    }

    emit(event: string, payload: unknown): void {
      for (const listener of this.listeners.get(event) ?? []) listener(payload)
    }

    async checkForUpdates(): Promise<unknown> {
      return shell.checkForUpdates()
    }

    async downloadUpdate(): Promise<void> {
      await shell.downloadUpdate()
    }

    quitAndInstall(): void {
      // Nothing replaces the application in a unit process.
    }
  }
  return { MacUpdater: FakeUpdater, NsisUpdater: FakeUpdater }
})

/** The manifest the download-page tier reads, as `publish-update.ts` writes it. */
const MAC_FEED = [
  `version: ${NEXT}`,
  'files:',
  `  - url: ${ARTIFACT}`,
  '    sha512: TCBQnUqRgUNvpaLKDIw2gRPmMK4ArWs3HcAiWkuBOAo=',
  `path: ${ARTIFACT}`,
  "releaseDate: '2026-09-11T00:00:00.000Z'",
  'releaseNotes: fixes the thing',
  '',
].join('\n')

/** Directories one case created, removed by the shared teardown. */
const directories: string[] = []

/** The platform this process reports outside these cases. */
const realPlatform = process.platform

beforeAll(() => {
  // The whole tier ladder is a macOS one, and this file's own fork reports
  // whatever host it runs on.
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  // A feed nothing can reach, so a request that escaped the stub fails at once
  // rather than reaching the published one.
  process.env.DSH_UPDATE_FEED = 'http://127.0.0.1:1/dsh-updates'
})

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
})

beforeEach(() => {
  vi.resetModules()
  shell.packaged = true
  shell.dialogs.length = 0
  shell.instances.length = 0
  shell.checkForUpdates = async (): Promise<unknown> => null
  shell.downloadUpdate = async (): Promise<void> => undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * Build an app bundle for one case and point the stand-in `app` at it.
 * @param signed - whether to seal it the way a certificate does, which is what
 * [[macAppIsSigned]] probes for.
 */
function bundle(signed: boolean): void {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bundle-'))
  directories.push(root)
  const contents = join(root, 'DSH Desktop.app', 'Contents')
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  if (signed) {
    mkdirSync(join(contents, '_CodeSignature'), { recursive: true })
    writeFileSync(join(contents, '_CodeSignature', 'CodeResources'), '<plist/>\n')
  }
  shell.exePath = join(contents, 'MacOS', 'DSH Desktop')
}

/** A log sink that a case can wait on, so nothing polls for a check to finish. */
interface Sink {
  /** The host the updater writes through. */
  host: UpdateHost
  /** Every line it has written. */
  lines: string[]
  /**
   * Settle once a line containing `fragment` has been written.
   * @param fragment - what to wait for.
   * @returns when that line has been written, past or future.
   */
  waitFor: (fragment: string) => Promise<void>
}

/**
 * A log sink for one case.
 * @returns the host, its lines, and the wait.
 */
function sink(): Sink {
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
    openLog: () => undefined,
    prepareQuit: async () => undefined,
  }
  const waitFor = async (fragment: string): Promise<void> => {
    if (lines.some(line => line.includes(fragment))) return
    await new Promise<void>((resolve) => { waiting.push({ fragment, resolve }) })
  }
  return { host, lines, waitFor }
}

/** Serve [[MAC_FEED]] to every manifest read this case makes. */
function serveFeed(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(MAC_FEED, { status: 200 }))
}

/** One transient failure, of the kind a dropped connection raises. */
function interrupted(): Error {
  return Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
}

describe('a signed build whose in-place check could not get through', () => {
  it('reports a failure the next check starts over from, not one that ends the run', async () => {
    bundle(true)
    serveFeed()
    shell.checkForUpdates = async (): Promise<unknown> => { throw interrupted() }
    const { host, waitFor } = sink()
    const { updateActions } = await import('../src/updater.ts')
    const actions = updateActions(host)

    actions.check()
    await waitFor(FOUND_LINE)

    const snapshot = actions.state()
    expect(snapshot.phase).toBe('failed')
    expect(snapshot.reason).toBe('ECONNRESET')
    // The build can still replace itself, so nothing may claim otherwise.
    expect(snapshot.reason).not.toBe('this build installs an update by replacing it by hand')
    expect(snapshot.latestVersion).toBe(NEXT)

    // The tier survived, so the transfer this run still runs reaches `ready`.
    shell.instances[0]?.emit('update-downloaded', { version: NEXT, releaseNotes: 'fixes the thing' })
    expect(actions.state().phase).toBe('ready')
  }, 20_000)

  it('asks the feed three times before it falls back', async () => {
    bundle(true)
    serveFeed()
    let attempts = 0
    shell.checkForUpdates = async (): Promise<unknown> => { attempts++; throw interrupted() }
    const { host, waitFor } = sink()
    const { updateActions } = await import('../src/updater.ts')

    updateActions(host).check()
    await waitFor(FOUND_LINE)
    expect(attempts).toBe(3)
  }, 20_000)
})

describe('a build that cannot install where it stands', () => {
  it('reports the one failure nothing this run moves', async () => {
    bundle(false)
    serveFeed()
    const { host, waitFor } = sink()
    const { updateActions } = await import('../src/updater.ts')
    const actions = updateActions(host)

    actions.check()
    await waitFor(FOUND_LINE)

    expect(actions.state()).toMatchObject({
      phase: 'failed',
      reason: 'this build installs an update by replacing it by hand',
      latestVersion: NEXT,
    })
    // electron-updater is never built on this tier, so nothing can report a
    // download; the verdict stands for the rest of the run either way.
    expect(shell.instances).toHaveLength(0)
  })
})
