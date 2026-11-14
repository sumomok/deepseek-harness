/**
 * Two ways an install can end without an installer: an installer that fails
 * after the hand-off, and a hand-off that is refused before it starts — a
 * teardown that could not confirm the server tree is gone, or a receipt that
 * could not be written. By the time an installer runs the server is stopped and,
 * on macOS, the window is hidden behind the install notice; the updater must
 * take the notice down, show the failure on the update entry, and have the host
 * bring the app back. electron, electron-updater and the progress window stand
 * in; the app's own package manifest and the state file are real files under a
 * temporary home.
 * @module
 */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateServiceSpec } from '../src/update-service.ts'
import type { UpdateHost } from '../src/updater.ts'
import type { MessageBoxOptions } from 'electron'
import type { WindowsInstallResult } from '../src/windows-install.ts'

/** The running build these cases install from. */
const FROM_VERSION = '0.1.0-rc.34'

/** The build the feed offers. */
const TO_VERSION = '0.1.0-rc.35'

/** The artifact the feed lists on macOS. */
const ARTIFACT = 'DSH Desktop-0.1.0-rc.35-arm64-mac.zip'

/** The artifact the feed lists on Windows. */
const INSTALLER = 'DSH Desktop Setup 0.1.0-rc.35.exe'

/** The artifact's bytes; the ready check reads them back from disk. */
const ARTIFACT_BYTES = Buffer.from('the update artifact these cases install\n')

/** The base64 SHA-512 of [[ARTIFACT_BYTES]], as the manifest states it. */
const SHA512 = createHash('sha512').update(ARTIFACT_BYTES).digest('base64')

/** The artifact's length, as the manifest states it. */
const ARTIFACT_SIZE = ARTIFACT_BYTES.byteLength

/** What the stand-ins read and record. Hoisted because the mock factories run first. */
const fixture = vi.hoisted(() => ({
  home: '',
  appPath: '',
  /** The user data directory, which a case can point somewhere unwritable. */
  userData: '',
  beforeQuit: [] as (() => void)[],
  /** Whether `prepareQuit` refuses the hand-off. */
  stopFails: false,
  /** Whether `quitAndInstall` fails. */
  installFails: true,
  installerStarts: 0,
  closedNotices: 0,
  quits: 0,
  /** Button indexes the next dialogs answer with, in order; 0 once empty. */
  answers: [] as number[],
  confirmations: [] as MessageBoxOptions[],
  confirmAnswer: 1,
  confirmGate: undefined as Promise<number> | undefined,
  confirmFails: false,
  onDialog: undefined as ((message: string) => void) | undefined,
  launchGate: undefined as Promise<WindowsInstallResult> | undefined,
  /** Every failure/mandatory dialog message, in order. */
  dialogs: [] as string[],
  /** The manifest the check reports. */
  info: null as Record<string, unknown> | null,
  /** Whether a download raises `update-downloaded`; a case can raise it itself. */
  emitOnDownload: true,
  /** What every download raises instead of the default verified payload. */
  downloadPayload: null as Record<string, unknown> | null,
  /** Payloads consumed one per download, before [[downloadPayload]]. */
  downloadPayloads: [] as (Record<string, unknown> | null)[],
  /** Holds `prepareQuit` open, so a case can put a second click inside it. */
  stopGate: undefined as Promise<void> | undefined,
  /** Holds the recovery open, so a case can put a click inside it. */
  resumeGate: undefined as Promise<void> | undefined,
  /** The receipt the state file held when the installer was called. */
  receiptAtInstaller: undefined as Record<string, unknown> | undefined,
  /** Every updater the run built, so a case can raise the library's own events. */
  instances: [] as { emit: (event: string, payload: unknown) => void }[],
}))

/** These install checks run from a certificate-backed installation. */
vi.mock('../src/mac-signature.ts', () => ({ macAppHasCertificateSignature: (): boolean => true }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: (): string => fixture.home }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: (): string => FROM_VERSION,
    getName: (): string => 'DSH Desktop',
    getAppPath: (): string => fixture.appPath,
    // The executable sits in a signed bundle, which is what lets macOS install in place.
    getPath: (name: string): string => name === 'exe'
      ? join(fixture.home, 'DSH Desktop.app', 'Contents', 'MacOS', 'DSH Desktop')
      : name === 'userData' ? fixture.userData : join(fixture.home, name),
    getLocale: (): string => 'zh-CN',
    on: (event: string, listener: (event: { defaultPrevented: boolean }) => void): void => {
      if (event === 'before-quit') fixture.beforeQuit.push(() => { listener({ defaultPrevented: false }) })
    },
    quit: (): void => { fixture.quits += 1 },
    dock: undefined,
  },
  BrowserWindow: { getAllWindows: (): unknown[] => [], getFocusedWindow: (): unknown => null },
  dialog: {
    showMessageBox: async (options: MessageBoxOptions): Promise<{ response: number }> => {
      if (options.message === '安装更新会停止应用中的全部任务') {
        fixture.confirmations.push(options)
        if (fixture.confirmFails) throw new Error('native confirmation could not open')
        return { response: await (fixture.confirmGate ?? Promise.resolve(fixture.confirmAnswer)) }
      }
      fixture.onDialog?.(options.message)
      fixture.dialogs.push(options.message)
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
    isUpdateCandidate?: (info: unknown) => boolean | Promise<boolean>
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

    async checkForUpdates(): Promise<unknown> {
      const info = fixture.info
      if (info === null) return null
      const available = await this.isUpdateCandidate?.(info) ?? false
      return { isUpdateAvailable: available, updateInfo: info }
    }

    async downloadUpdate(): Promise<void> {
      if (!fixture.emitOnDownload) return
      const queued = fixture.downloadPayloads.shift()
      // What the library raises once its transfer is verified: the artifact is
      // in its cache under the name the feed publishes, and the event names it.
      this.emit('update-downloaded', queued ?? fixture.downloadPayload ?? { ...fixture.info, downloadedFile: stagedArtifact(process.platform) })
    }

    quitAndInstall(): void {
      if (process.platform === 'win32') throw new Error('Windows must await the OS hand-off instead of queuing library quit')
      fixture.installerStarts += 1
      // What the installer's launch would read: the receipt must be on disk at
      // the moment of the hand-off, not cleared by a rival attempt.
      fixture.receiptAtInstaller = receipt()
      if (fixture.installFails) this.emit('error', new Error('Code signature at URL did not pass validation'))
    }
  }
  return { MacUpdater: FakeUpdater, NsisUpdater: FakeUpdater }
})

vi.mock('../src/windows-install.ts', () => ({
  launchWindowsInstaller: async (): Promise<WindowsInstallResult> => {
    fixture.installerStarts += 1
    fixture.receiptAtInstaller = receipt()
    if (fixture.launchGate !== undefined) return fixture.launchGate
    return fixture.installFails
      ? { kind: 'not-started', code: 1223, detail: 'The operation was canceled by the user' }
      : { kind: 'started' }
  },
}))

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
  fixture.userData = join(fixture.home, 'userData')
  mkdirSync(fixture.userData)
  const signature = join(fixture.home, 'DSH Desktop.app', 'Contents', '_CodeSignature')
  mkdirSync(signature, { recursive: true })
  writeFileSync(join(signature, 'CodeResources'), '<plist/>\n')
  fixture.appPath = join(fixture.home, 'app')
  mkdirSync(fixture.appPath, { recursive: true })
  writeFileSync(join(fixture.appPath, 'package.json'), JSON.stringify({
    name: 'DSH Desktop',
    version: FROM_VERSION,
    dshRelease: {
      schemaVersion: 2,
      runtimeVersion: FROM_VERSION,
      buildSequence: 34,
      revision: 'a'.repeat(40),
      kind: 'standard',
    },
  }))
  fixture.beforeQuit.length = 0
  fixture.stopFails = false
  fixture.installFails = true
  fixture.installerStarts = 0
  fixture.confirmations = []
  fixture.confirmAnswer = 1
  fixture.confirmGate = undefined
  fixture.confirmFails = false
  fixture.onDialog = undefined
  fixture.launchGate = undefined
  fixture.closedNotices = 0
  fixture.quits = 0
  fixture.answers = []
  fixture.dialogs = []
  fixture.instances.length = 0
  fixture.emitOnDownload = true
  fixture.downloadPayload = null
  fixture.downloadPayloads.length = 0
  fixture.stopGate = undefined
  fixture.resumeGate = undefined
  fixture.receiptAtInstaller = undefined
  fixture.info = manifestFor(TO_VERSION, 35, 'b'.repeat(40))
})

afterEach(() => {
  for (const listener of fixture.beforeQuit.splice(0)) listener()
  rmSync(fixture.home, { recursive: true, force: true })
})

/**
 * The manifest one build publishes, as the stand-in library reports it.
 * @param version - the build's application version.
 * @param build - its build sequence.
 * @param revision - its source commit.
 * @returns the `updateInfo` the library's check reports.
 */
function manifestFor(version: string, build: number, revision: string): Record<string, unknown> {
  return {
    version,
    dshRelease: { schemaVersion: 2, runtimeVersion: version, buildSequence: build, revision, kind: 'standard' },
    files: [{ url: ARTIFACT, sha512: SHA512, size: ARTIFACT_SIZE }],
    path: ARTIFACT,
    releaseNotes: 'fixes the thing',
  }
}

/**
 * A host that records what the updater asked of it.
 * @returns the host, its log lines, and the steps it was asked for.
 */
function recordingHost(): { host: UpdateHost; lines: string[]; steps: string[] } {
  const lines: string[] = []
  const steps: string[] = []
  const host: UpdateHost = {
    log: (line) => { lines.push(line) },
    openLog: (): void => undefined,
    prepareQuit: async () => {
      steps.push('prepareQuit')
      if (fixture.stopGate !== undefined) await fixture.stopGate
      if (fixture.stopFails) {
        throw Object.assign(new Error('the server process tree was not confirmed stopped'), { code: 'UPDATE_STOP_INCOMPLETE' })
      }
    },
    resumeAfterFailedInstall: async (blocking) => {
      steps.push(`resume(${String(blocking)})`)
      if (fixture.resumeGate !== undefined) await fixture.resumeGate
    },
  }
  return { host, lines, steps }
}

/**
 * Report `platform` for the rest of the case.
 * @param platform - what `process.platform` answers.
 */
function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  // The manifest has to name the artifact this platform installs; the feed
  // parser refuses an entry the platform cannot use.
  fixture.info = {
    ...manifestFor(TO_VERSION, 35, 'b'.repeat(40)),
    files: [{ url: artifactFor(platform), sha512: SHA512, size: ARTIFACT_SIZE }],
  }
}

/**
 * The artifact name one platform installs.
 * @param platform - the platform reading the feed.
 * @returns the artifact's name.
 */
function artifactFor(platform: NodeJS.Platform): string {
  return platform === 'win32' ? INSTALLER : ARTIFACT
}

/**
 * Write the artifact's bytes under the name the library caches it with.
 * @param platform - the platform whose artifact name the file carries.
 * @returns the absolute path the `update-downloaded` event reports.
 */
function stagedArtifact(platform: NodeJS.Platform): string {
  const directory = join(fixture.home, 'staged')
  mkdirSync(directory, { recursive: true })
  const file = join(directory, artifactFor(platform))
  writeFileSync(file, ARTIFACT_BYTES)
  return file
}

/**
 * A `update-downloaded` payload naming one file on disk, as the library raises
 * it after a verified transfer.
 * @param platform - the platform whose artifact name the file carries.
 * @param bytes - the bytes to write; the accepted artifact's by default.
 * @returns the event payload.
 */
function stagedPayload(platform: NodeJS.Platform, bytes: Buffer = ARTIFACT_BYTES): Record<string, unknown> {
  const directory = join(fixture.home, 'staged')
  mkdirSync(directory, { recursive: true })
  const file = join(directory, artifactFor(platform))
  writeFileSync(file, bytes)
  return { ...(fixture.info ?? {}), downloadedFile: file }
}

/**
 * Run one check so the module builds its updater and downloads the manifest's
 * build, which is the state an install click starts from.
 * @param host - the host the check runs with.
 * @param updateActions - the module's action factory.
 */
async function reachReady(host: UpdateHost, updateActions: (host: UpdateHost) => UpdateServiceSpec): Promise<void> {
  const actions = updateActions(host)
  actions.check()
  await vi.waitFor(() => { expect(actions.state().phase).toBe('ready') })
}

/** The receipt the install click wrote, as the state file holds it. */
function receipt(): Record<string, unknown> | undefined {
  const path = join(fixture.userData, 'desktop-state.json')
  if (!existsSync(path)) return undefined
  const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  return stored.installedUpdateV2 as Record<string, unknown> | undefined
}

describe('an install click whose installer fails', () => {
  for (const platform of ['darwin', 'win32'] as const) {
    it(`brings the app back and shows the failure on ${platform}`, async () => {
      onPlatform(platform)
      const { host, lines, steps } = recordingHost()
      const { setupUpdates, updateActions } = await import('../src/updater.ts')
      setupUpdates(host)
      await reachReady(host, updateActions)

      updateActions(host).install()
      await vi.waitFor(() => { expect(steps).toContain('resume(false)') })

      expect(steps).toEqual(['prepareQuit', 'resume(false)'])
      expect(fixture.closedNotices).toBe(1)
      expect(fixture.quits).toBe(0)
      if (platform === 'darwin') {
        expect(updateActions(host).state().phase).toBe('failed')
        expect(lines.join('')).toContain('failed (Code signature at URL did not pass validation); bringing the app back')
        expect(fixture.dialogs).toEqual([])
        // Squirrel may have run partway; only the next launch can clear this.
        expect(receipt()).toBeDefined()
      } else {
        expect(updateActions(host).state().phase).toBe('ready')
        expect(lines.join('')).toContain('Windows installer did not start: The operation was canceled by the user')
        expect(fixture.dialogs).toEqual([`v${TO_VERSION} 没有开始安装`])
        expect(receipt()).toBeUndefined()
      }
    })
  }

  it('does nothing of the kind when the installer takes over', async () => {
    onPlatform('win32')
    fixture.installFails = false
    const { host, steps } = recordingHost()
    const { setupUpdates, updateActions } = await import('../src/updater.ts')
    setupUpdates(host)
    await reachReady(host, updateActions)

    updateActions(host).install()
    await vi.waitFor(() => { expect(fixture.installerStarts).toBe(1) })

    expect(steps).toEqual(['prepareQuit'])
    expect(fixture.closedNotices).toBe(0)
  })

  it('treats an updater error before any hand-off as no install failure', async () => {
    onPlatform('win32')
    const { host, steps } = recordingHost()
    const { setupUpdates, updateActions } = await import('../src/updater.ts')
    setupUpdates(host)
    await reachReady(host, updateActions)

    fixture.instances[0]?.emit('error', new Error('socket hang up'))

    // An error with no hand-off outstanding belongs to the check or download
    // that raised it, never to an install: the app is not brought back, and no
    // notice is taken down because none was up.
    expect(steps).toEqual([])
    expect(fixture.closedNotices).toBe(0)
  })
})

describe('a mandatory update whose installer fails', () => {
  it('keeps the served UI closed and offers installing again or quitting', async () => {
    onPlatform('win32')
    fixture.info = {
      ...fixture.info,
      minimumBuildSequence: 35,
    }
    // 重启安装, then 重试, then 退出应用.
    fixture.answers = [0, 0, 1]
    const { host, steps } = recordingHost()
    const { launchGate } = await import('../src/updater.ts')

    expect(await launchGate(host, () => undefined)).toBe(true)
    await vi.waitFor(() => { expect(fixture.quits).toBe(1) })

    expect(steps).toEqual(['prepareQuit', 'resume(true)', 'prepareQuit', 'resume(true)'])
    expect(fixture.installerStarts).toBe(2)
    expect(fixture.dialogs).toEqual([
      `v${TO_VERSION} 已下载完毕。重启安装后即可继续使用。`,
      `v${TO_VERSION} 没有开始安装`,
      `v${TO_VERSION} 没有开始安装`,
    ])
  })
})

describe('a hand-off refused before an installer starts', () => {
  it('starts no installer when the teardown could not be confirmed', async () => {
    onPlatform('win32')
    fixture.stopFails = true
    const { host, lines, steps } = recordingHost()
    const { setupUpdates, updateActions } = await import('../src/updater.ts')
    setupUpdates(host)
    await reachReady(host, updateActions)

    updateActions(host).install()
    await vi.waitFor(() => { expect(fixture.dialogs).toHaveLength(1) })

    expect(steps).toEqual(['prepareQuit', 'resume(false)'])
    // The one guarantee the refusal exists for: no installer ran.
    expect(fixture.installerStarts).toBe(0)
    expect(fixture.closedNotices).toBe(1)
    expect(fixture.dialogs).toEqual([`v${TO_VERSION} 没有开始安装`])
    expect(lines.join('')).toContain('teardown not confirmed, the installer was not started (UPDATE_STOP_INCOMPLETE)')
    // The verified download was never touched, so the same click can try again:
    // the phase goes back to ready and only the ownership of the candidate, not
    // the reported phase, keeps a check from replacing it.
    expect(updateActions(host).state()).toMatchObject({ phase: 'ready', latestVersion: TO_VERSION })
    // No installer read the receipt, so it must not claim an install happened.
    expect(receipt()).toBeUndefined()
  })

  it('starts no installer when the receipt cannot be written, and keeps the candidate', async () => {
    onPlatform('win32')
    // A user data directory that does not exist: every state write fails.
    fixture.userData = join(fixture.home, 'missing', 'userData')
    const { host, lines, steps } = recordingHost()
    const { setupUpdates, updateActions } = await import('../src/updater.ts')
    setupUpdates(host)
    await reachReady(host, updateActions)

    updateActions(host).install()
    await vi.waitFor(() => { expect(fixture.dialogs).toHaveLength(1) })

    expect(steps).toEqual([])
    expect(fixture.installerStarts).toBe(0)
    expect(fixture.dialogs).toEqual([`v${TO_VERSION} 没有开始安装`])
    expect(lines.join('')).toContain(`not handing ${TO_VERSION} to the installer: the install receipt could not be recorded`)
    // The downloaded update is still what a retry would take: the channel did
    // not forget it, and a check that runs before the retry cannot replace it.
    expect(updateActions(host).state()).toMatchObject({ phase: 'ready', latestVersion: TO_VERSION })
    expect(receipt()).toBeUndefined()
    fixture.info = {
      ...manifestFor('0.1.0-rc.36', 36, 'c'.repeat(40)),
      files: [{ url: INSTALLER, sha512: SHA512, size: ARTIFACT_SIZE }],
    }
    updateActions(host).check()
    await vi.waitFor(() => { expect(lines.join('')).toContain(`check while ${TO_VERSION} · 构建 35 waits to be installed`) })
    expect(updateActions(host).state()).toMatchObject({ phase: 'ready', latestVersion: TO_VERSION, latestBuild: 35 })
  })

  it('installs the same candidate once the receipt has somewhere to go', async () => {
    onPlatform('win32')
    // The first click finds no user data directory, so no receipt can be written.
    fixture.userData = join(fixture.home, 'missing', 'userData')
    const { host } = recordingHost()
    const { setupUpdates, updateActions } = await import('../src/updater.ts')
    setupUpdates(host)
    await reachReady(host, updateActions)

    updateActions(host).install()
    await vi.waitFor(() => { expect(fixture.dialogs).toHaveLength(1) })
    expect(fixture.installerStarts).toBe(0)

    // The cause is gone, and the click installs the candidate already on disk.
    fixture.installFails = false
    mkdirSync(fixture.userData, { recursive: true })
    updateActions(host).install()
    await vi.waitFor(() => { expect(fixture.installerStarts).toBe(1) })
    expect(receipt()).toMatchObject({ fileName: INSTALLER, sha512: SHA512 })
    expect(fixture.dialogs).toEqual([`v${TO_VERSION} 没有开始安装`])
  })
})

describe('the bytes a downloaded update must be', () => {
  /**
   * Run one check whose download does not raise its own event, so the case can
   * raise one with the file and digest it wants verified.
   * @returns the actions, the state and the record the module wrote.
   */
  async function reachDownloading(): Promise<{ actions: ReturnType<typeof import('../src/updater.ts').updateActions>; host: UpdateHost; lines: string[] }> {
    fixture.emitOnDownload = false
    const { host, lines } = recordingHost()
    const { setupUpdates, updateActions } = await import('../src/updater.ts')
    setupUpdates(host)
    const actions = updateActions(host)
    actions.check()
    await vi.waitFor(() => { expect(actions.state().phase).toBe('downloading') })
    return { actions, host, lines }
  }

  it('does not install a file the library downloaded under another name', async () => {
    onPlatform('win32')
    const { actions, lines } = await reachDownloading()
    const directory = join(fixture.home, 'staged')
    mkdirSync(directory, { recursive: true })
    const other = join(directory, 'other.exe')
    writeFileSync(other, ARTIFACT_BYTES)
    fixture.instances[0]?.emit('update-downloaded', { ...fixture.info, downloadedFile: other })
    await vi.waitFor(() => { expect(actions.state().phase).toBe('failed') })
    expect(actions.state().reason).toContain('instead of')
    expect(lines.join('')).toContain('not offering it for install')
    actions.install()
    expect(fixture.installerStarts).toBe(0)
  })

  it('does not install bytes whose digest is not the accepted one', async () => {
    onPlatform('win32')
    const { actions } = await reachDownloading()
    const directory = join(fixture.home, 'staged')
    mkdirSync(directory, { recursive: true })
    const tampered = Buffer.from(ARTIFACT_BYTES)
    tampered[0] = (tampered[0] ?? 0) + 1
    const file = join(directory, INSTALLER)
    writeFileSync(file, tampered)
    fixture.instances[0]?.emit('update-downloaded', { ...fixture.info, downloadedFile: file })
    await vi.waitFor(() => { expect(actions.state().phase).toBe('failed') })
    expect(actions.state().reason).toContain('SHA-512')
    actions.install()
    expect(fixture.installerStarts).toBe(0)
  })

  it('cannot be installed while its digest is still being read', async () => {
    onPlatform('win32')
    const { actions } = await reachDownloading()
    fixture.instances[0]?.emit('update-downloaded', { ...fixture.info, downloadedFile: stagedArtifact('win32') })
    // The read is still in flight, so nothing is installable yet — not even
    // for a caller that skips the service's own phase check.
    actions.install()
    expect(fixture.installerStarts).toBe(0)
    expect(actions.state().phase).not.toBe('ready')
    await vi.waitFor(() => { expect(actions.state().phase).toBe('ready') })
    actions.install()
    await vi.waitFor(() => { expect(fixture.installerStarts).toBe(1) })
  })

  it('keeps an unreadable file from becoming an installable update', async () => {
    onPlatform('win32')
    const { actions } = await reachDownloading()
    const directory = join(fixture.home, 'staged')
    mkdirSync(directory, { recursive: true })
    const file = join(directory, INSTALLER)
    writeFileSync(file, ARTIFACT_BYTES)
    // The length matches what the feed states, so only reading the bytes back
    // can decide — and this read fails.
    chmodSync(file, 0o000)
    fixture.instances[0]?.emit('update-downloaded', { ...fixture.info, downloadedFile: file })
    await vi.waitFor(() => { expect(actions.state().phase).toBe('failed') })
    expect(actions.state().reason).toContain('cannot be read')
    actions.install()
    expect(fixture.installerStarts).toBe(0)
  })
})

describe('one install at a time', () => {
  it('lets the first click own the receipt, the teardown, and the hand-off', async () => {
    onPlatform('win32')
    fixture.installFails = false
    let release: () => void = () => undefined
    fixture.stopGate = new Promise<void>((resolve) => { release = resolve })
    const { host, steps } = recordingHost()
    const { setupUpdates, updateActions } = await import('../src/updater.ts')
    setupUpdates(host)
    await reachReady(host, updateActions)
    const actions = updateActions(host)

    actions.install()
    await vi.waitFor(() => { expect(steps).toEqual(['prepareQuit']) })
    // While the server is still being stopped, another click must not write a
    // second receipt, stop it twice, or clear the receipt of the first attempt.
    actions.install()
    actions.install()
    release()
    await vi.waitFor(() => { expect(fixture.installerStarts).toBe(1) })

    expect(steps).toEqual(['prepareQuit'])
    expect(fixture.receiptAtInstaller).toMatchObject({ fileName: INSTALLER, sha512: SHA512 })
  })

  it('keeps the install owned while a failed attempt is still restoring the app', async () => {
    onPlatform('win32')
    fixture.stopFails = true
    let releaseRecovery: () => void = () => undefined
    fixture.resumeGate = new Promise<void>((resolve) => { releaseRecovery = resolve })
    const { host, steps } = recordingHost()
    const { setupUpdates, updateActions } = await import('../src/updater.ts')
    setupUpdates(host)
    await reachReady(host, updateActions)
    const actions = updateActions(host)

    actions.install()
    await vi.waitFor(() => { expect(steps).toEqual(['prepareQuit', 'resume(false)']) })
    // A click during the recovery would race the restore it depends on.
    actions.install()
    releaseRecovery()
    await vi.waitFor(() => { expect(fixture.dialogs).toHaveLength(1) })
    expect(steps).toEqual(['prepareQuit', 'resume(false)'])
    expect(fixture.installerStarts).toBe(0)

    // The lock ended with the recovery, so the retry installs for real.
    fixture.stopFails = false
    fixture.installFails = false
    actions.install()
    await vi.waitFor(() => { expect(fixture.installerStarts).toBe(1) })
    expect(steps).toEqual(['prepareQuit', 'resume(false)', 'prepareQuit'])
    expect(fixture.receiptAtInstaller).toMatchObject({ fileName: INSTALLER })
  })
})

describe('the mandatory block when the download cannot be accepted', () => {
  /**
   * Block the launch on a manifest whose download will not verify, and answer
   * the failure dialog with quit.
   * @param payload - what the library raises as the downloaded update.
   * @returns the run's host and log lines.
   */
  async function blockAndQuit(payload: Record<string, unknown>): Promise<{ host: UpdateHost; lines: string[] }> {
    onPlatform('win32')
    fixture.info = {
      ...manifestFor(TO_VERSION, 35, 'b'.repeat(40)),
      files: [{ url: INSTALLER, sha512: SHA512, size: ARTIFACT_SIZE }],
      minimumBuildSequence: 35,
    }
    fixture.installFails = false
    fixture.downloadPayloads = [payload]
    fixture.answers = [1]
    const { host, lines } = recordingHost()
    const { launchGate, updateActions } = await import('../src/updater.ts')
    expect(await launchGate(host, () => undefined)).toBe(true)
    await vi.waitFor(() => { expect(fixture.quits).toBe(1) })

    expect(fixture.installerStarts).toBe(0)
    expect(fixture.dialogs).toEqual(['必须安装的更新没有下载成功'])
    expect(updateActions(host).state().phase).toBe('failed')
    return { host, lines }
  }

  it('offers retry or quit when the downloaded bytes do not match', async () => {
    const tampered = Buffer.from(ARTIFACT_BYTES)
    tampered[0] = (tampered[0] ?? 0) + 1
    await blockAndQuit(stagedPayload('win32', tampered))
  })

  it('offers retry or quit when the downloaded build is not the frozen one', async () => {
    await blockAndQuit({
      ...manifestFor('0.1.0-rc.36', 36, 'c'.repeat(40)),
      downloadedFile: stagedArtifact('win32'),
    })
  })

  it('offers retry or quit when the downloaded file cannot be read', async () => {
    const payload = stagedPayload('win32')
    chmodSync(String(payload.downloadedFile), 0o000)
    await blockAndQuit(payload)
  })

  it('offers retry or quit if the ready file changes during mandatory consent', async () => {
    onPlatform('win32')
    fixture.info = { ...fixture.info, minimumBuildSequence: 35 }
    fixture.installFails = false
    fixture.answers = [0, 1]
    fixture.onDialog = (message) => {
      if (message.includes('已下载完毕')) {
        writeFileSync(join(fixture.home, 'staged', INSTALLER), Buffer.alloc(ARTIFACT_SIZE, 0))
      }
    }
    const { host, steps } = recordingHost()
    const { launchGate } = await import('../src/updater.ts')
    expect(await launchGate(host, () => undefined)).toBe(true)
    await vi.waitFor(() => { expect(fixture.quits).toBe(1) })
    expect(fixture.dialogs).toEqual([
      `v${TO_VERSION} 已下载完毕。重启安装后即可继续使用。`,
      '必须安装的更新没有下载成功',
    ])
    expect(steps).toEqual([])
    expect(fixture.installerStarts).toBe(0)
    expect(receipt()).toBeUndefined()
  })

  it('downloads again and installs when the retry succeeds', async () => {
    onPlatform('win32')
    fixture.info = {
      ...manifestFor(TO_VERSION, 35, 'b'.repeat(40)),
      files: [{ url: INSTALLER, sha512: SHA512, size: ARTIFACT_SIZE }],
      minimumBuildSequence: 35,
    }
    fixture.installFails = false
    const tampered = Buffer.from(ARTIFACT_BYTES)
    tampered[0] = (tampered[0] ?? 0) + 1
    fixture.downloadPayloads = [stagedPayload('win32', tampered)]
    fixture.answers = [0, 0]
    const { host } = recordingHost()
    const { launchGate } = await import('../src/updater.ts')

    expect(await launchGate(host, () => undefined)).toBe(true)
    await vi.waitFor(() => { expect(fixture.installerStarts).toBe(1) })

    expect(fixture.quits).toBe(1)
    expect(fixture.dialogs).toEqual([
      '必须安装的更新没有下载成功',
      `v${TO_VERSION} 已下载完毕。重启安装后即可继续使用。`,
    ])
    expect(fixture.receiptAtInstaller).toMatchObject({ fileName: INSTALLER })
  })
})


describe('ordinary install consent and Windows OS decisions', () => {
  async function ready(): Promise<ReturnType<typeof recordingHost> & { updater: typeof import('../src/updater.ts') }> {
    onPlatform('win32')
    fixture.info = { ...manifestFor(TO_VERSION, 35, 'b'.repeat(40)), files: [{ url: INSTALLER, sha512: SHA512, size: ARTIFACT_SIZE }] }
    fixture.installFails = false
    const recording = recordingHost()
    const updater = await import('../src/updater.ts')
    updater.setupUpdates(recording.host)
    updater.updateActions(recording.host).check()
    await vi.waitFor(() => { expect(updater.updateActions(recording.host).state().phase).toBe('ready') })
    return { ...recording, updater }
  }

  it('keeps the app and work intact on cancellation, with Cancel the default', async () => {
    const { updater, host, steps, lines } = await ready()
    fixture.confirmAnswer = 0
    updater.updateActions(host).install()
    await vi.waitFor(() => { expect(lines.join('')).toContain('install cancelled before teardown') })
    expect(fixture.confirmations[0]).toMatchObject({ defaultId: 0, cancelId: 0, buttons: ['取消', '停止任务并安装'] })
    expect(fixture.confirmations[0]?.detail).toContain('排队及关闭前新开始的工作')
    expect(steps).toEqual([])
    expect(fixture.installerStarts).toBe(0)
    expect(fixture.quits).toBe(0)
    expect(receipt()).toBeUndefined()
    expect(updater.updateActions(host).state().phase).toBe('ready')
    expect(existsSync(join(fixture.home, 'staged', INSTALLER))).toBe(true)
  })

  it('owns the attempt while confirmation is open and allows retry after cancellation', async () => {
    const { updater, host, steps, lines } = await ready()
    const consent = Promise.withResolvers<number>()
    fixture.confirmGate = consent.promise
    const actions = updater.updateActions(host)
    actions.install()
    actions.install()
    expect(fixture.confirmations).toHaveLength(1)
    expect(steps).toEqual([])
    expect(receipt()).toBeUndefined()
    consent.resolve(0)
    await vi.waitFor(() => { expect(lines.join('')).toContain('install cancelled before teardown') })
    fixture.confirmGate = undefined
    actions.install()
    await vi.waitFor(() => { expect(fixture.quits).toBe(1) })
    expect(fixture.confirmations).toHaveLength(2)
    expect(fixture.installerStarts).toBe(1)
  })

  it('does not stop work if native confirmation cannot open', async () => {
    const { updater, host, steps, lines } = await ready()
    fixture.confirmFails = true
    updater.updateActions(host).install()
    await vi.waitFor(() => { expect(lines.join('')).toContain('install confirmation unavailable') })
    expect(steps).toEqual([])
    expect(fixture.installerStarts).toBe(0)
    expect(receipt()).toBeUndefined()
    expect(updater.updateActions(host).state().phase).toBe('ready')
  })

  it('holds ordinary quit until the OS result, recovers rejection and retries the same candidate', async () => {
    const { updater, host, steps } = await ready()
    const launch = Promise.withResolvers<WindowsInstallResult>()
    fixture.launchGate = launch.promise
    updater.updateActions(host).install()
    await vi.waitFor(() => { expect(fixture.installerStarts).toBe(1) })
    const event = { preventDefault: vi.fn() }
    expect(updater.deferQuitForInstall(event)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(fixture.quits).toBe(0)
    expect(steps).toEqual(['prepareQuit'])
    expect(receipt()).toBeDefined()
    launch.resolve({ kind: 'not-started', code: 1223, detail: 'UAC declined' })
    await vi.waitFor(() => { expect(fixture.dialogs).toEqual([`v${TO_VERSION} 没有开始安装`]) })
    expect(updater.deferQuitForInstall(event)).toBe(false)
    expect(receipt()).toBeUndefined()
    expect(steps).toEqual(['prepareQuit', 'resume(false)'])
    expect(fixture.quits).toBe(0)
    expect(updater.updateActions(host).state().phase).toBe('ready')
    fixture.launchGate = undefined
    updater.updateActions(host).install()
    await vi.waitFor(() => { expect(fixture.quits).toBe(1) })
    expect(fixture.installerStarts).toBe(2)
    expect(fixture.receiptAtInstaller).toMatchObject({ fileName: INSTALLER, sha512: SHA512 })
  })

  it('keeps an uncertain launch owned without false recovery, success or automatic retry', async () => {
    const { updater, host, steps } = await ready()
    fixture.launchGate = Promise.resolve({ kind: 'unconfirmed', detail: 'transport lost after launch' })
    const actions = updater.updateActions(host)
    actions.install()
    await vi.waitFor(() => { expect(fixture.dialogs).toEqual(['无法确认系统安装器是否已经启动']) })
    expect(steps).toEqual(['prepareQuit'])
    expect(receipt()).toBeDefined()
    expect(fixture.quits).toBe(0)
    expect(updater.deferQuitForInstall({ preventDefault: vi.fn() })).toBe(false)
    actions.install()
    expect(fixture.installerStarts).toBe(1)
  })

  it('retains ownership while a rejected install is still recovering', async () => {
    const { updater, host, steps } = await ready()
    fixture.installFails = true
    const recovery = Promise.withResolvers<undefined>()
    fixture.resumeGate = recovery.promise
    const actions = updater.updateActions(host)
    actions.install()
    await vi.waitFor(() => { expect(steps).toEqual(['prepareQuit', 'resume(false)']) })
    actions.install()
    expect(fixture.installerStarts).toBe(1)
    recovery.resolve(undefined)
    await vi.waitFor(() => { expect(fixture.dialogs).toHaveLength(1) })
    fixture.resumeGate = undefined
    fixture.installFails = false
    actions.install()
    await vi.waitFor(() => { expect(fixture.quits).toBe(1) })
    expect(fixture.installerStarts).toBe(2)
  })

  it('rejects a file changed after acceptance before teardown or elevation', async () => {
    const { updater, host, steps } = await ready()
    const tampered = Buffer.from(ARTIFACT_BYTES)
    tampered[0] = (tampered[0] ?? 0) + 1
    writeFileSync(join(fixture.home, 'staged', INSTALLER), tampered)
    updater.updateActions(host).install()
    await vi.waitFor(() => { expect(updater.updateActions(host).state().phase).toBe('failed') })
    expect(steps).toEqual([])
    expect(fixture.installerStarts).toBe(0)
    expect(receipt()).toBeUndefined()
  })
})
