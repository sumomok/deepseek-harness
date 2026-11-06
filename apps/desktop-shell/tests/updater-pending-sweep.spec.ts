/**
 * The updater's two ends of the `pending` sweep: the install click remembers
 * which staged artifact it hands over, and the first launch of the newer build
 * removes that artifact from electron-updater's `pending` directory.
 * electron, electron-updater and the progress window stand in; the cache
 * directory, the staged record and `desktop-state.json` are real files under
 * a temporary home.
 * @module
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateHost } from '../src/updater.ts'

/** What the stand-ins read, set per case. Hoisted because the mock factories run first. */
const fixture = vi.hoisted(() => ({
  /** The temporary directory `os.homedir()` answers with. */
  home: '',
  /** What `app.getVersion()` answers. */
  version: '',
  /** What the app registered for `before-quit`, which is what stops the check timers. */
  beforeQuit: [] as (() => void)[],
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
    getPath: (name: string): string => join(fixture.home, name),
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
  /** Both platform classes; nothing here reaches past construction and install. */
  class FakeUpdater {
    on(): this {
      return this
    }

    quitAndInstall(): void {
      // Nothing replaces the application in a unit process.
    }
  }
  return { MacUpdater: FakeUpdater, NsisUpdater: FakeUpdater }
})

vi.mock('../src/progress-window.ts', () => ({ showInstalling: (): void => undefined, closeInstalling: (): void => undefined }))

/** The build that starts the install. */
const FROM = '0.1.0-rc.34'

/** The build the install puts in its place. */
const TO = '0.1.0-rc.35'

/** The staged artifact's name, as electron-updater derives it from the feed URL. */
const FILE_NAME = 'DSH-Desktop-0.1.0-rc.35-arm64-mac.zip'

/** The platform this process reports outside these cases. */
const realPlatform = process.platform

beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
})

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
})

beforeEach(() => {
  vi.resetModules()
  fixture.home = mkdtempSync(join(tmpdir(), 'dsh-updater-home-'))
  mkdirSync(join(fixture.home, 'userData'))
})

afterEach(() => {
  // The delayed first check and the recurring one would otherwise outlive the case.
  for (const listener of fixture.beforeQuit.splice(0)) listener()
  rmSync(fixture.home, { recursive: true, force: true })
})

/** The updater cache directory under the temporary home, as `updaterCacheDir` resolves it with no app-update.yml. */
function cacheDir(): string {
  return join(fixture.home, 'Library', 'Caches', 'DSH Desktop')
}

/**
 * Stage one artifact in `pending` with its record, and a differential
 * baseline in the cache root.
 * @returns the artifact's sha512 as the record holds it.
 */
function stagePending(): string {
  const pending = join(cacheDir(), 'pending')
  mkdirSync(pending, { recursive: true })
  const bytes = randomBytes(1_024)
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  writeFileSync(join(pending, FILE_NAME), bytes)
  writeFileSync(join(pending, 'update-info.json'), JSON.stringify({ fileName: FILE_NAME, sha512, isAdminRightsRequired: false }))
  writeFileSync(join(cacheDir(), 'update.zip'), 'baseline')
  return sha512
}

/** What `desktop-state.json` holds now. */
function state(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixture.home, 'userData', 'desktop-state.json'), 'utf8')) as Record<string, unknown>
}

/**
 * A host whose log lines a case can read.
 * @returns the host and its lines.
 */
function sink(): { host: UpdateHost; lines: string[] } {
  const lines: string[] = []
  return {
    host: {
      log: (line) => { lines.push(line) }, openLog: () => undefined, prepareQuit: async () => undefined,
      resumeAfterFailedInstall: async () => undefined,
    },
    lines,
  }
}

describe('the install click', () => {
  it('remembers which staged artifact it handed over and from which version', async () => {
    fixture.version = FROM
    const sha512 = stagePending()
    const { host } = sink()
    const { setupUpdates, updateActions } = await import('../src/updater.ts')
    setupUpdates(host)

    updateActions(host).install()
    await vi.waitFor(() => { expect(state().installedUpdate).toBeDefined() })

    expect(state().installedUpdate).toEqual({ fromVersion: FROM, fileName: FILE_NAME, sha512 })
  })
})

describe('the first launch after an install', () => {
  it('empties `pending`, keeps the root baseline, and forgets the install', async () => {
    fixture.version = TO
    const sha512 = stagePending()
    writeFileSync(join(fixture.home, 'userData', 'desktop-state.json'), JSON.stringify({
      lastRunVersion: FROM, installedUpdate: { fromVersion: FROM, fileName: FILE_NAME, sha512 },
    }))
    const { host, lines } = sink()
    const { setupUpdates } = await import('../src/updater.ts')

    setupUpdates(host)

    expect(readdirSync(join(cacheDir(), 'pending'))).toEqual([])
    expect(readFileSync(join(cacheDir(), 'update.zip'), 'utf8')).toBe('baseline')
    expect(state()).toEqual({ lastRunVersion: FROM })
    expect(lines.some(line => line.includes(`removed the installed ${FILE_NAME} from pending`))).toBe(true)
  })

  it('leaves `pending` and the remembered install alone while the same version runs, because the install did not land', async () => {
    fixture.version = FROM
    const sha512 = stagePending()
    const remembered = { fromVersion: FROM, fileName: FILE_NAME, sha512 }
    writeFileSync(join(fixture.home, 'userData', 'desktop-state.json'), JSON.stringify({ installedUpdate: remembered }))
    const { host } = sink()
    const { setupUpdates } = await import('../src/updater.ts')

    setupUpdates(host)

    expect(existsSync(join(cacheDir(), 'pending', FILE_NAME))).toBe(true)
    expect(state().installedUpdate).toEqual(remembered)
  })

  it('does nothing on a launch with no install to remember', async () => {
    fixture.version = TO
    stagePending()
    const { host } = sink()
    const { setupUpdates } = await import('../src/updater.ts')

    setupUpdates(host)

    expect(existsSync(join(cacheDir(), 'pending', FILE_NAME))).toBe(true)
  })
})
