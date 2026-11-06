/**
 * An installer that fails after the hand-off. By then the server is stopped,
 * the quitting state is set and, on macOS, the window is hidden behind the
 * install notice; the updater must take the notice down, show the failure on
 * the update entry, and have the host bring the app back. electron,
 * electron-updater and the progress window stand in; the stand-in updater's
 * `quitAndInstall` raises `error` the way Squirrel's staging failure and a
 * NSIS installer that did not start do.
 * @module
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateHost } from '../src/updater.ts'

/** What the stand-ins read and record. Hoisted because the mock factories run first. */
const fixture = vi.hoisted(() => ({
  home: '',
  beforeQuit: [] as (() => void)[],
  /** Every updater the run built, so a case can raise the library's own events. */
  instances: [] as { emit: (event: string, payload: unknown) => void }[],
  /** Whether `quitAndInstall` fails. */
  installFails: true,
  quitAndInstalls: 0,
  closedNotices: 0,
  quits: 0,
  /** Button indexes the next dialogs answer with, in order; 0 once empty. */
  answers: [] as number[],
  /** Every dialog message, in order. */
  dialogs: [] as string[],
  /** What `checkForUpdates()` answers. */
  checkResult: null as { updateInfo: { version: string; minimumVersion: string } } | null,
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: (): string => fixture.home }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: (): string => '0.1.0-rc.34',
    getName: (): string => 'DSH Desktop',
    // The executable sits in a signed bundle, which is what lets macOS install in place.
    getPath: (name: string): string => name === 'exe'
      ? join(fixture.home, 'DSH Desktop.app', 'Contents', 'MacOS', 'DSH Desktop')
      : join(fixture.home, name),
    getLocale: (): string => 'zh-CN',
    once: (event: string, listener: () => void): void => {
      if (event === 'before-quit') fixture.beforeQuit.push(listener)
    },
    quit: (): void => { fixture.quits += 1 },
    dock: undefined,
  },
  BrowserWindow: { getAllWindows: (): unknown[] => [], getFocusedWindow: (): unknown => null },
  dialog: {
    showMessageBox: async (options: { message?: string }): Promise<{ response: number }> => {
      fixture.dialogs.push(options.message ?? '')
      return { response: fixture.answers.shift() ?? 0 }
    },
  },
  Menu: { setApplicationMenu: (): void => undefined, buildFromTemplate: (template: unknown): unknown => template },
  nativeTheme: { shouldUseDarkColors: false },
  shell: { openExternal: async (): Promise<void> => undefined },
}))

vi.mock('electron-updater', () => {
  /** Both platform classes, with the events and the install the module drives. */
  class FakeUpdater {
    autoDownload = true
    autoInstallOnAppQuit = true
    logger: unknown = undefined
    private readonly listeners = new Map<string, ((payload: unknown) => void)[]>()

    constructor() {
      fixture.instances.push(this)
    }

    on(event: string, listener: (payload: unknown) => void): this {
      this.listeners.set(event, [...this.listeners.get(event) ?? [], listener])
      return this
    }

    emit(event: string, payload: unknown): void {
      for (const listener of this.listeners.get(event) ?? []) listener(payload)
    }

    async checkForUpdates(): Promise<typeof fixture.checkResult> {
      return fixture.checkResult
    }

    async downloadUpdate(): Promise<void> {
      this.emit('update-downloaded', { version: '0.1.0-rc.35' })
    }

    quitAndInstall(): void {
      fixture.quitAndInstalls += 1
      if (fixture.installFails) this.emit('error', new Error('Code signature at URL did not pass validation'))
    }
  }
  return { MacUpdater: FakeUpdater, NsisUpdater: FakeUpdater }
})

vi.mock('../src/progress-window.ts', () => ({
  showInstalling: (): void => undefined,
  closeInstalling: (): void => { fixture.closedNotices += 1 },
}))

/** The platform this process reports outside these cases. */
const realPlatform = process.platform

/** The feed this process names outside these cases. */
const realFeed = process.env.DSH_UPDATE_FEED

beforeAll(() => {
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
  fixture.home = mkdtempSync(join(tmpdir(), 'dsh-install-failure-'))
  mkdirSync(join(fixture.home, 'userData'))
  const signature = join(fixture.home, 'DSH Desktop.app', 'Contents', '_CodeSignature')
  mkdirSync(signature, { recursive: true })
  writeFileSync(join(signature, 'CodeResources'), '<plist/>\n')
  fixture.instances.length = 0
  fixture.installFails = true
  fixture.quitAndInstalls = 0
  fixture.closedNotices = 0
  fixture.quits = 0
  fixture.answers = []
  fixture.dialogs = []
  fixture.checkResult = null
})

afterEach(() => {
  for (const listener of fixture.beforeQuit.splice(0)) listener()
  rmSync(fixture.home, { recursive: true, force: true })
})

/**
 * A host that records what the updater asked of it.
 * @returns the host, its log lines, and the steps it was asked for.
 */
function recordingHost(): { host: UpdateHost; lines: string[]; steps: string[] } {
  const lines: string[] = []
  const steps: string[] = []
  const host: UpdateHost = {
    log: (line) => { lines.push(line) },
    openLog: () => undefined,
    prepareQuit: async () => { steps.push('prepareQuit') },
    resumeAfterFailedInstall: async (blocking) => { steps.push(`resume(${String(blocking)})`) },
  }
  return { host, lines, steps }
}

/**
 * Report `platform` for the rest of the case.
 * @param platform - what `process.platform` answers.
 */
function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

/**
 * Run one check so the module builds its updater, as the check or download
 * that staged a real update would have.
 * @param host - the host the check runs with.
 * @param updateActions - the module's action factory.
 */
async function buildUpdater(host: UpdateHost, updateActions: (host: UpdateHost) => { check: () => void }): Promise<void> {
  updateActions(host).check()
  await vi.waitFor(() => { expect(fixture.instances).toHaveLength(1) })
}

describe('an install click whose installer fails', () => {
  for (const platform of ['darwin', 'win32'] as const) {
    it(`brings the app back and shows the failure on ${platform}`, async () => {
      onPlatform(platform)
      const { host, lines, steps } = recordingHost()
      const { setupUpdates, updateActions } = await import('../src/updater.ts')
      setupUpdates(host)
      await buildUpdater(host, updateActions)

      updateActions(host).install()
      await vi.waitFor(() => { expect(steps).toContain('resume(false)') })

      expect(steps).toEqual(['prepareQuit', 'resume(false)'])
      expect(fixture.closedNotices).toBe(1)
      expect(updateActions(host).state().phase).toBe('failed')
      expect(lines.join('')).toContain('failed (Code signature at URL did not pass validation); bringing the app back')
      expect(fixture.dialogs).toEqual([])
      expect(fixture.quits).toBe(0)
    })
  }

  it('does nothing of the kind when the installer takes over', async () => {
    onPlatform('win32')
    fixture.installFails = false
    const { host, steps } = recordingHost()
    const { setupUpdates, updateActions } = await import('../src/updater.ts')
    setupUpdates(host)
    await buildUpdater(host, updateActions)

    updateActions(host).install()
    await vi.waitFor(() => { expect(fixture.quitAndInstalls).toBe(1) })

    expect(steps).toEqual(['prepareQuit'])
    expect(fixture.closedNotices).toBe(0)
  })

  it('treats an updater error before any hand-off as no install failure', async () => {
    onPlatform('win32')
    const { host, steps } = recordingHost()
    const { setupUpdates } = await import('../src/updater.ts')
    setupUpdates(host)

    fixture.instances[0]?.emit('error', new Error('socket hang up'))

    expect(steps).toEqual([])
    expect(fixture.closedNotices).toBe(0)
  })
})

describe('a mandatory update whose installer fails', () => {
  it('keeps the served UI closed and offers installing again or quitting', async () => {
    onPlatform('win32')
    fixture.checkResult = { updateInfo: { version: '0.1.0-rc.35', minimumVersion: '0.1.0-rc.35' } }
    // 重启安装, then 重试, then 退出应用.
    fixture.answers = [0, 0, 1]
    const { host, steps } = recordingHost()
    const { launchGate } = await import('../src/updater.ts')

    expect(await launchGate(host, () => undefined)).toBe(true)
    await vi.waitFor(() => { expect(fixture.quits).toBe(1) })

    expect(steps).toEqual(['prepareQuit', 'resume(true)', 'prepareQuit', 'resume(true)'])
    expect(fixture.quitAndInstalls).toBe(2)
    expect(fixture.dialogs).toEqual([
      'v0.1.0-rc.35 已下载完毕。重启安装后即可继续使用。', 'v0.1.0-rc.35 没有安装成功', 'v0.1.0-rc.35 没有安装成功',
    ])
  })
})
