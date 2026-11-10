/**
 * The patched library honours the differential pair this shell verifies.
 *
 * The library's own sources are the ones a packaged build runs, so this suite
 * loads `electron-updater` from `node_modules` rather than standing it in: the
 * question is whether the patch actually reads the two paths it is handed, not
 * whether this repository can call a method. A local executor answers the one
 * request the difference needs, so every case stays a pure unit test — no port,
 * no socket, no timing.
 *
 * What the cases pin down: the old artifact is read from the given path, the old
 * blockmap is read from the given file instead of the cache directory's
 * `current.blockmap`, only the blocks that differ are transferred, and anything
 * unusable becomes the library's existing full-download answer rather than a
 * false success.
 * @module
 */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { CancellationToken, HttpExecutor, type UpdateInfo } from 'builder-util-runtime'
import { NsisUpdater } from 'electron-updater'
import { ElectronHttpExecutor } from 'electron-updater/out/ElectronHttpExecutor.js'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater.js'
import { DownloadedUpdateHelper } from 'electron-updater/out/DownloadedUpdateHelper.js'
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider.js'
import type { Provider } from 'electron-updater/out/providers/Provider.js'
import type { ResolvedUpdateFileInfo } from 'electron-updater/out/types.js'
import { afterEach, describe, expect, it } from 'vitest'

/** One block of both artifacts, which is also the blockmap's granularity. */
const BLOCK = 4_096

/** The blocks both artifacts share, so they are copied rather than downloaded. */
const SHARED = Buffer.alloc(BLOCK * 3, 7)

/** The bytes only the candidate has. */
const CHANGED = Buffer.alloc(BLOCK, 9)

/** The candidate's whole artifact. */
const NEW_BYTES = Buffer.concat([SHARED, CHANGED])

/** The installed artifact: the same shared blocks and different last bytes. */
const OLD_BYTES = Buffer.concat([SHARED, Buffer.alloc(BLOCK, 3)])

/** The artifact's published name, which is what the blockmap URL is derived from. */
const ARTIFACT = 'DSH.bin'

/** A logger that drops every line, as the library's own type wants. */
const QUIET = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

/** Directories one case created, removed by the shared teardown. */
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * The feed executor a provider is constructed with.
 *
 * The differential path never sends a request through it — the blockmap URLs
 * come from `GenericProvider`'s own address rules and the bytes come from the
 * updater's executor — so the instance is created without electron's session.
 * @returns a value of the executor type the provider option declares.
 */
function providerExecutor(): ElectronHttpExecutor {
  return Object.create(ElectronHttpExecutor.prototype) as ElectronHttpExecutor
}

/**
 * A directory this case owns.
 * @returns the absolute path.
 */
function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-library-diff-'))
  directories.push(directory)
  return directory
}

/**
 * Create a directory and its parents.
 * @param path - the directory to create.
 */
function mkdirp(path: string): void {
  mkdirSync(path, { recursive: true })
}

/**
 * The base64 SHA-512 of some bytes.
 * @param bytes - the bytes to hash.
 * @returns the digest, as a manifest states it.
 */
function digest(bytes: Buffer): string {
  return createHash('sha512').update(bytes).digest('base64')
}

/**
 * One artifact's blockmap, as electron-builder writes it: gzipped JSON with a
 * checksum and a length per block.
 * @param bytes - the artifact to describe.
 * @returns the gzipped document.
 */
function blockmapOf(bytes: Buffer): Buffer {
  const checksums: string[] = []
  const sizes: number[] = []
  for (let offset = 0; offset < bytes.length; offset += BLOCK) {
    const block = bytes.subarray(offset, Math.min(offset + BLOCK, bytes.length))
    checksums.push(createHash('sha256').update(block).digest('base64'))
    sizes.push(block.byteLength)
  }
  return gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, checksums, sizes }] }))
}

/** The request object this executor hands back, as the differential downloader ends it. */
type FakeRequest = PassThrough & { abort: () => void }

/** One request the case saw. */
interface SeenRequest {
  /** The path asked for. */
  readonly path: string
  /** The `Range` header, when the request carried one. */
  readonly range: string | undefined
}

/**
 * An HTTP executor that answers from memory and records what was asked for.
 *
 * The differential downloader sends one request per changed block and derives
 * the body it wants from `Content-Range`, so the answer has to look like a range
 * response rather than like a whole file.
 */
class MemoryExecutor extends HttpExecutor<FakeRequest> {
  /** Every ranged request this executor answered, in order. */
  readonly seen: SeenRequest[] = []

  /** Every whole-file read this executor answered, in order. */
  readonly read: string[] = []

  /**
   * @param routes - the body each path answers with.
   */
  constructor(private readonly routes: ReadonlyMap<string, Buffer>) {
    super()
  }

  /**
   * Answer one request from the routes.
   * @param options - the outgoing request.
   * @param callback - receives the response stream.
   * @returns a request the caller ends; the answer is already queued.
   */
  createRequest(
    options: { path?: string; headers?: Record<string, string | number> },
    callback: (response: PassThrough) => void,
  ): FakeRequest {
    const path = options.path ?? ''
    const header = String(options.headers?.Range ?? options.headers?.range ?? '')
    this.seen.push({ path, range: header === '' ? undefined : header })
    const request: FakeRequest = Object.assign(new PassThrough(), { abort: () => {}, end: () => {} })
    const body = this.routes.get(path)
    if (body === undefined) {
      queueMicrotask(() => { request.emit('error', new Error(`no route for ${path}`)) })
      return request
    }
    const asked = /bytes=(\d+)-(\d*)/u.exec(header)
    const start = asked === null ? 0 : Number(asked[1])
    const stop = asked === null || asked[2] === '' ? body.byteLength - 1 : Number(asked[2])
    const response = Object.assign(new PassThrough(), {
      statusCode: asked === null ? 200 : 206,
      headers: {
        'content-length': String(stop - start + 1),
        ...asked === null ? {} : { 'content-range': `bytes ${String(start)}-${String(stop)}/${String(body.byteLength)}` },
      },
    })
    queueMicrotask(() => { response.end(body.subarray(start, stop + 1)) })
    callback(response)
    return request
  }

  override addErrorAndTimeoutHandlers(): void {}

  /**
   * Answer a whole-file read, which is how the candidate's blockmap arrives.
   * @param url - the file to read.
   * @returns its bytes.
   */
  override async downloadToBuffer(url: URL): Promise<Buffer> {
    this.read.push(url.pathname)
    const body = this.routes.get(url.pathname)
    if (body === undefined) throw new Error(`no route for ${url.pathname}`)
    return body
  }
}

/**
 * The updater's own implementation, reachable from a subclass.
 *
 * `differentialDownloadInstaller` is protected because only the platform
 * updaters call it; this subclass is the seam the suite drives it through.
 */
class ProbeUpdater extends NsisUpdater {
  /**
   * Run the library's differential attempt for one candidate.
   * @param fileInfo - the candidate's artifact.
   * @param options - the download this attempt belongs to.
   * @param target - where the difference is written.
   * @param provider - the feed the blockmaps are addressed by.
   * @param oldName - the cache name the library would otherwise use.
   * @returns true when the caller must download in full.
   */
  attempt(
    fileInfo: ResolvedUpdateFileInfo,
    options: DownloadUpdateOptions,
    target: string,
    provider: Provider<UpdateInfo>,
    oldName: string,
  ): Promise<boolean> {
    return this.differentialDownloadInstaller(fileInfo, options, target, provider, oldName)
  }
}

/** Everything one case needs to run, and the paths it may damage first. */
interface Harness {
  /** The updater under test. */
  readonly updater: ProbeUpdater
  /** The candidate's artifact entry. */
  readonly fileInfo: ResolvedUpdateFileInfo
  /** The feed provider the blockmaps are addressed by. */
  readonly provider: Provider<UpdateInfo>
  /** The in-memory executor. */
  readonly executor: MemoryExecutor
  /** Where the difference is written. */
  readonly target: string
  /** The library's own cache directory, which must not decide what is used. */
  readonly cacheDir: string
  /** The kept artifact, which cases replace or remove. */
  readonly oldFile: string
  /** The kept blockmap, which cases replace. */
  readonly oldBlockmap: string
  /**
   * Run the differential attempt with the kept pair.
   * @returns true when the library fell back to a full download.
   */
  run: () => Promise<boolean>
}

/**
 * The manifest entry the library reads a download from.
 * @returns an update info naming the candidate.
 */
function updateInfo(): UpdateInfo {
  return {
    version: '0.2.2-rc.1',
    files: [{ url: ARTIFACT, sha512: digest(NEW_BYTES), size: NEW_BYTES.byteLength }],
    path: ARTIFACT,
    sha512: digest(NEW_BYTES),
    releaseDate: '2026-11-10T00:00:00.000Z',
  }
}

/**
 * Build one case: a kept artifact and blockmap, and an updater pointed at an
 * in-memory feed serving the candidate and its blockmap.
 * @returns the harness.
 */
function buildHarness(): Harness {
  const root = workspace()
  const kept = join(root, 'dsh-differential')
  const cacheDir = join(root, 'cache')
  const oldFile = join(kept, 'baseline.artifact')
  const oldBlockmap = join(kept, 'baseline.blockmap')
  mkdirp(kept)
  writeFileSync(oldFile, OLD_BYTES)
  writeFileSync(oldBlockmap, blockmapOf(OLD_BYTES))
  const routes = new Map<string, Buffer>([
    [`/${ARTIFACT}.blockmap`, blockmapOf(NEW_BYTES)],
    [`/${ARTIFACT}`, NEW_BYTES],
  ])
  const executor = new MemoryExecutor(routes)
  const app = {
    name: 'test',
    version: '0.2.2-rc.1',
    isPackaged: true,
    appUpdateConfigPath: join(root, 'app-update.yml'),
    userDataPath: join(root, 'user-data'),
    baseCachePath: join(root, 'caches'),
    whenReady: async (): Promise<void> => undefined,
    relaunch: (): void => undefined,
    quit: (): void => undefined,
    onQuit: (): void => undefined,
  }
  const updater = new ProbeUpdater({ provider: 'generic', url: 'https://feed.invalid/mac/' }, app)
  updater.logger = QUIET
  // `httpExecutor` and the download helper are the library's own wiring points;
  // this suite replaces both so the attempt runs against memory and a temporary
  // cache directory.
  Object.assign(updater, {
    httpExecutor: executor,
    downloadedUpdateHelper: new DownloadedUpdateHelper(cacheDir),
  })
  const provider = new GenericProvider(
    { provider: 'generic', url: 'https://feed.invalid/mac/' },
    updater,
    { platform: 'darwin', isUseMultipleRangeRequest: false, executor: providerExecutor() },
  )
  const fileInfo: ResolvedUpdateFileInfo = {
    url: new URL(`https://feed.invalid/${ARTIFACT}`),
    info: { url: ARTIFACT, sha512: digest(NEW_BYTES), size: NEW_BYTES.byteLength },
  }
  const target = join(root, 'download.zip')
  return {
    updater,
    fileInfo,
    provider,
    executor,
    target,
    cacheDir,
    oldFile,
    oldBlockmap,
    run: () => updater.attempt(fileInfo, {
      updateInfoAndProvider: { info: updateInfo(), provider },
      requestHeaders: {},
      cancellationToken: new CancellationToken(),
      differentialDownloadBase: { oldFile, oldBlockMapFile: oldBlockmap },
    }, target, provider, 'installer.exe'),
  }
}

describe('a differential source the caller supplies', () => {
  it('transfers only the blocks that differ and writes the candidate exactly', async () => {
    const harness = buildHarness()

    const fellBack = await harness.run()

    expect(fellBack).toBe(false)
    expect(readFileSync(harness.target)).toEqual(NEW_BYTES)
    // The candidate's blockmap is read whole; the candidate itself arrives as
    // one range naming the changed block and nothing else.
    expect(harness.executor.read).toEqual([`/${ARTIFACT}.blockmap`])
    expect(harness.executor.seen).toEqual([
      { path: `/${ARTIFACT}`, range: `bytes=${String(SHARED.byteLength)}-${String(NEW_BYTES.byteLength - 1)}` },
    ])
  })

  it('ignores the cache directory’s own blockmap when a pair is supplied', async () => {
    const harness = buildHarness()
    mkdirp(harness.cacheDir)
    // The library's cache holds a blockmap that describes different bytes. Read
    // first, as the unpatched library reads it, it would copy the wrong blocks.
    writeFileSync(join(harness.cacheDir, 'current.blockmap'), blockmapOf(Buffer.alloc(NEW_BYTES.byteLength, 5)))

    const fellBack = await harness.run()

    expect(fellBack).toBe(false)
    expect(readFileSync(harness.target)).toEqual(NEW_BYTES)
  })

  it('falls back to a full download when the supplied artifact does not match its blockmap', async () => {
    const harness = buildHarness()
    writeFileSync(harness.oldFile, Buffer.alloc(OLD_BYTES.byteLength, 1))

    expect(await harness.run()).toBe(true)
  })

  it('falls back when the supplied artifact is gone', async () => {
    const harness = buildHarness()
    rmSync(harness.oldFile)

    expect(await harness.run()).toBe(true)
  })

  it('falls back when the supplied blockmap file is unusable', async () => {
    const harness = buildHarness()
    writeFileSync(harness.oldBlockmap, 'not a blockmap\n')

    expect(await harness.run()).toBe(true)
  })

  it('falls back when the candidate’s blockmap cannot be fetched', async () => {
    const harness = buildHarness()
    const executor = new MemoryExecutor(new Map([[`/${ARTIFACT}`, NEW_BYTES]]))
    Object.assign(harness.updater, { httpExecutor: executor })
    const provider = new GenericProvider(
      { provider: 'generic', url: 'https://feed.invalid/mac/' },
      harness.updater,
      { platform: 'darwin', isUseMultipleRangeRequest: false, executor: providerExecutor() },
    )

    const fellBack = await harness.updater.attempt(harness.fileInfo, {
      updateInfoAndProvider: { info: updateInfo(), provider },
      requestHeaders: {},
      cancellationToken: new CancellationToken(),
      differentialDownloadBase: { oldFile: harness.oldFile, oldBlockMapFile: harness.oldBlockmap },
    }, harness.target, provider, 'installer.exe')

    expect(fellBack).toBe(true)
  })
})
