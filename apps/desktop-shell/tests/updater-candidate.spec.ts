/**
 * The one comparison this product owns, exercised through the real update
 * library: `electron-updater`'s own `checkForUpdates`, `getUpdateInfoAndProvider`
 * and `isUpdateAvailable` run unmodified against a local v2 feed, and only what
 * the library obtains from the outside world is replaced — the Electron app
 * adapter it would read the running version from, its HTTP transport (electrons
 * `net` in a real process), and the download terminal.
 *
 * That is what makes these cases evidence about the patch rather than about a
 * stand-in: the candidate callback sits behind the library's system and rollout
 * checks, and the answer it gives is the answer the shell acts on.
 * @module
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump } from 'js-yaml'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpExecutor, type AllPublishOptions, type UpdateFileInfo, type UpdateInfo } from 'builder-util-runtime'
import { findFile, resolveFiles } from 'electron-updater/out/providers/Provider.js'
import { MacUpdater as RealMacUpdater } from 'electron-updater/out/MacUpdater.js'
import type { ResolvedUpdateFileInfo } from 'electron-updater'
import { ReleaseIdentityError, parseUpdateOffer, type ReleaseIdentity } from '../src/release-identity.ts'
import type { UpdateHost } from '../src/updater.ts'

/** The build this installation runs in most cases: the first standard build. */
const RUNNING = '0.1.0-rc.1'

/** The next build of the same application version. */
const NEXT_BUILD_OF_SAME_VERSION = 102

/** The running build's sequence, matching [[RUNNING]]. */
const RUNNING_BUILD = 101

/** Two full Git object names; the library compares none of them, this product does. */
const RUNNING_REVISION = 'a'.repeat(40)
const NEXT_REVISION = 'b'.repeat(40)

/** A pattern-valid base64 SHA-512; nothing here transfers the bytes. */
const SHA512 = 'A'.repeat(86) + '=='

/** The artifact a manifest lists. */
const ARTIFACT = 'DSH Desktop-0.1.0-rc.1-b102-arm64-mac.zip'

/**
 * What the app adapter and the download terminal read. Hoisted because the mock
 * factory runs before this file's own initializers.
 */
const fixture = vi.hoisted(() => ({
  /** The temporary directory every path is derived from. */
  home: '',
  /** What `app.getAppPath()` answers; the build's `package.json` sits directly under it. */
  appPath: '',
  /** What the app adapter reports as the running application version. */
  version: '',
  /** Every v2 path the library requested, in order. */
  requests: [] as string[],
  /** How many times the download terminal was asked to transfer. */
  downloads: 0,
  /** The manifest document the local feed answers with; undefined for a 404. */
  feedDocument: undefined as string | undefined,
  /** The status the local feed answers with. */
  feedStatus: 200,
  /** Every dialog the run put up, in order. */
  dialogs: [] as { message?: unknown; detail?: unknown }[],
  /** What the app registered for `before-quit`, which stops its timers. */
  beforeQuit: [] as (() => void)[],
}))

/**
 * A Node HTTP transport for the library's executor, which in a real process
 * rides Electron's `net` module. Nothing else of the library is replaced.
 */
class NodeExecutor extends HttpExecutor<ClientRequest> {
  /**
   * @param options - the request options the executor prepared.
   * @param callback - receives the response.
   * @returns the client request, to be ended by the executor.
   */
  createRequest(options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest {
    return httpRequest(options, callback)
  }
}

vi.mock('electron-updater', async (importOriginal) => {
  const actual = await importOriginal<typeof import('electron-updater')>()
  const adapter = {
    get version(): string { return fixture.version },
    name: 'DSH Desktop',
    isPackaged: true,
    get appUpdateConfigPath(): string { return join(fixture.home, 'app-update.yml') },
    get userDataPath(): string { return join(fixture.home, 'userData') },
    get baseCachePath(): string { return join(fixture.home, 'Caches') },
    whenReady: async (): Promise<void> => undefined,
    relaunch: (): void => undefined,
    quit: (): void => undefined,
    onQuit: (): void => undefined,
  }
  /**
   * The real library class, given an app adapter and a Node transport instead
   * of Electron's two, so its own check runs here unmodified.
   */
  class TestUpdater extends actual.AppUpdater {
    constructor(options: AllPublishOptions) {
      super(options, adapter)
      // The library keeps its HTTP executor off the declaration surface this
      // test compiles against, so the one member the test replaces is written
      // through Object.assign rather than a typed assignment.
      Object.assign(this, { httpExecutor: new NodeExecutor() })
      this.setFeedURL(options)
      // The download terminal: a transfer is not what these cases observe.
      this.downloadUpdate = async (): Promise<string[]> => {
        fixture.downloads += 1
        return []
      }
    }

    protected async doDownloadUpdate(): Promise<string[]> { return [] }

    quitAndInstall(): void { /* Nothing replaces the application in a unit process. */ }
  }
  return { MacUpdater: TestUpdater, NsisUpdater: TestUpdater }
})

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
    quit: (): void => undefined,
    dock: undefined,
  },
  BrowserWindow: { getAllWindows: (): unknown[] => [], getFocusedWindow: (): unknown => null },
  dialog: {
    showMessageBox: async (options: { message?: unknown; detail?: unknown }): Promise<{ response: number }> => {
      fixture.dialogs.push(options)
      return { response: 0 }
    },
  },
  Menu: { setApplicationMenu: (): void => undefined, buildFromTemplate: (template: unknown): unknown => template },
  nativeTheme: { shouldUseDarkColors: false },
  shell: { openExternal: async (): Promise<void> => undefined },
}))

/** The platform this process reports outside these cases. */
const realPlatform = process.platform

/** The feed this process names outside these cases. */
const realFeed = process.env.DSH_UPDATE_FEED

/** The local feed server, standing in for the published one. */
let server: Server

beforeAll(async () => {
  // The whole check path here is macOS: one in-place tier, one candidate.
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    fixture.requests.push(path)
    if (fixture.feedStatus !== 200) {
      response.writeHead(fixture.feedStatus)
      response.end()
      return
    }
    if (fixture.feedDocument === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/yaml' })
    response.end(fixture.feedDocument)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  // The root address, exactly as a deployment or a test sets it: the protocol's
  // own path is what the module appends.
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
  fixture.home = mkdtempSync(join(tmpdir(), 'dsh-candidate-'))
  mkdirSync(join(fixture.home, 'userData'))
  mkdirSync(join(fixture.home, 'Caches'))
  const signature = join(fixture.home, 'DSH Desktop.app', 'Contents', '_CodeSignature')
  mkdirSync(signature, { recursive: true })
  writeFileSync(join(signature, 'CodeResources'), '<plist/>\n')
  fixture.appPath = join(fixture.home, 'app')
  mkdirSync(fixture.appPath, { recursive: true })
  fixture.requests.length = 0
  fixture.downloads = 0
  fixture.feedDocument = undefined
  fixture.feedStatus = 200
  fixture.dialogs.length = 0
  fixture.version = RUNNING
})

afterEach(() => {
  for (const listener of fixture.beforeQuit.splice(0)) listener()
  rmSync(fixture.home, { recursive: true, force: true })
})

/**
 * The identity one build declares, as a standard build states it.
 * @param version - its application version, which is also its runtime.
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
 * Make the installation declare one build, as its packaged `package.json` does.
 * @param declared - the identity to embed.
 */
function install(declared: ReleaseIdentity): void {
  fixture.version = declared.version
  writeFileSync(join(fixture.appPath, 'package.json'), JSON.stringify({ name: 'DSH Desktop', ...declared }))
}

/**
 * Publish one manifest on the local feed.
 * @param version - the offered application version.
 * @param build - the offered build sequence.
 * @param extra - fields the manifest carries beyond its identity.
 */
function publish(version: string, build: number, extra: Record<string, unknown> = {}, revision = NEXT_REVISION): void {
  fixture.feedDocument = dump({
    version,
    dshRelease: identity(version, build, revision).dshRelease,
    files: [{ url: ARTIFACT, sha512: SHA512, size: 123_456_789 }],
    path: ARTIFACT,
    releaseDate: '2026-09-11T00:00:00.000Z',
    releaseNotes: 'fixes the thing',
    ...extra,
  })
}

/**
 * The real macOS updater's protected static architecture filter, reachable
 * through a subclass. The filter is what `MacUpdater.doDownloadUpdate` runs
 * over every resolved entry, before it looks for the archive extension.
 */
class ArchFilteringMacUpdater extends RealMacUpdater {
  /**
   * @param files - the resolved manifest entries.
   * @param isArm64Mac - whether the library treats this machine as arm64.
   * @returns the entries the library keeps.
   */
  static forArch(files: ResolvedUpdateFileInfo[], isArm64Mac: boolean): ResolvedUpdateFileInfo[] {
    return ArchFilteringMacUpdater.filterFilesForArch(files, isArm64Mac)
  }
}

/**
 * What the real update library would download for one manifest, using its own
 * `resolveFiles`, macOS architecture filter and `findFile` — the rules the
 * shell's parser has to agree with.
 * @param files - the manifest's entries.
 * @param platform - the platform downloading.
 * @param arm64 - whether the library treats the machine as arm64.
 * @returns the URL the library picks, or undefined when it finds none.
 */
function librarySelection(files: UpdateFileInfo[], platform: 'darwin' | 'win32', arm64: boolean): string | undefined {
  // `resolveFiles` reads only `files`; the deprecated top-level `path`/`sha512`
  // pair predates `files[]` and carries nothing this reference reads.
  const info = { version: RUNNING, files, releaseDate: '2026-09-11T00:00:00.000Z' } as UpdateInfo
  const resolved = resolveFiles(info, new URL('https://feed.invalid/v2/mac/'))
  if (platform === 'win32') return findFile(resolved, 'exe')?.info.url
  return findFile(ArchFilteringMacUpdater.forArch(resolved, arm64), 'zip', ['pkg', 'dmg'])?.info.url
}

/**
 * A manifest the shell's parser reads, carrying one build's identity.
 * @param files - the entries the real library is asked to select from.
 * @returns the parsed document a manifest read yields.
 */
function offerManifest(files: UpdateFileInfo[]): Record<string, unknown> {
  return {
    version: RUNNING,
    dshRelease: identity(RUNNING, RUNNING_BUILD, RUNNING_REVISION).dshRelease,
    files: files.map(file => ({ ...file })),
    path: files[0]?.url ?? '',
  }
}

/** A log sink a case can wait on, so nothing polls for a check to finish. */
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

/** What one check left behind. */
interface CheckRun {
  /** The state the channel reports. */
  state: () => { phase: string; latestVersion?: string; latestBuild?: number; reason?: string }
  /** The lines the updater wrote. */
  lines: string[]
  /** The manual check, which answers through a dialog. */
  manual: () => void
}

/**
 * Run one check through the module and wait for the answer it logs.
 * @param answer - the fragment a finished check writes; `no update:` for "nothing to install".
 * @returns the run, for the assertions that follow.
 */
async function runCheck(answer = 'no update:'): Promise<CheckRun> {
  const { host, lines, waitFor } = sink()
  const { setupUpdates, updateActions } = await import('../src/updater.ts')
  const actions = updateActions(host)
  const manual = setupUpdates(host)
  actions.check()
  await waitFor(answer)
  return { state: () => actions.state(), lines, manual }
}

describe('the candidate the library accepts', () => {
  it('downloads the next build of the same application version (U01)', async () => {
    install(identity(RUNNING, RUNNING_BUILD, RUNNING_REVISION))
    publish(RUNNING, NEXT_BUILD_OF_SAME_VERSION)

    const run = await runCheck('in the background')

    expect(fixture.downloads).toBe(1)
    expect(run.state()).toMatchObject({
      phase: 'downloading',
      latestVersion: RUNNING,
      latestBuild: NEXT_BUILD_OF_SAME_VERSION,
    })
    // The manifest came from the protocol's own path, not from the old source.
    expect(fixture.requests).toEqual(['/v2/mac/latest-mac.yml'])
  })

  it('treats the same build, and an older one, as nothing to download (U02)', async () => {
    install(identity(RUNNING, RUNNING_BUILD, RUNNING_REVISION))
    // The very same build, down to the source commit: nothing to install.
    publish(RUNNING, RUNNING_BUILD, {}, RUNNING_REVISION)
    const same = await runCheck()
    expect(fixture.downloads).toBe(0)
    expect(same.state().latestVersion).toBeUndefined()

    vi.resetModules()
    fixture.requests.length = 0
    install(identity(RUNNING, RUNNING_BUILD, RUNNING_REVISION))
    publish(RUNNING, RUNNING_BUILD - 1)
    const older = await runCheck()
    expect(fixture.downloads).toBe(0)
    expect(older.state().latestVersion).toBeUndefined()
  })

  it('fails on one sequence naming two different builds instead of calling it no update (U03)', async () => {
    install(identity(RUNNING, RUNNING_BUILD, RUNNING_REVISION))
    // Same sequence, different revision: a publisher error, and accepting
    // either would make "which build is newer" depend on which feed answered.
    fixture.feedDocument = dump({
      version: RUNNING,
      dshRelease: identity(RUNNING, RUNNING_BUILD, NEXT_REVISION).dshRelease,
      files: [{ url: ARTIFACT, sha512: SHA512, size: 123_456_789 }],
    })

    const run = await runCheck('check failed:')

    expect(run.state()).toMatchObject({ phase: 'failed', reason: 'RELEASE_IDENTITY_CONFLICT' })
    expect(fixture.downloads).toBe(0)
  })

  it('accepts a standard build that lowers the application version of a bridge (U04)', async () => {
    // The bridge carries the higher application version and the upstream runtime;
    // the standard build returns to the upstream version with a higher sequence.
    install({
      version: '0.1.0-rc.4',
      dshRelease: {
        schemaVersion: 2, runtimeVersion: RUNNING, buildSequence: 100, revision: RUNNING_REVISION, kind: 'bridge',
      },
    })
    publish(RUNNING, RUNNING_BUILD)

    const run = await runCheck('in the background')

    expect(fixture.downloads).toBe(1)
    expect(run.state()).toMatchObject({ latestVersion: RUNNING, latestBuild: RUNNING_BUILD })
  })

  it('refuses a bridge the v2 feed should never deliver (U05)', async () => {
    install(identity(RUNNING, RUNNING_BUILD, RUNNING_REVISION))
    fixture.feedDocument = dump({
      version: '0.1.0-rc.4',
      dshRelease: {
        schemaVersion: 2, runtimeVersion: RUNNING, buildSequence: RUNNING_BUILD + 1, revision: NEXT_REVISION, kind: 'bridge',
      },
      files: [{ url: ARTIFACT, sha512: SHA512, size: 123_456_789 }],
    })

    const run = await runCheck('check failed:')

    expect(run.state()).toMatchObject({ phase: 'failed', reason: 'UPDATE_MANIFEST_INVALID' })
    expect(fixture.downloads).toBe(0)
  })

  it('refuses a higher build that would reinstall an older runtime (U05)', async () => {
    // The running build embeds rc.2; the feed offers a higher sequence whose
    // runtime is rc.1. Only the runtime went backwards, which no sequence may
    // excuse.
    install(identity('0.1.0-rc.2', RUNNING_BUILD, RUNNING_REVISION))
    publish('0.1.0-rc.1', RUNNING_BUILD + 1)

    const run = await runCheck('check failed:')

    expect(run.state()).toMatchObject({ phase: 'failed', reason: 'RUNTIME_ROLLBACK_REJECTED' })
    expect(fixture.downloads).toBe(0)
  })
})

describe('the checks the library owns', () => {
  it('downloads nothing when the library refuses the system the update needs (U08)', async () => {
    install(identity(RUNNING, RUNNING_BUILD, RUNNING_REVISION))
    publish(RUNNING, NEXT_BUILD_OF_SAME_VERSION, { minimumSystemVersion: '99.0.0' })

    const run = await runCheck()

    expect(fixture.downloads).toBe(0)
    expect(run.state().latestVersion).toBeUndefined()
    // The shell did not read the raw feed to overrule the library; the one
    // request is the library's own manifest read.
    expect(fixture.requests).toEqual(['/v2/mac/latest-mac.yml'])
  })

  it('downloads nothing when the user is outside the rollout (U08)', async () => {
    install(identity(RUNNING, RUNNING_BUILD, RUNNING_REVISION))
    publish(RUNNING, NEXT_BUILD_OF_SAME_VERSION, { stagingPercentage: 0 })

    const run = await runCheck()

    expect(fixture.downloads).toBe(0)
    expect(run.state().latestVersion).toBeUndefined()
    expect(fixture.requests).toEqual(['/v2/mac/latest-mac.yml'])
  })

  it('reports a candidate callback that throws as a failed check, never as “up to date” (U10)', async () => {
    install(identity(RUNNING, RUNNING_BUILD, RUNNING_REVISION))
    // A v2 manifest without the release identity: the callback refuses it.
    fixture.feedDocument = dump({
      version: RUNNING,
      files: [{ url: ARTIFACT, sha512: SHA512, size: 123_456_789 }],
    })

    const run = await runCheck('check failed:')

    expect(run.state()).toMatchObject({ phase: 'failed', reason: 'RELEASE_IDENTITY_INVALID' })
    expect(fixture.downloads).toBe(0)
  })

  it('answers a manual check with the failure rather than 已是最新版本 (U10)', async () => {
    install(identity(RUNNING, RUNNING_BUILD, RUNNING_REVISION))
    fixture.feedDocument = dump({ version: RUNNING, files: [] })
    const { host } = sink()
    const { setupUpdates } = await import('../src/updater.ts')
    const manual = setupUpdates(host)

    manual()
    await vi.waitFor(() => { expect(fixture.dialogs).toHaveLength(1) })

    expect(fixture.dialogs[0]?.message).toBe('无法检查更新')
    expect(fixture.dialogs[0]?.detail).toContain('错误码:RELEASE_IDENTITY_INVALID')
  })

  it('does not fall back to the old source when the v2 feed is unreachable (U20)', async () => {
    install(identity(RUNNING, RUNNING_BUILD, RUNNING_REVISION))
    fixture.feedStatus = 404

    const run = await runCheck('check failed:')

    expect(run.state().phase).toBe('failed')
    expect(fixture.downloads).toBe(0)
    // Every request stayed under the v2 path: the old `/mac` source was never
    // read, so a v2 outage cannot silently resume the protocol it replaced.
    expect(fixture.requests.length).toBeGreaterThan(0)
    expect(fixture.requests.every(path => path.startsWith('/v2/mac/'))).toBe(true)
  })
})

describe('the artifact the real library would download', () => {
  it('matches the shell’s frozen artifact for both macOS architectures (R7)', () => {
    const files: UpdateFileInfo[] = [
      { url: 'DSH Desktop-0.1.0-rc.1-b102-arm64.dmg', sha512: SHA512, size: 4096 },
      { url: 'DSH Desktop-0.1.0-rc.1-b102-x64-mac.zip', sha512: SHA512, size: 2048 },
      { url: 'DSH Desktop-0.1.0-rc.1-b102-arm64-mac.zip', sha512: SHA512, size: 1024 },
    ]
    for (const [arch, arm64, expected] of [
      ['arm64', true, 'DSH Desktop-0.1.0-rc.1-b102-arm64-mac.zip'],
      ['x64', false, 'DSH Desktop-0.1.0-rc.1-b102-x64-mac.zip'],
    ] as const) {
      expect(librarySelection(files, 'darwin', arm64)).toBe(expected)
      expect(parseUpdateOffer(offerManifest(files), 'darwin', arch).artifact.fileName).toBe(expected)
    }
  })

  it('refuses the manifest whose first entry the library would download (R7)', () => {
    const files: UpdateFileInfo[] = [
      { url: 'https://other.invalid/unvalidated.exe', sha512: SHA512, size: 1024 },
      { url: 'DSH Desktop Setup 0.1.0-rc.1.exe', sha512: SHA512, size: 1024 },
    ]
    // The library does not care where a URL points: it takes the first `.exe`,
    // which is exactly the entry a shell that skipped an invalid one would miss.
    expect(librarySelection(files, 'win32', false)).toBe('https://other.invalid/unvalidated.exe')
    expect(() => parseUpdateOffer(offerManifest(files), 'win32', 'x64')).toThrow(ReleaseIdentityError)
  })

  it('refuses an architecture mix that leaves the library no archive (R7)', () => {
    const files: UpdateFileInfo[] = [
      { url: 'DSH Desktop-0.1.0-rc.1-b102-arm64.dmg', sha512: SHA512, size: 4096 },
      { url: 'DSH Desktop-0.1.0-rc.1-b102-x64-mac.zip', sha512: SHA512, size: 2048 },
    ]
    // The library filters the whole list by architecture first: on arm64 the
    // x64 zip is gone and the remaining dmg is not an archive it downloads.
    expect(librarySelection(files, 'darwin', true)).toBeUndefined()
    expect(() => parseUpdateOffer(offerManifest(files), 'darwin', 'arm64')).toThrow(ReleaseIdentityError)
  })

  it('refuses names the library would fetch but could not cache as the shell froze them (R7)', () => {
    for (const entry of ['x%2fescape.zip', 'payload#other.zip']) {
      const files: UpdateFileInfo[] = [{ url: entry, sha512: SHA512, size: 1024 }]
      // The library resolves the raw entry and takes it; the encoded slash
      // decodes into a path when it names the cached file, and the fragment
      // leaves the downloaded path without the `.zip` suffix.
      expect(librarySelection(files, 'darwin', true)).toBe(entry)
      expect(() => parseUpdateOffer(offerManifest(files), 'darwin', 'arm64')).toThrow(ReleaseIdentityError)
    }
  })

  it('refuses two candidates where the library would silently take the first (R7)', () => {
    const files: UpdateFileInfo[] = [
      { url: 'a-x64.exe', sha512: SHA512, size: 1024 },
      { url: 'b-x64.exe', sha512: SHA512, size: 2048 },
    ]
    expect(librarySelection(files, 'win32', false)).toBe('a-x64.exe')
    expect(() => parseUpdateOffer(offerManifest(files), 'win32', 'x64')).toThrow(ReleaseIdentityError)
  })
})
