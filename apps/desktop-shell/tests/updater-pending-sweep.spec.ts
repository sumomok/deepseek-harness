/**
 * The updater's two ends of the `pending` sweep: the install click writes the
 * receipt naming the build it hands over, and the first launch of a later build
 * removes that artifact from electron-updater's `pending` directory only when
 * the running build is exactly the receipt's target.
 * electron, electron-updater and the progress window stand in; the cache
 * directory, the staged record and `desktop-state.json` are real files under a
 * temporary home.
 * @module
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReleaseIdentity } from '../src/release-identity.ts'
import type { UpdateHost } from '../src/updater.ts'

/** The build that starts the install. */
const FROM_VERSION = '0.1.0-rc.34'

/** The build the install puts in its place. */
const TO_VERSION = '0.1.0-rc.35'

/** The staged artifact's name, as electron-updater derives it from the feed URL. */
const FILE_NAME = 'DSH-Desktop-0.1.0-rc.35-arm64-mac.zip'

/** Two full Git object names, so the builds are told apart by more than a version. */
const FROM_REVISION = 'a'.repeat(40)
const TO_REVISION = 'b'.repeat(40)

/** The artifact's bytes and digest, shared by the feed, `pending` and the receipt. */
const ARTIFACT = randomBytes(1_024)
const SHA512 = createHash('sha512').update(ARTIFACT).digest('base64')

/** What the stand-ins read, set per case. Hoisted because the mock factories run first. */
const fixture = vi.hoisted(() => ({
  /** The temporary directory `os.homedir()` answers with. */
  home: '',
  /** The directory `app.getAppPath()` answers with; its `package.json` is the build's identity. */
  appPath: '',
  /** What `app.getVersion()` answers, which is the running build's version. */
  version: '',
  /** What the app registered for `before-quit`, which is what stops the check timers. */
  beforeQuit: [] as (() => void)[],
  /** The manifest the library's check reports, or null for "nothing to check". */
  info: null as Record<string, unknown> | null,
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: (): string => fixture.home }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: (): string => fixture.version,
    getName: (): string => 'DSH Desktop',
    getAppPath: (): string => fixture.appPath,
    getPath: (name: string): string => name === 'exe'
      ? join(fixture.home, 'DSH Desktop.app', 'Contents', 'MacOS', 'DSH Desktop')
      : join(fixture.home, name),
    getLocale: (): string => 'zh-CN',
    once: (event: string, listener: () => void): void => {
      if (event === 'before-quit') fixture.beforeQuit.push(listener)
    },
    dock: undefined,
  },
  BrowserWindow: { getAllWindows: (): unknown[] => [], getFocusedWindow: (): unknown => null },
  dialog: { showMessageBox: async (): Promise<{ response: number }> => ({ response: 0 }) },
  Menu: { setApplicationMenu: (): void => undefined, buildFromTemplate: (template: unknown): unknown => template },
  nativeTheme: { shouldUseDarkColors: false },
  shell: { openExternal: async (): Promise<void> => undefined },
}))

vi.mock('electron-updater', () => {
  /** Both platform classes, with the candidate callback and the download the module drives. */
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
      const info = fixture.info
      if (info === null) return null
      const available = await this.isUpdateCandidate?.(info) ?? false
      return { isUpdateAvailable: available, updateInfo: info }
    }

    async downloadUpdate(): Promise<void> {
      // What the library raises once the artifact is cached and verified: the
      // bytes are in `pending` and the event names the file it wrote.
      const pending = join(fixture.home, 'Library', 'Caches', 'DSH Desktop', 'pending')
      mkdirSync(pending, { recursive: true })
      const file = join(pending, FILE_NAME)
      writeFileSync(file, ARTIFACT)
      this.emit('update-downloaded', { ...fixture.info, downloadedFile: file })
    }

    quitAndInstall(): void {
      // Nothing replaces the application in a unit process.
    }
  }
  return { MacUpdater: FakeUpdater, NsisUpdater: FakeUpdater }
})

vi.mock('../src/progress-window.ts', () => ({ showInstalling: (): void => undefined, closeInstalling: (): void => undefined }))

/** The platform this process reports outside these cases. */
const realPlatform = process.platform

/** The feed this process names outside these cases. */
const realFeed = process.env.DSH_UPDATE_FEED

beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  // A feed nothing can reach, so a request that escaped the stand-ins fails at once.
  process.env.DSH_UPDATE_FEED = 'http://127.0.0.1:1/dsh-updates'
})

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  if (realFeed === undefined) delete process.env.DSH_UPDATE_FEED
  else process.env.DSH_UPDATE_FEED = realFeed
})

beforeEach(() => {
  vi.resetModules()
  fixture.home = mkdtempSync(join(tmpdir(), 'dsh-updater-home-'))
  mkdirSync(join(fixture.home, 'userData'))
  mkdirSync(join(fixture.home, 'Library', 'Caches', 'DSH Desktop', 'pending'), { recursive: true })
  const signature = join(fixture.home, 'DSH Desktop.app', 'Contents', '_CodeSignature')
  mkdirSync(signature, { recursive: true })
  writeFileSync(join(signature, 'CodeResources'), '<plist/>\n')
  fixture.appPath = join(fixture.home, 'app')
  mkdirSync(fixture.appPath, { recursive: true })
  fixture.info = null
  fixture.version = FROM_VERSION
})

afterEach(() => {
  // The delayed first check and the recurring one would otherwise outlive the case.
  for (const listener of fixture.beforeQuit.splice(0)) listener()
  rmSync(fixture.home, { recursive: true, force: true })
})

/**
 * The identity one build declares.
 * @param version - its application version.
 * @param build - its build sequence.
 * @param revision - its source commit.
 * @returns the identity, as a standard build declares it.
 */
function identity(version: string, build: number, revision: string): ReleaseIdentity {
  return {
    version,
    dshRelease: { schemaVersion: 2, runtimeVersion: version, buildSequence: build, revision, kind: 'standard' },
  }
}

/**
 * Make the app directory declare one build, as a packaged installation does.
 * @param declared - the identity to write into `package.json`.
 */
function installBuild(declared: ReleaseIdentity): void {
  fixture.version = declared.version
  writeFileSync(join(fixture.appPath, 'package.json'), JSON.stringify({ name: 'DSH Desktop', ...declared }))
}

/** The updater cache directory under the temporary home, as `updaterCacheDir` resolves it with no app-update.yml. */
function cacheDir(): string {
  return join(fixture.home, 'Library', 'Caches', 'DSH Desktop')
}

/** The manifest a v2 feed publishes for the build the install would put in place. */
function manifest(): Record<string, unknown> {
  return {
    version: TO_VERSION,
    dshRelease: identity(TO_VERSION, 35, TO_REVISION).dshRelease,
    files: [{ url: FILE_NAME, sha512: SHA512, size: ARTIFACT.length }],
    path: FILE_NAME,
    releaseNotes: 'fixes the thing',
  }
}

/**
 * Stage one artifact in `pending` with its record, and a differential baseline
 * in the cache root.
 */
function stagePending(): void {
  const pending = join(cacheDir(), 'pending')
  writeFileSync(join(pending, FILE_NAME), ARTIFACT)
  writeFileSync(join(pending, 'update-info.json'), JSON.stringify({ fileName: FILE_NAME, sha512: SHA512, isAdminRightsRequired: false }))
  writeFileSync(join(cacheDir(), 'update.zip'), 'baseline')
}

/** What `desktop-state.json` holds now. */
function state(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixture.home, 'userData', 'desktop-state.json'), 'utf8')) as Record<string, unknown>
}

/**
 * Write the state file the launch after an install reads.
 * @param stored - the fields to put in it.
 */
function writeState(stored: Record<string, unknown>): void {
  writeFileSync(join(fixture.home, 'userData', 'desktop-state.json'), JSON.stringify(stored))
}

/**
 * A host whose log lines a case can read.
 * @returns the host and its lines.
 */
function sink(): { host: UpdateHost; lines: string[] } {
  const lines: string[] = []
  return {
    host: {
      log: (line) => { lines.push(line) }, openLog: (): void => undefined, prepareQuit: async () => undefined,
      resumeAfterFailedInstall: async () => undefined,
    },
    lines,
  }
}

describe('the install click', () => {
  it('records the build it installs, the artifact and its digest before handing over', async () => {
    fixture.info = manifest()
    installBuild(identity(FROM_VERSION, 34, FROM_REVISION))
    const { host } = sink()
    const { setupUpdates, updateActions } = await import('../src/updater.ts')
    setupUpdates(host)

    updateActions(host).check()
    await vi.waitFor(() => { expect(updateActions(host).state().phase).toBe('ready') })

    updateActions(host).install()
    await vi.waitFor(() => { expect(state().installedUpdateV2).toBeDefined() })

    expect(state().installedUpdateV2).toEqual({
      schemaVersion: 2,
      from: identity(FROM_VERSION, 34, FROM_REVISION),
      target: identity(TO_VERSION, 35, TO_REVISION),
      fileName: FILE_NAME,
      sha512: SHA512,
    })
    // The record the old protocol wrote is not produced any more: it names no
    // target, so nothing could confirm the install against it.
    expect(state().installedUpdate).toBeUndefined()
  })
})

describe('the first launch after an install', () => {
  it('empties `pending`, keeps the root baseline, and forgets the receipt', async () => {
    installBuild(identity(TO_VERSION, 35, TO_REVISION))
    stagePending()
    writeState({
      lastRunVersion: FROM_VERSION,
      installedUpdateV2: {
        schemaVersion: 2,
        from: identity(FROM_VERSION, 34, FROM_REVISION),
        target: identity(TO_VERSION, 35, TO_REVISION),
        fileName: FILE_NAME,
        sha512: SHA512,
      },
    })
    const { host, lines } = sink()
    const { setupUpdates } = await import('../src/updater.ts')

    setupUpdates(host)

    expect(readdirSync(join(cacheDir(), 'pending'))).toEqual([])
    expect(readFileSync(join(cacheDir(), 'update.zip'), 'utf8')).toBe('baseline')
    expect(state().installedUpdateV2).toBeUndefined()
    expect(lines.some(line => line.includes(`removed the installed ${FILE_NAME} from pending`))).toBe(true)
  })

  it('leaves `pending` and the receipt alone while the build that started the install runs again', async () => {
    installBuild(identity(FROM_VERSION, 34, FROM_REVISION))
    stagePending()
    const receipt = {
      schemaVersion: 2,
      from: identity(FROM_VERSION, 34, FROM_REVISION),
      target: identity(TO_VERSION, 35, TO_REVISION),
      fileName: FILE_NAME,
      sha512: SHA512,
    }
    writeState({ installedUpdateV2: receipt })
    const { host, lines } = sink()
    const { setupUpdates } = await import('../src/updater.ts')

    setupUpdates(host)

    expect(existsSync(join(cacheDir(), 'pending', FILE_NAME))).toBe(true)
    expect(state().installedUpdateV2).toEqual(receipt)
    expect(lines.some(line => line.includes('has not been installed yet'))).toBe(true)
  })

  it('removes nothing and claims nothing when the running build is neither end of the receipt', async () => {
    // A build installed by another route — or a downgrade — is not evidence
    // that the receipt's target landed.
    installBuild(identity('0.1.0-rc.40', 40, 'c'.repeat(40)))
    stagePending()
    const receipt = {
      schemaVersion: 2,
      from: identity(FROM_VERSION, 34, FROM_REVISION),
      target: identity(TO_VERSION, 35, TO_REVISION),
      fileName: FILE_NAME,
      sha512: SHA512,
    }
    writeState({ installedUpdateV2: receipt })
    const { host, lines } = sink()
    const { setupUpdates } = await import('../src/updater.ts')

    setupUpdates(host)

    expect(existsSync(join(cacheDir(), 'pending', FILE_NAME))).toBe(true)
    expect(state().installedUpdateV2).toEqual(receipt)
    expect(lines.some(line => line.includes('the last install is unconfirmed'))).toBe(true)
  })

  it('leaves a legacy receipt’s artifact in place, because it cannot name the build that installed it', async () => {
    // The old protocol recorded only the starting version and compared
    // versions, so a larger version was read as a landed install. That record
    // proves nothing about which build now runs.
    installBuild(identity(TO_VERSION, 35, TO_REVISION))
    stagePending()
    writeState({
      installedUpdate: { fromVersion: FROM_VERSION, fileName: FILE_NAME, sha512: SHA512 },
    })
    const { host } = sink()
    const { setupUpdates } = await import('../src/updater.ts')

    setupUpdates(host)

    expect(existsSync(join(cacheDir(), 'pending', FILE_NAME))).toBe(true)
    expect(state().installedUpdate).toBeDefined()
  })

  it('keeps the candidate a later download staged and forgets the older receipt', async () => {
    installBuild(identity(TO_VERSION, 35, TO_REVISION))
    stagePending()
    // `pending` now vouches for a different artifact: whatever download put it
    // there is a candidate to keep, not this install's leftovers.
    const later = 'DSH-Desktop-0.1.0-rc.36-arm64-mac.zip'
    writeFileSync(join(cacheDir(), 'pending', later), ARTIFACT)
    writeFileSync(join(cacheDir(), 'pending', 'update-info.json'), JSON.stringify({
      fileName: later, sha512: SHA512, isAdminRightsRequired: false,
    }))
    writeState({
      installedUpdateV2: {
        schemaVersion: 2,
        from: identity(FROM_VERSION, 34, FROM_REVISION),
        target: identity(TO_VERSION, 35, TO_REVISION),
        fileName: FILE_NAME,
        sha512: SHA512,
      },
    })
    const { host } = sink()
    const { setupUpdates } = await import('../src/updater.ts')

    setupUpdates(host)

    expect(existsSync(join(cacheDir(), 'pending', later))).toBe(true)
    expect(state().installedUpdateV2).toBeUndefined()
  })

  it('does nothing on a launch with no receipt to act on', async () => {
    installBuild(identity(TO_VERSION, 35, TO_REVISION))
    stagePending()
    const { host } = sink()
    const { setupUpdates } = await import('../src/updater.ts')

    setupUpdates(host)

    expect(existsSync(join(cacheDir(), 'pending', FILE_NAME))).toBe(true)
  })

  it('keeps the receipt when the running build declares no identity to confirm it against', async () => {
    stagePending()
    // No package.json under the app path: a development start, or a package
    // that predates the release identity.
    writeState({
      installedUpdateV2: {
        schemaVersion: 2,
        from: identity(FROM_VERSION, 34, FROM_REVISION),
        target: identity(TO_VERSION, 35, TO_REVISION),
        fileName: FILE_NAME,
        sha512: SHA512,
      },
    })
    const { host, lines } = sink()
    const { setupUpdates } = await import('../src/updater.ts')

    setupUpdates(host)

    expect(existsSync(join(cacheDir(), 'pending', FILE_NAME))).toBe(true)
    expect(state().installedUpdateV2).toBeDefined()
    expect(lines.some(line => line.includes('keeping the last install receipt'))).toBe(true)
  })
})
