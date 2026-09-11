/**
 * Which tier a macOS check ends on, and what the channel reports when the
 * in-place one could not be reached. `updater.ts` drives electron and
 * electron-updater; both stand in here, while the app bundle the signature
 * probe reads and the manifest the download-page tier fetches are real.
 *
 * The electron-updater stand-in covers every member `updater.ts` uses and
 * differs from the library in two ways that nothing here depends on. Its
 * `update-downloaded` payload carries only `version` and `releaseNotes`, where
 * the library sends `UpdateInfo & { downloadedFile: string }`. Its
 * `checkForUpdates()` only rejects, where the library also raises `error`, so
 * the demotion the `error` listener performs is reached here through the
 * caller's own catch instead.
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

/** The line [[checkGeneric]] writes when it is answering for an in-place tier the failure did not cost. */
const FALLBACK_LINE = `${NEXT} was read straight from the feed; the in-place check did not get through`

/** The line a silent fallback answer ends on when the feed's red line is above the running build. */
const MANDATORY_FALLBACK_LINE = `mandatory ${NEXT}: the in-place check did not get through`

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
  dialogs: [] as { message?: unknown; title?: unknown; detail?: unknown }[],
  /** Every URL the run handed to the system browser, in order. */
  opened: [] as string[],
  /** Called after each dialog is recorded, so a case can wait for one. */
  onDialog: undefined as (() => void) | undefined,
  /** What the app registered for `before-quit`, which is what stops its timers. */
  beforeQuit: [] as (() => void)[],
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
    once: (event: string, listener: () => void): void => {
      if (event === 'before-quit') shell.beforeQuit.push(listener)
    },
    quit: (): void => undefined,
    dock: undefined,
  },
  BrowserWindow: {
    getAllWindows: (): unknown[] => [],
    getFocusedWindow: (): unknown => null,
  },
  dialog: {
    showMessageBox: async (options: { message?: unknown; title?: unknown; detail?: unknown }): Promise<{ response: number }> => {
      shell.dialogs.push(options)
      shell.onDialog?.()
      return { response: 0 }
    },
  },
  Menu: {
    setApplicationMenu: (): void => undefined,
    buildFromTemplate: (template: unknown): unknown => template,
  },
  nativeTheme: { shouldUseDarkColors: false },
  shell: {
    openExternal: async (url: string): Promise<void> => {
      shell.opened.push(url)
    },
  },
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

/** The same manifest with the publisher's red line above the running build. */
const MANDATORY_FEED = MAC_FEED.replace(`version: ${NEXT}\n`, `version: ${NEXT}\nminimumVersion: ${NEXT}\n`)

/** Directories one case created, removed by the shared teardown. */
const directories: string[] = []

/** The platform this process reports outside these cases. */
const realPlatform = process.platform

/** The feed this process names outside these cases, restored with the platform. */
const realFeed = process.env.DSH_UPDATE_FEED

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
  if (realFeed === undefined) delete process.env.DSH_UPDATE_FEED
  else process.env.DSH_UPDATE_FEED = realFeed
})

beforeEach(() => {
  vi.resetModules()
  shell.packaged = true
  shell.dialogs.length = 0
  shell.opened.length = 0
  shell.onDialog = undefined
  shell.beforeQuit.length = 0
  shell.instances.length = 0
  shell.checkForUpdates = async (): Promise<unknown> => null
  shell.downloadUpdate = async (): Promise<void> => undefined
})

afterEach(() => {
  // The recurring silent check and the delayed first one outlive their case
  // otherwise, and this worker's event loop with them.
  for (const listener of shell.beforeQuit.splice(0)) listener()
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

/**
 * Serve one manifest to every read this case makes.
 * @param body - the manifest to answer with; [[MAC_FEED]] by default.
 */
function serveFeed(body: string = MAC_FEED): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body, { status: 200 }))
}

/**
 * Settle once the next dialog has been put up.
 * @returns when one has.
 */
async function nextDialog(): Promise<void> {
  await new Promise<void>((resolve) => { shell.onDialog = resolve })
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

    vi.useFakeTimers()
    try {
      actions.check()
      await vi.advanceTimersByTimeAsync(10_000)
      await waitFor(FALLBACK_LINE)
    } finally {
      vi.useRealTimers()
    }

    const snapshot = actions.state()
    expect(snapshot.phase).toBe('failed')
    expect(snapshot.reason).toBe('ECONNRESET')
    // The build can still replace itself, so nothing may claim otherwise.
    expect(snapshot.reason).not.toBe('this build installs an update by replacing it by hand')
    expect(snapshot.latestVersion).toBe(NEXT)

    // The tier survived, so the transfer this run still runs reaches `ready`.
    shell.instances[0]?.emit('update-downloaded', { version: NEXT, releaseNotes: 'fixes the thing' })
    expect(actions.state().phase).toBe('ready')
  })

  it('keeps the tier when the check was abandoned by a timeout of its own', async () => {
    bundle(true)
    serveFeed()
    // The shape `AbortSignal.timeout()` rejects with — a `DOMException` whose
    // `code` is the numeric 23 and whose message is prose about an operation —
    // raised from the one failure this file can drive. A classifier reading
    // codes and messages alone called it fatal, which costs the in-place tier
    // for the rest of the run.
    shell.checkForUpdates = async (): Promise<unknown> => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }
    const { host, waitFor } = sink()
    const { updateActions } = await import('../src/updater.ts')
    const actions = updateActions(host)

    vi.useFakeTimers()
    try {
      actions.check()
      await vi.advanceTimersByTimeAsync(10_000)
      await waitFor(FALLBACK_LINE)
    } finally {
      vi.useRealTimers()
    }

    const snapshot = actions.state()
    expect(snapshot.phase).toBe('failed')
    expect(snapshot.reason).toBe('TimeoutError')
    expect(snapshot.reason).not.toMatch(/^in-place update unavailable:/)
    // The tier survived, so the transfer this run still runs reaches `ready`.
    shell.instances[0]?.emit('update-downloaded', { version: NEXT, releaseNotes: 'fixes the thing' })
    expect(actions.state().phase).toBe('ready')
  })

  it('demotes the tier for the run when the failure was fatal', async () => {
    bundle(true)
    serveFeed()
    shell.checkForUpdates = async (): Promise<unknown> => {
      throw Object.assign(
        new Error(`New version ${NEXT} is not signed by the application owner`),
        { code: 'ERR_UPDATER_INVALID_SIGNATURE' },
      )
    }
    const { host, waitFor } = sink()
    const { updateActions } = await import('../src/updater.ts')
    const actions = updateActions(host)

    vi.useFakeTimers()
    try {
      actions.check()
      await vi.advanceTimersByTimeAsync(10_000)
      await waitFor(FOUND_LINE)
    } finally {
      vi.useRealTimers()
    }

    // A refused signature is not the next check's problem: this run cannot
    // install where it stands any more, and says so.
    expect(actions.state().reason).toMatch(/^in-place update unavailable:/)
    // The verdict is final, so the transfer already in flight cannot report
    // itself into a state offering an install that cannot happen.
    shell.instances[0]?.emit('update-downloaded', { version: NEXT, releaseNotes: 'fixes the thing' })
    expect(actions.state().phase).toBe('failed')
  })

  it('answers a click with the failure rather than the manual replacement it does not need', async () => {
    bundle(true)
    serveFeed()
    shell.checkForUpdates = async (): Promise<unknown> => { throw interrupted() }
    const { host, lines } = sink()
    const { setupUpdates, updateActions } = await import('../src/updater.ts')
    const actions = updateActions(host)

    vi.useFakeTimers()
    try {
      const manual = setupUpdates(host)
      const shown = nextDialog()
      manual()
      await vi.advanceTimersByTimeAsync(10_000)
      await shown
    } finally {
      vi.useRealTimers()
    }

    // The click is answered with what the check met, and the detail is the
    // fallback tier's own rather than the one the outer catch writes.
    expect(shell.dialogs).toHaveLength(1)
    expect(shell.dialogs.at(-1)).toMatchObject({
      message: '无法检查更新',
      detail: 'ECONNRESET\n\n稍后会自动重试,新版本已记录在设置里。',
    })
    // This build can still replace itself, so nothing offers the download page
    // or the by-hand instructions that go with it.
    expect(shell.opened).toEqual([])
    expect(lines.filter(line => line.includes('opening'))).toEqual([])
    expect(actions.state().phase).toBe('failed')
  })

  it('says nothing on a silent check the feed made mandatory', async () => {
    bundle(true)
    serveFeed(MANDATORY_FEED)
    shell.checkForUpdates = async (): Promise<unknown> => { throw interrupted() }
    const { host, lines, waitFor } = sink()
    const { updateActions } = await import('../src/updater.ts')
    const actions = updateActions(host)

    vi.useFakeTimers()
    try {
      actions.check()
      await vi.advanceTimersByTimeAsync(10_000)
      await waitFor(MANDATORY_FALLBACK_LINE)
    } finally {
      vi.useRealTimers()
    }

    // The red line is enforced by the launch gate and by the next in-place
    // check, neither of which needs this run to interrupt anyone.
    expect(shell.dialogs).toEqual([])
    expect(shell.opened).toEqual([])
    expect(lines.filter(line => line.includes('opening'))).toEqual([])
    expect(actions.state().phase).toBe('failed')
  })

  it('asks the feed three times before it falls back', async () => {
    bundle(true)
    serveFeed()
    let attempts = 0
    shell.checkForUpdates = async (): Promise<unknown> => { attempts++; throw interrupted() }
    const { host, waitFor } = sink()
    const { updateActions } = await import('../src/updater.ts')

    vi.useFakeTimers()
    try {
      updateActions(host).check()
      await vi.advanceTimersByTimeAsync(10_000)
      await waitFor(FALLBACK_LINE)
    } finally {
      vi.useRealTimers()
    }
    expect(attempts).toBe(3)
  })
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

describe('a manual check with the update already under way', () => {
  it('records the time and shows nothing while the transfer runs', async () => {
    bundle(true)
    shell.checkForUpdates = async (): Promise<unknown> => ({ updateInfo: { version: NEXT, releaseNotes: 'fixes the thing' } })
    // A transfer that never ends, which is what the second check lands on.
    shell.downloadUpdate = async (): Promise<void> => new Promise<void>(() => undefined)
    const { host, waitFor } = sink()
    const { setupUpdates, updateActions } = await import('../src/updater.ts')
    const actions = updateActions(host)
    const manual = setupUpdates(host)

    actions.check()
    await waitFor(`downloading ${NEXT} in the background`)
    const before = actions.state().checkedAt
    // ISO 8601 records milliseconds, so the two checks must be told apart by one.
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })

    manual()
    await waitFor('check while a transfer is in flight')

    // The click is answered by the Settings row, which already carries the
    // transfer; a dialog on top of it would be a second thing to dismiss.
    expect(shell.dialogs).toHaveLength(0)
    const after = actions.state()
    expect(after.phase).toBe('downloading')
    expect(Date.parse(after.checkedAt ?? '')).toBeGreaterThan(Date.parse(before ?? ''))
  })

  it('records the time and shows nothing while the update waits to be installed', async () => {
    bundle(true)
    shell.checkForUpdates = async (): Promise<unknown> => ({ updateInfo: { version: NEXT } })
    shell.downloadUpdate = async (): Promise<void> => {
      shell.instances[0]?.emit('update-downloaded', { version: NEXT })
    }
    const { host, waitFor } = sink()
    const { setupUpdates, updateActions } = await import('../src/updater.ts')
    const actions = updateActions(host)
    const manual = setupUpdates(host)

    actions.check()
    await waitFor(`downloaded ${NEXT}; waiting for an explicit install`)
    const before = actions.state().checkedAt
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })

    manual()
    await waitFor(`check while ${NEXT} waits to be installed`)

    expect(shell.dialogs).toHaveLength(0)
    const after = actions.state()
    expect(after.phase).toBe('ready')
    expect(Date.parse(after.checkedAt ?? '')).toBeGreaterThan(Date.parse(before ?? ''))
  })

  it('says nothing on a check nobody clicked for', async () => {
    bundle(true)
    shell.checkForUpdates = async (): Promise<unknown> => ({ updateInfo: { version: NEXT } })
    shell.downloadUpdate = async (): Promise<void> => new Promise<void>(() => undefined)
    const { host, waitFor } = sink()
    const { updateActions } = await import('../src/updater.ts')
    const actions = updateActions(host)

    actions.check()
    await waitFor(`downloading ${NEXT} in the background`)
    actions.check()
    await waitFor('check while a transfer is in flight')

    expect(shell.dialogs).toHaveLength(0)
  })
})

describe('the holding line the launch gate writes', () => {
  it('carries the transfer completion while a mandatory update downloads', async () => {
    bundle(true)
    shell.checkForUpdates = async (): Promise<unknown> => ({
      updateInfo: { version: NEXT, minimumVersion: NEXT },
    })
    // The transfer never ends, so the gate's line is the only thing moving.
    shell.downloadUpdate = async (): Promise<void> => new Promise<void>(() => undefined)
    const { host } = sink()
    const { launchGate } = await import('../src/updater.ts')
    const shown: string[] = []

    expect(await launchGate(host, (message) => { shown.push(message) })).toBe(true)
    expect(shown).toEqual(['这是必须安装的更新,正在下载新版本…'])

    shell.instances[0]?.emit('download-progress', { percent: 42.7, transferred: 42_700, total: 100_000 })
    expect(shown.at(-1)).toBe('这是必须安装的更新,正在下载新版本… 42%')
    // One line, rewritten: no window and no taskbar progress came back with it.
    expect(shell.dialogs).toHaveLength(0)
  })
})
