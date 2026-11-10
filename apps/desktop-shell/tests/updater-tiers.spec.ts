/**
 * Which tier a macOS check ends on, and what the channel reports when the
 * in-place one could not be reached. `updater.ts` drives electron and
 * electron-updater; both stand in here, while the app bundle and its own
 * `package.json` — the build's release identity — and the v2 manifest the
 * download-page tier fetches are real files.
 *
 * The electron-updater stand-in covers every member `updater.ts` uses and
 * differs from the library in two ways that nothing here depends on. Its
 * `update-downloaded` payload carries only `version` and `dshRelease`, where
 * the library sends `UpdateInfo & { downloadedFile: string }`. Its
 * `checkForUpdates()` reports what the candidate callback accepted, where the
 * library also runs its system and rollout checks first; the ordering of those
 * checks is exercised against the real library in
 * `updater-candidate.spec.ts`.
 * @module
 */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { dump } from 'js-yaml'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReleaseIdentity } from '../src/release-identity.ts'
import type { UpdateHost } from '../src/updater.ts'

/** The running build every case reports as installed. */
const CURRENT = '0.1.0-rc.32'

/** The running build's sequence. */
const CURRENT_BUILD = 32

/** The version the feed offers in every case that has one. */
const NEXT = '0.1.0-rc.33'

/** The offered build's sequence. */
const NEXT_BUILD = 33

/** The running build's source commit. */
const REVISION = '0'.repeat(40)

/** The offered build's source commit. */
const NEXT_REVISION = '1'.repeat(40)

/** What the transfer this feed offers is called. */
const ARTIFACT = 'DSH Desktop-0.1.0-rc.33-arm64-mac.zip'

/** The artifact's bytes; the ready check reads them back from disk. */
const ARTIFACT_BYTES = Buffer.from('the update artifact these cases verify\n')

/** The base64 SHA-512 of [[ARTIFACT_BYTES]], as the manifest states it. */
const SHA512 = createHash('sha512').update(ARTIFACT_BYTES).digest('base64')

/** The artifact's length, as the manifest states it. */
const ARTIFACT_SIZE = ARTIFACT_BYTES.byteLength

/** The line [[checkGeneric]] ends a silent check on once it has found a build. */
const FOUND_LINE = `${NEXT} · 构建 ${NEXT_BUILD} is available; not interrupting the session`

/** The line [[checkGeneric]] writes when it is answering for an in-place tier the failure did not cost. */
const FALLBACK_LINE = `${NEXT} · 构建 ${NEXT_BUILD} was read straight from the feed; the in-place check did not get through`

/** The line a silent fallback answer ends on when the feed's red line is above the running build. */
const MANDATORY_FALLBACK_LINE = `mandatory ${NEXT} · 构建 ${NEXT_BUILD}: the in-place check did not get through`

/**
 * What the electron and electron-updater stand-ins read and record. Hoisted
 * because both mock factories run before this file's own initializers.
 */
const shell = vi.hoisted(() => ({
  /** What `app.getPath('exe')` answers; the bundle the signature probe reads sits two levels above it. */
  exePath: '',
  /** What `app.getAppPath()` answers; the build's `package.json` sits directly under it. */
  appPath: '',
  /** What `app.isPackaged` answers. */
  packaged: true,
  /** Every dialog the run put up, in order. */
  dialogs: [] as { message?: unknown; title?: unknown; detail?: unknown }[],
  /** Every URL the run handed to the system browser, in order. */
  opened: [] as string[],
  /** What `os.homedir()` answers, so no cache write reaches the real one. */
  home: '',
  /** Called after each dialog is recorded, so a case can wait for one. */
  onDialog: undefined as (() => void) | undefined,
  /** What the app registered for `before-quit`, which is what stops its timers. */
  beforeQuit: [] as (() => void)[],
  /** Every updater the run built, so a case can raise the library's own events. */
  instances: [] as FakeUpdater[],
  /** What one `checkForUpdates()` answers; the updater is passed so a case can consult its candidate callback. */
  checkForUpdates: async (_updater: FakeUpdater): Promise<unknown> => null,
  /** What one `downloadUpdate()` answers. */
  downloadUpdate: async (): Promise<void> => undefined,
}))

/** The members of the library class this module drives. */
interface FakeUpdater {
  /** The product's candidate callback, installed by `ensureUpdater` when the build declares an identity. */
  isUpdateCandidate?: (info: unknown) => boolean | Promise<boolean>
  /** Whether the library may accept a lower version; this product keeps it off. */
  allowDowngrade: boolean
  /** Whether the library transfers changed blocks only; a transfer with no proven pair leaves it off. */
  disableDifferentialDownload: boolean
  /** The pair one transfer may difference against, set only for that transfer. */
  differentialDownloadBase?: { oldFile: string; oldBlockMapFile: string }
  emit: (event: string, payload: unknown) => void
  checkForUpdates: () => Promise<unknown>
  downloadUpdate: () => Promise<void>
  quitAndInstall: () => void
}

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: (): string => shell.home }
})

vi.mock('electron', () => ({
  app: {
    get isPackaged(): boolean { return shell.packaged },
    getVersion: (): string => CURRENT,
    getName: (): string => 'DSH Desktop',
    getPath: (): string => shell.exePath,
    getAppPath: (): string => shell.appPath,
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
  class StandInUpdater implements FakeUpdater {
    autoDownload = true
    autoInstallOnAppQuit = true
    allowDowngrade = true
    disableDifferentialDownload = false
    differentialDownloadBase?: { oldFile: string; oldBlockMapFile: string }
    logger: unknown = undefined
    isUpdateCandidate?: (info: unknown) => boolean | Promise<boolean>
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
      return shell.checkForUpdates(this)
    }

    async downloadUpdate(): Promise<void> {
      await shell.downloadUpdate()
    }

    quitAndInstall(): void {
      // Nothing replaces the application in a unit process.
    }
  }
  return { MacUpdater: StandInUpdater, NsisUpdater: StandInUpdater }
})

/**
 * The identity one standard build declares.
 * @param version - its application version, which a standard build also reports as its runtime.
 * @param build - its build sequence.
 * @param revision - its source commit.
 * @returns the identity.
 */
function identity(version: string, build: number, revision: string): ReleaseIdentity {
  return {
    version,
    dshRelease: { schemaVersion: 2, runtimeVersion: version, buildSequence: build, revision, kind: 'standard' },
  }
}

/**
 * The manifest a v2 feed publishes.
 * @param minimumBuildSequence - the publisher's red line, when it sets one.
 * @param build - the build sequence it offers.
 * @returns the parsed document a manifest read yields.
 */
function manifest(minimumBuildSequence?: number, build = NEXT_BUILD): Record<string, unknown> {
  return {
    version: NEXT,
    dshRelease: identity(NEXT, build, NEXT_REVISION).dshRelease,
    files: [{ url: ARTIFACT, sha512: SHA512, size: ARTIFACT_SIZE }],
    path: ARTIFACT,
    releaseDate: '2026-09-11T00:00:00.000Z',
    releaseNotes: 'fixes the thing',
    ...minimumBuildSequence === undefined ? {} : { minimumBuildSequence },
  }
}

/** The manifest the download-page tier reads, as `publish-update.ts` writes it. */
const MAC_FEED = dump(manifest())

/** The same manifest with the publisher's red line above the running build. */
const MANDATORY_FEED = dump(manifest(NEXT_BUILD))

/**
 * The payload the library's own download raises once the artifact is cached and
 * verified, with the file its ready check reads: the bytes under the name the
 * feed publishes the artifact with.
 * @returns the event payload.
 */
function downloaded(): Record<string, unknown> {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-download-'))
  directories.push(directory)
  const file = join(directory, ARTIFACT)
  writeFileSync(file, ARTIFACT_BYTES)
  return { version: NEXT, dshRelease: identity(NEXT, NEXT_BUILD, NEXT_REVISION).dshRelease, downloadedFile: file }
}

/**
 * Answer one check the way the library would when its own system and rollout
 * checks passed: with what the candidate callback said.
 * @param updater - the instance the check runs on.
 * @param info - the manifest the check reports.
 * @returns the library's check result.
 */
async function candidateResult(updater: FakeUpdater, info: Record<string, unknown>): Promise<unknown> {
  return { isUpdateAvailable: await updater.isUpdateCandidate?.(info) ?? false, updateInfo: info }
}

/** Directories one case created, removed by the shared teardown. */
const directories: string[] = []

/** The platform this process reports outside these cases. */
const realPlatform = process.platform

/** The feed this process names outside these cases, restored with the platform. */
const realFeed = process.env.DSH_UPDATE_FEED

/** The temporary home every cache lookup resolves under. */
let homeDirectory = ''

beforeAll(() => {
  homeDirectory = mkdtempSync(join(tmpdir(), 'dsh-updater-home-'))
  shell.home = homeDirectory
  // The whole tier ladder is a macOS one, and this file's own fork reports
  // whatever host it runs on.
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  // The root address only: the module appends the protocol's own
  // `/v2/<platform>` path, so nothing here serves (or reaches) the old `/mac`
  // source the bridge build replaced.
  process.env.DSH_UPDATE_FEED = 'http://127.0.0.1:1/dsh-updates'
})

afterAll(() => {
  // The home outlives the per-case directories, which are removed after each.
  rmSync(homeDirectory, { recursive: true, force: true })
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
 * Build an app bundle and its embedded package manifest for one case, and point
 * the stand-in `app` at it.
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
  // The running build's own manifest, which is where the identity is read from.
  shell.appPath = join(contents, 'Resources', 'app')
  mkdirSync(shell.appPath, { recursive: true })
  writeFileSync(join(shell.appPath, 'package.json'), JSON.stringify(identity(CURRENT, CURRENT_BUILD, REVISION)))
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
    expect(snapshot.latestBuild).toBe(NEXT_BUILD)

    // The tier survived, so a later check can still accept the build and the
    // library's own download event is what makes it ready.
    shell.checkForUpdates = async (updater: FakeUpdater): Promise<unknown> => candidateResult(updater, manifest())
    shell.downloadUpdate = async (): Promise<void> => {
      shell.instances[0]?.emit('update-downloaded', downloaded())
    }
    actions.check()
    await waitFor(`downloaded ${NEXT} · 构建 ${NEXT_BUILD}; waiting for an explicit install`)
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

    shell.checkForUpdates = async (updater: FakeUpdater): Promise<unknown> => candidateResult(updater, manifest())
    shell.downloadUpdate = async (): Promise<void> => {
      shell.instances[0]?.emit('update-downloaded', downloaded())
    }
    actions.check()
    await waitFor(`downloaded ${NEXT} · 构建 ${NEXT_BUILD}; waiting for an explicit install`)
    expect(actions.state().phase).toBe('ready')
  })

  it('names the status a refused manifest carried, which its own message does not', async () => {
    bundle(true)
    // The download-page tier reads the manifest itself, and a refusal it met
    // used to carry no identification at all: the message is this repository's
    // own Chinese prose, which no pattern in `download-retry.ts` matches, so
    // every refused manifest was one unnamed failure that the fail-closed
    // default called fatal.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (
      new Response('', { status: 503, statusText: 'Service Unavailable' })
    ))
    shell.checkForUpdates = async (): Promise<unknown> => { throw interrupted() }
    const { host, lines, waitFor } = sink()
    const { updateActions } = await import('../src/updater.ts')
    const { classifyDownloadError } = await import('../src/download-retry.ts')
    const actions = updateActions(host)

    vi.useFakeTimers()
    try {
      actions.check()
      await vi.advanceTimersByTimeAsync(10_000)
      await waitFor('check failed:')
    } finally {
      vi.useRealTimers()
    }

    const snapshot = actions.state()
    expect(snapshot.phase).toBe('failed')
    expect(snapshot.reason).toBe('HTTP_ERROR_503')
    // The status is in the code alone; the message is still the prose a person
    // reads, which is why the code had to carry it.
    expect(lines.some(line => line.includes('check failed: 更新源返回 503 Service Unavailable'))).toBe(true)
    // What that code buys the next caller to classify one: a feed that failed
    // is worth another attempt, where an unnamed failure was not.
    expect(classifyDownloadError(Object.assign(new Error(''), { code: snapshot.reason }))).toBe('transient')
    // Nothing about a feed that failed says this build cannot replace itself.
    expect(snapshot.reason).not.toMatch(/^in-place update unavailable:/)
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
      // A fatal failure still answers as the check that did not get through.
      await waitFor(FALLBACK_LINE)
    } finally {
      vi.useRealTimers()
    }

    // A refused signature is not the next check's problem: this run cannot
    // install where it stands any more, and says so.
    expect(actions.state().reason).toMatch(/^in-place update unavailable:/)
    // The verdict is final, so a transfer that arrives later cannot report
    // itself into a state offering an install that cannot happen.
    shell.instances[0]?.emit('update-downloaded', downloaded())
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
      detail: 'socket hang up\n错误码:ECONNRESET\n\n稍后会自动重试,新版本已记录在设置里。',
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

  it('installs the candidate callback on the library and lets its answer decide the check', async () => {
    bundle(true)
    let downloads = 0
    shell.checkForUpdates = async (updater: FakeUpdater): Promise<unknown> => candidateResult(updater, manifest())
    shell.downloadUpdate = async (): Promise<void> => { downloads += 1 }
    const { host, waitFor } = sink()
    const { updateActions } = await import('../src/updater.ts')
    const actions = updateActions(host)

    actions.check()
    await waitFor(`downloading ${NEXT} · 构建 ${NEXT_BUILD} in the background`)

    const instance = shell.instances[0]
    expect(typeof instance?.isUpdateCandidate).toBe('function')
    // A manifest that names the running build is not a candidate — the answer
    // the library would report as "no update" even though the versions are
    // equal and the build sequence matches.
    const running = {
      version: CURRENT,
      dshRelease: identity(CURRENT, CURRENT_BUILD, REVISION).dshRelease,
      files: [{ url: ARTIFACT, sha512: SHA512, size: ARTIFACT_SIZE }],
    }
    expect(await instance?.isUpdateCandidate?.(running)).toBe(false)
    expect(downloads).toBe(1)
    // The library's default comparison is replaced, and a downgrade is never
    // left available as a fallback.
    expect(instance?.allowDowngrade).toBe(false)
    // No artifact pair was proven for this transfer, so the library's own
    // version-substituted derivation stays refused.
    expect(instance?.disableDifferentialDownload).toBe(true)
  })

  it('differences the transfer only against the artifact kept for the running build', async () => {
    bundle(true)
    const running = identity(CURRENT, CURRENT_BUILD, REVISION)
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const zipName = `DSH Desktop-${CURRENT}-${arch}-mac.zip`
    const zipBytes = Buffer.from('the artifact this machine installed\n')
    let seen: { disable: boolean; base?: { oldFile: string; oldBlockMapFile: string } | undefined } | undefined
    shell.checkForUpdates = async (updater: FakeUpdater): Promise<unknown> => candidateResult(updater, manifest())
    shell.downloadUpdate = async (): Promise<void> => {
      const instance = shell.instances.at(-1)
      seen = { disable: instance?.disableDifferentialDownload ?? true, base: instance?.differentialDownloadBase }
    }
    const { updateActions, updaterCacheDir } = await import('../src/updater.ts')
    const { differentialCacheDir, saveDifferentialBaseline } = await import('../src/differential-cache.ts')
    const cacheDir = updaterCacheDir()
    const source = join(directories[directories.length - 1] ?? tmpdir(), 'installed.zip')
    writeFileSync(source, zipBytes)
    await saveDifferentialBaseline({
      cacheDir,
      platform: 'darwin',
      arch,
      identity: running,
      artifact: { fileName: zipName, sha512: createHash('sha512').update(zipBytes).digest('base64'), size: zipBytes.byteLength },
      sourceFile: source,
    })
    // A blockmap already kept: this case must not reach the network for one.
    const record = JSON.parse(readFileSync(join(differentialCacheDir(cacheDir), 'baseline.json'), 'utf8')) as Record<string, unknown>
    const blockmap = gzipSync(JSON.stringify({ version: '2', files: [] }))
    const blockmapPath = join(differentialCacheDir(cacheDir), `${record.key as string}.blockmap`)
    writeFileSync(blockmapPath, blockmap)
    writeFileSync(join(differentialCacheDir(cacheDir), 'baseline.json'), JSON.stringify({
      ...record,
      blockmap: { sha512: createHash('sha512').update(blockmap).digest('base64'), size: blockmap.byteLength },
    }))
    const { host, waitFor } = sink()

    updateActions(host).check()
    await waitFor(`downloading ${NEXT} · 构建 ${NEXT_BUILD} in the background`)
    // The log line is written before the transfer starts, so the pair is read
    // where the library would read it instead of at that line.
    await vi.waitFor(() => { expect(seen).toBeDefined() })
    await vi.waitFor(() => { expect(shell.instances.at(-1)?.disableDifferentialDownload).toBe(true) })

    expect(seen).toEqual({
      disable: false,
      base: { oldFile: join(differentialCacheDir(cacheDir), `${record.key as string}.artifact`), oldBlockMapFile: blockmapPath },
    })
    // The pair belongs to that one transfer: the next one starts from the
    // library's refused default again.
    expect(shell.instances.at(-1)?.differentialDownloadBase).toBeUndefined()
  })
})

describe('the candidate a transfer froze', () => {
  it('keeps the build it froze when the feed moves on, and only readies that build’s download (U11)', async () => {
    bundle(true)
    shell.checkForUpdates = async (updater: FakeUpdater): Promise<unknown> => candidateResult(updater, manifest())
    // The transfer never ends on its own; the events below stand in for the
    // library finishing it.
    shell.downloadUpdate = async (): Promise<void> => new Promise<void>(() => undefined)
    const { host, waitFor } = sink()
    const { updateActions } = await import('../src/updater.ts')
    const actions = updateActions(host)

    actions.check()
    await waitFor(`downloading ${NEXT} · 构建 ${NEXT_BUILD} in the background`)

    // The feed has published the next build, and a scheduled check runs while
    // the transfer is in flight: it records when it ran and changes nothing.
    shell.checkForUpdates = async (updater: FakeUpdater): Promise<unknown> => candidateResult(updater, manifest(undefined, NEXT_BUILD + 1))
    actions.check()
    await waitFor('check while a transfer is in flight')
    expect(actions.state()).toMatchObject({ phase: 'downloading', latestBuild: NEXT_BUILD })

    // A download event for another build is not made ready: the bytes the
    // install would take were never the ones this check accepted.
    shell.instances[0]?.emit('update-downloaded', {
      version: NEXT,
      dshRelease: identity(NEXT, NEXT_BUILD + 1, NEXT_REVISION).dshRelease,
    })
    // The transfer is reported as failed rather than ready: it ended on a build
    // this channel did not freeze, and the candidate it did freeze is kept.
    expect(actions.state()).toMatchObject({ phase: 'failed', latestVersion: NEXT, latestBuild: NEXT_BUILD })

    shell.instances[0]?.emit('update-downloaded', downloaded())
    await vi.waitFor(() => {
      expect(actions.state()).toMatchObject({ phase: 'ready', latestVersion: NEXT, latestBuild: NEXT_BUILD })
    })
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
      latestBuild: NEXT_BUILD,
    })
    // electron-updater is never built on this tier, so nothing can report a
    // download; the verdict stands for the rest of the run either way.
    expect(shell.instances).toHaveLength(0)
  })

  it('answers a click on a feed it could not reach with the message line and the code chain', async () => {
    bundle(false)
    // What Node's fetch raises for a host that does not resolve: a bare
    // TypeError whose cause alone carries the code.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND lhr.ink'), { code: 'ENOTFOUND' }),
      })
    })
    const { host } = sink()
    const { setupUpdates } = await import('../src/updater.ts')

    const shown = nextDialog()
    setupUpdates(host)()
    await shown

    expect(shell.dialogs).toEqual([expect.objectContaining({
      message: '无法检查更新',
      detail: 'fetch failed\n错误码:ENOTFOUND\n\n稍后再试,或到发布页手动下载新版本。',
    })])
  })

  it('shows no code line for a failure that carries no code', async () => {
    bundle(false)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('no route to the feed')
    })
    const { host } = sink()
    const { setupUpdates } = await import('../src/updater.ts')

    const shown = nextDialog()
    setupUpdates(host)()
    await shown

    expect(shell.dialogs.at(-1)?.detail).toBe(
      'no route to the feed\n\n稍后再试,或到发布页手动下载新版本。',
    )
  })

  it('shows the protocol code for a manifest that is not a v2 identity', async () => {
    bundle(false)
    serveFeed('version: 0.1.0-rc.33\nfiles: []\n')
    const { host } = sink()
    const { setupUpdates } = await import('../src/updater.ts')

    const shown = nextDialog()
    setupUpdates(host)()
    await shown

    // The refusal is a machine-readable code, not prose: this is the failure
    // the release protocol names RELEASE_IDENTITY_INVALID.
    expect(shell.dialogs.at(-1)?.message).toBe('无法检查更新')
    expect(String(shell.dialogs.at(-1)?.detail)).toContain('错误码:RELEASE_IDENTITY_INVALID')
  })
})

describe('a manual check with the update already under way', () => {
  it('records the time and shows nothing while the transfer runs', async () => {
    bundle(true)
    shell.checkForUpdates = async (updater: FakeUpdater): Promise<unknown> => candidateResult(updater, manifest())
    // A transfer that never ends, which is what the second check lands on.
    shell.downloadUpdate = async (): Promise<void> => new Promise<void>(() => undefined)
    const { host, waitFor } = sink()
    const { setupUpdates, updateActions } = await import('../src/updater.ts')
    const actions = updateActions(host)
    const manual = setupUpdates(host)

    actions.check()
    await waitFor(`downloading ${NEXT} · 构建 ${NEXT_BUILD} in the background`)
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
    shell.checkForUpdates = async (updater: FakeUpdater): Promise<unknown> => candidateResult(updater, manifest())
    shell.downloadUpdate = async (): Promise<void> => {
      shell.instances[0]?.emit('update-downloaded', downloaded())
    }
    const { host, waitFor } = sink()
    const { setupUpdates, updateActions } = await import('../src/updater.ts')
    const actions = updateActions(host)
    const manual = setupUpdates(host)

    actions.check()
    await waitFor(`downloaded ${NEXT} · 构建 ${NEXT_BUILD}; waiting for an explicit install`)
    const before = actions.state().checkedAt
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })

    manual()
    await waitFor(`check while ${NEXT} · 构建 ${NEXT_BUILD} waits to be installed`)

    expect(shell.dialogs).toHaveLength(0)
    const after = actions.state()
    expect(after.phase).toBe('ready')
    expect(Date.parse(after.checkedAt ?? '')).toBeGreaterThan(Date.parse(before ?? ''))
  })

  it('says nothing on a check nobody clicked for', async () => {
    bundle(true)
    shell.checkForUpdates = async (updater: FakeUpdater): Promise<unknown> => candidateResult(updater, manifest())
    shell.downloadUpdate = async (): Promise<void> => new Promise<void>(() => undefined)
    const { host, waitFor } = sink()
    const { updateActions } = await import('../src/updater.ts')
    const actions = updateActions(host)

    actions.check()
    await waitFor(`downloading ${NEXT} · 构建 ${NEXT_BUILD} in the background`)
    actions.check()
    await waitFor('check while a transfer is in flight')

    expect(shell.dialogs).toHaveLength(0)
  })
})

describe('the holding line the launch gate writes', () => {
  it('carries the transfer completion while a mandatory update downloads', async () => {
    bundle(true)
    shell.checkForUpdates = async (updater: FakeUpdater): Promise<unknown> => candidateResult(updater, manifest(NEXT_BUILD))
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

  it('blocks nothing on a library that refused the build for this machine', async () => {
    bundle(true)
    // The library's system check and rollout run before the candidate callback;
    // an answer of "not available" is this machine's answer, and the shell must
    // not read the raw feed to overrule it.
    shell.checkForUpdates = async (): Promise<unknown> => ({ isUpdateAvailable: false, updateInfo: manifest(NEXT_BUILD) })
    const { host } = sink()
    const { launchGate } = await import('../src/updater.ts')

    expect(await launchGate(host, () => undefined)).toBe(false)
    // No block, no download page, and no transfer: the raw feed was not read.
    expect(shell.dialogs).toEqual([])
    expect(shell.opened).toEqual([])
  })
})

describe('an in-place check that failed over a feed naming the installed build', () => {
  it('reports the failure instead of an already-current answer (R12)', async () => {
    bundle(true)
    // The v2 feed names the build that is running. The native check still
    // failed, so the answer is that failure — never 「已是最新版本」.
    serveFeed(dump({
      ...manifest(),
      version: CURRENT,
      dshRelease: identity(CURRENT, CURRENT_BUILD, REVISION).dshRelease,
    }))
    shell.checkForUpdates = async (): Promise<unknown> => { throw interrupted() }
    const { host, waitFor } = sink()
    const { setupUpdates, updateActions } = await import('../src/updater.ts')
    const manual = setupUpdates(host)
    const dialog = nextDialog()

    vi.useFakeTimers()
    try {
      manual()
      await vi.advanceTimersByTimeAsync(10_000)
      await waitFor('is what the feed names; the in-place check did not get through')
    } finally {
      vi.useRealTimers()
    }
    await dialog

    expect(shell.dialogs.map(entry => entry.message)).toEqual(['无法检查更新'])
    expect(String(shell.dialogs[0]?.detail)).toContain('ECONNRESET')
    expect(shell.opened).toEqual([])
    const snapshot = updateActions(host).state()
    expect(snapshot).toMatchObject({ phase: 'failed', reason: 'ECONNRESET' })
    expect(snapshot.latestVersion).toBeUndefined()
  })
})

describe('an in-place check that failed fatally', () => {
  /** The failure the library raises when its channel file is gone, which is fatal. */
  function missingChannelFile(): Error {
    return Object.assign(new Error("ENOENT: no such file or directory, open 'latest-mac.yml'"), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' })
  }

  it('reports the failure instead of an already-current answer (R12)', async () => {
    bundle(true)
    // The raw feed names the installed build; the native check never finished.
    serveFeed(dump({
      ...manifest(),
      version: CURRENT,
      dshRelease: identity(CURRENT, CURRENT_BUILD, REVISION).dshRelease,
    }))
    shell.checkForUpdates = async (): Promise<unknown> => { throw missingChannelFile() }
    const { host, waitFor } = sink()
    const { setupUpdates, updateActions } = await import('../src/updater.ts')
    const manual = setupUpdates(host)
    const dialog = nextDialog()

    vi.useFakeTimers()
    try {
      manual()
      await vi.advanceTimersByTimeAsync(30_000)
      await waitFor('is what the feed names; the in-place check did not get through')
    } finally {
      vi.useRealTimers()
    }
    await dialog

    expect(shell.dialogs.map(entry => entry.message)).toEqual(['无法检查更新'])
    expect(String(shell.dialogs[0]?.detail)).toContain('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')
    expect(shell.opened).toEqual([])
    expect(updateActions(host).state()).toMatchObject({ phase: 'failed' })
  })

  it('does not hand a fatal failure to the download-page offer', async () => {
    bundle(true)
    serveFeed()
    shell.checkForUpdates = async (): Promise<unknown> => { throw missingChannelFile() }
    const { host, waitFor } = sink()
    const { setupUpdates, updateActions } = await import('../src/updater.ts')
    const manual = setupUpdates(host)
    const dialog = nextDialog()

    vi.useFakeTimers()
    try {
      manual()
      await vi.advanceTimersByTimeAsync(30_000)
      await waitFor('was read straight from the feed; the in-place check did not get through')
    } finally {
      vi.useRealTimers()
    }
    await dialog

    expect(shell.dialogs.map(entry => entry.message)).toEqual(['无法检查更新'])
    expect(String(shell.dialogs[0]?.detail)).toContain('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')
    expect(shell.opened).toEqual([])
    expect(updateActions(host).state()).toMatchObject({ phase: 'failed' })
  })
})
