/**
 * The one artifact this shell keeps for a differential download, and the record
 * that proves which build it is.
 *
 * electron-updater derives an old artifact's blockmap URL by substituting the
 * version string, and takes the old artifact itself from a fixed name in its
 * own cache. Neither can distinguish two builds published under one version:
 * this product ships a fix as the next build of the same upstream version, so
 * the substitution names the build being downloaded, and the library's cache
 * root may already hold a blockmap for bytes that are not installed yet. A
 * differential attempt on either would compare the wrong files, and only the
 * final digest would notice.
 *
 * So the shell keeps its own copy instead. One whole verified artifact of the
 * installed build lives under `dsh-differential/` beside a record naming its
 * complete release identity, platform, architecture and digest. A download may
 * be differential only when the running build is exactly the recorded build,
 * the artifact still hashes to the value the manifest published, and the
 * blockmap for that artifact is present and parses. Anything else is no
 * baseline at all, and the transfer is the full download it was before.
 *
 * The directory holds one build: a later download replaces it. Losing it costs
 * bandwidth, never correctness, so every refusal here is reported to the caller
 * as unavailable rather than raised.
 * @module @deepseek-ai/dsh-desktop-shell/differential-cache
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync, createReadStream, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { ensurePathContainment, validateFeedFileName } from './feed-validation.ts'
import {
  isSameBuild, parseReleaseIdentity, releaseKey,
  type ReleaseArch, type ReleaseIdentity, type ReleasePlatform, type UpdateOffer,
} from './release-identity.ts'

/** The subdirectory of the updater cache this shell owns. */
const DIRECTORY = 'dsh-differential'

/** The record beside the artifact. */
const RECORD = 'baseline.json'

/** The record format this build writes and reads. */
const SCHEMA_VERSION = 1

/**
 * The largest blockmap accepted from the feed.
 *
 * A blockmap for a few hundred megabytes of installer is well under one
 * megabyte, and this transfer happens before the download it accelerates: an
 * answer larger than this is not a blockmap worth waiting for, and the full
 * download is the better outcome.
 */
export const MAX_BLOCKMAP_BYTES = 4 * 1024 * 1024

/** The largest blockmap accepted after decompression, which bounds what a compressed body may expand to. */
export const MAX_INFLATED_BLOCKMAP_BYTES = 32 * 1024 * 1024

/** How long one blockmap request may take before the full download takes over. */
export const BLOCKMAP_TIMEOUT_MS = 20_000

/** The base64 spelling electron-builder writes for a SHA-512 digest. */
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/u

/** The hex key that names one baseline's files. */
const KEY_PATTERN = /^[0-9a-f]{32}$/u

/** One artifact of one build: what it is called and what proves its bytes. */
export interface BaselineArtifact {
  /** The artifact's bare file name in the feed. */
  readonly fileName: string
  /** The manifest's base64 SHA-512 for those bytes. */
  readonly sha512: string
  /** The artifact's byte length. */
  readonly size: number
}

/** Where a differential attempt starts: the installed artifact and its blockmap, both on disk. */
export interface PreparedDifferentialBase {
  /** Absolute path of the installed build's whole artifact. */
  readonly oldFile: string
  /** Absolute path of that artifact's blockmap, gzipped as the feed serves it. */
  readonly oldBlockMapFile: string
}

/** Why this transfer has no differential baseline. */
export type DifferentialUnavailableReason =
  /** No record is kept, or it belongs to another platform, architecture or build. */
  | 'no-baseline'
  /** The kept artifact is missing, or no longer matches its recorded size or digest. */
  | 'baseline-invalid'
  /** The installed build's blockmap could not be fetched, parsed or stored. */
  | 'blockmap-unavailable'
  /** The blockmap was fetched but the record could not be updated; the transfer still runs full. */
  | 'cache-write-failed'

/** What preparing one transfer decided. */
export type DifferentialPreparation =
  /** A verified artifact and blockmap pair, ready to hand to electron-updater. */
  | { readonly kind: 'prepared'; readonly base: PreparedDifferentialBase }
  /** No pair could be proven, and this transfer is a full download. */
  | { readonly kind: 'unavailable'; readonly reason: DifferentialUnavailableReason; readonly detail: string }

/** What saving one baseline decided. */
export type BaselineSave =
  /** The artifact and its record are committed. */
  | { readonly kind: 'saved'; readonly artifactPath: string }
  /** Nothing was kept; a later transfer starts from a full download. */
  | { readonly kind: 'failed'; readonly detail: string }

/** One finished download worth keeping as the next transfer's baseline. */
export interface SaveBaselineInput {
  /** The updater cache directory this shell derives [[differentialCacheDir]] from. */
  readonly cacheDir: string
  /** The platform the artifact installs on. */
  readonly platform: ReleasePlatform
  /** The architecture the artifact installs on. */
  readonly arch: ReleaseArch
  /** The build the artifact installs. */
  readonly identity: ReleaseIdentity
  /** The artifact's published name, digest and length. */
  readonly artifact: BaselineArtifact
  /** The downloaded file to keep; it is read, never moved. */
  readonly sourceFile: string
}

/** Everything one preparation needs. */
export interface PrepareDifferentialBaseInput {
  /** The updater cache directory this shell derives [[differentialCacheDir]] from. */
  readonly cacheDir: string
  /** The build running now; the kept artifact must be exactly this build. */
  readonly running: ReleaseIdentity
  /** The frozen candidate being downloaded, for the platform and architecture. */
  readonly offer: UpdateOffer
  /**
   * Builds the absolute blockmap URL of the kept artifact from its published name.
   * The caller owns feed addressing; this module only knows the name it verified.
   * @param fileName - the kept artifact's name, as the manifest published it.
   * @returns the absolute URL to read the blockmap from.
   */
  readonly blockMapUrlFor: (fileName: string) => string
  /**
   * The fetch to use; this process's `fetch` unless a test names another.
   * @default globalThis.fetch
   */
  readonly fetch?: typeof globalThis.fetch
}

/** The record as it is stored, read back without trusting any field. */
interface StoredRecord {
  /** Always [[SCHEMA_VERSION]]. */
  readonly schemaVersion: number
  /** The build the artifact installs. */
  readonly identity: ReleaseIdentity
  /** The platform the artifact installs on. */
  readonly platform: ReleasePlatform
  /** The architecture the artifact installs on. */
  readonly arch: ReleaseArch
  /** The artifact's name, digest and length. */
  readonly artifact: BaselineArtifact
  /** The blockmap's digest and length, once one has been fetched. */
  readonly blockmap?: { readonly sha512: string; readonly size: number } | undefined
  /** The hex key naming both files. */
  readonly key: string
}

/**
 * The directory this shell keeps its differential baseline in.
 * @param cacheDir - the updater cache directory.
 * @returns the absolute directory, which may not exist yet.
 */
export function differentialCacheDir(cacheDir: string): string {
  return join(cacheDir, DIRECTORY)
}

/**
 * The base64 SHA-512 of one file, which is the spelling this feed publishes.
 * @param path - the file to read.
 * @returns the digest of its bytes.
 */
export function sha512OfFile(path: string): Promise<string> {
  return new Promise((resolveDigest, rejectDigest) => {
    const hash = createHash('sha512')
    createReadStream(path)
      .on('data', (chunk: string | Buffer) => { hash.update(chunk) })
      .on('error', rejectDigest)
      .on('end', () => { resolveDigest(hash.digest('base64')) })
  })
}

/**
 * The key that names one baseline's files.
 *
 * Every input that decides whether the pair may be used is part of it, so a
 * replaced artifact cannot be read under the old record's name.
 * @param identity - the build the artifact installs.
 * @param platform - the platform it installs on.
 * @param arch - the architecture it installs on.
 * @param sha512 - the artifact's published digest.
 * @returns 32 lowercase hexadecimal characters.
 */
function baselineKey(identity: ReleaseIdentity, platform: ReleasePlatform, arch: ReleaseArch, sha512: string): string {
  return createHash('sha256')
    .update(`${releaseKey(identity)}\n${platform}\n${arch}\n${sha512}`, 'utf8')
    .digest('hex')
    .substring(0, 32)
}

/**
 * Read one property of an unknown value without asserting its type.
 * @param value - the value to read.
 * @param key - the property name.
 * @returns the property's value, or undefined.
 */
function property(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  if (!Object.hasOwn(value, key)) return undefined
  return Reflect.get(value, key)
}

/**
 * Read a stored digest.
 * @param value - the value to read.
 * @returns the digest, or undefined when it is not one electron-builder writes.
 */
function storedDigest(value: unknown): string | undefined {
  return typeof value === 'string' && SHA512_BASE64.test(value) ? value : undefined
}

/**
 * Read a stored byte length.
 * @param value - the value to read.
 * @returns the length, or undefined when it is not a positive safe integer.
 */
function storedSize(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Read the artifact a record names.
 * @param value - the record's `artifact` value.
 * @returns the artifact, or undefined when any part of it is unusable.
 */
function storedArtifact(value: unknown): BaselineArtifact | undefined {
  const fileName = property(value, 'fileName')
  const sha512 = storedDigest(property(value, 'sha512'))
  const size = storedSize(property(value, 'size'))
  if (typeof fileName !== 'string' || sha512 === undefined || size === undefined) return undefined
  try {
    return { fileName: validateFeedFileName(fileName), sha512, size }
  } catch {
    // A name this shell would refuse to build a path from is not a usable
    // artifact record, and the record it came from is treated as absent.
    return undefined
  }
}

/**
 * Read the whole record, field by field.
 * @param cacheDir - the updater cache directory.
 * @returns the record, or undefined when there is none or any part is unusable.
 */
function readRecord(cacheDir: string): StoredRecord | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(differentialCacheDir(cacheDir), RECORD), 'utf8'))
  } catch {
    // No record, or one this build cannot parse: either way no baseline exists
    // and the transfer is a full download.
    return undefined
  }
  if (property(parsed, 'schemaVersion') !== SCHEMA_VERSION) return undefined
  let identity: ReleaseIdentity
  try {
    identity = parseReleaseIdentity(property(parsed, 'identity'))
  } catch {
    return undefined
  }
  const platform = property(parsed, 'platform')
  const arch = property(parsed, 'arch')
  const artifact = storedArtifact(property(parsed, 'artifact'))
  const key = property(parsed, 'key')
  if ((platform !== 'darwin' && platform !== 'win32') || (arch !== 'arm64' && arch !== 'x64')) return undefined
  if (artifact === undefined || typeof key !== 'string' || !KEY_PATTERN.test(key)) return undefined
  if (key !== baselineKey(identity, platform, arch, artifact.sha512)) return undefined
  const blockmapSha512 = storedDigest(property(property(parsed, 'blockmap'), 'sha512'))
  const blockmapSize = storedSize(property(property(parsed, 'blockmap'), 'size'))
  const blockmap = blockmapSha512 === undefined || blockmapSize === undefined
    ? undefined
    : { sha512: blockmapSha512, size: blockmapSize }
  return { schemaVersion: SCHEMA_VERSION, identity, platform, arch, artifact, blockmap, key }
}

/**
 * Whether one file still has the size and digest that prove what it is.
 * @param path - the file to check.
 * @param sha512 - the digest it must have.
 * @param size - the length it must have.
 * @returns true when both hold.
 */
async function matchesFile(path: string, sha512: string, size: number): Promise<boolean> {
  try {
    if (statSync(path).size !== size) return false
    return await sha512OfFile(path) === sha512
  } catch {
    // A file that cannot be read proves nothing, which is the same answer as a
    // mismatching one: no baseline.
    return false
  }
}

/**
 * Whether some bytes are a blockmap electron-updater can parse.
 *
 * The library reads a blockmap as `gunzipSync` followed by `JSON.parse` and
 * then compares the encoded `version` against the other blockmap's. Bytes that
 * fail any of that are rejected here rather than in the middle of a transfer.
 * @param bytes - the file's contents, as downloaded.
 * @returns true when they decompress to a blockmap document.
 */
function isBlockmap(bytes: Buffer): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_INFLATED_BLOCKMAP_BYTES }).toString('utf8'))
  } catch {
    // Not gzip, not JSON, or larger than this build will inflate: the feed
    // answered something this transfer cannot use.
    return false
  }
  return typeof property(parsed, 'version') === 'string'
    && Array.isArray(property(parsed, 'files'))
}

/**
 * Download one blockmap and check that it can be used.
 * @param url - the blockmap URL, derived from a verified artifact name.
 * @param fetchImpl - the fetch to use.
 * @returns the bytes as served.
 * @throws when the answer is not a `200`, is too large, or is not a blockmap.
 */
async function downloadBlockmap(url: string, fetchImpl: typeof globalThis.fetch): Promise<Buffer> {
  // This runs on the update path with nothing on screen, so a feed that accepts
  // the connection and answers nothing must not hold the channel: the bound is
  // the same order as electron-updater's own request timeout.
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, BLOCKMAP_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/octet-stream, application/gzip, */*', 'cache-control': 'no-cache' },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (response.status !== 200) {
      await response.body?.cancel()
      throw new Error(`the blockmap request answered ${String(response.status)} ${response.statusText}`)
    }
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_BLOCKMAP_BYTES) {
      await response.body?.cancel()
      throw new Error(`the blockmap is ${String(declared)} bytes, above the ${String(MAX_BLOCKMAP_BYTES)} byte limit`)
    }
    const chunks: Buffer[] = []
    let received = 0
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('the blockmap answer carried no body')
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > MAX_BLOCKMAP_BYTES) {
        await reader.cancel()
        throw new Error(`the blockmap is above the ${String(MAX_BLOCKMAP_BYTES)} byte limit`)
      }
      chunks.push(Buffer.from(value))
    }
    const bytes = Buffer.concat(chunks)
    if (!isBlockmap(bytes)) throw new Error('the answer is not a blockmap this updater can use')
    return bytes
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Write the record, replacing the previous one in one step.
 * @param cacheDir - the updater cache directory.
 * @param record - what to write.
 * @returns nothing.
 */
function writeRecord(cacheDir: string, record: StoredRecord): void {
  const directory = differentialCacheDir(cacheDir)
  const temporary = join(directory, `${RECORD}.tmp-${String(process.pid)}`)
  ensurePathContainment(cacheDir, temporary)
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`)
  ensurePathContainment(cacheDir, join(directory, RECORD))
  renameSync(temporary, join(directory, RECORD))
}

/**
 * Remove every entry of the directory the current record does not reference.
 *
 * A baseline is replaced, never accumulated: two whole installers on disk buys
 * nothing, because only the build running now can seed a difference.
 * @param cacheDir - the updater cache directory.
 * @param keep - the key whose two files stay.
 */
function removeUnreferenced(cacheDir: string, keep: string): void {
  const directory = differentialCacheDir(cacheDir)
  for (const entry of readdirSync(directory)) {
    if (entry === RECORD || entry.startsWith(`${keep}.`)) continue
    rmSync(join(directory, entry), { force: true, recursive: true })
  }
}

/**
 * Keep one finished download as the next transfer's differential baseline.
 *
 * The file is copied rather than moved: the library still needs the artifact it
 * just downloaded in its own cache, and the caller is reporting that one as an
 * installable update. Only a copy that hashes to the published value is kept,
 * and the record is written after it, so a run interrupted between the two
 * leaves an artifact no record names — which the next preparation ignores
 * (`[[prepareDifferentialBase]]` starts from the record).
 * @param input - the download to keep.
 * @returns whether the artifact and its record are committed.
 */
export async function saveDifferentialBaseline(input: SaveBaselineInput): Promise<BaselineSave> {
  try {
    if (!await matchesFile(input.sourceFile, input.artifact.sha512, input.artifact.size)) {
      return { kind: 'failed', detail: 'the downloaded file no longer matches the accepted artifact' }
    }
    const directory = differentialCacheDir(input.cacheDir)
    mkdirSync(directory, { recursive: true })
    const key = baselineKey(input.identity, input.platform, input.arch, input.artifact.sha512)
    const artifactPath = join(directory, `${key}.artifact`)
    const previous = readRecord(input.cacheDir)
    if (previous?.key === key && await matchesFile(artifactPath, input.artifact.sha512, input.artifact.size)) {
      // The same artifact is already kept — the launch after its install saves
      // it again — so only the record is refreshed.
      writeRecord(input.cacheDir, { ...previous, blockmap: previous.blockmap })
      return { kind: 'saved', artifactPath }
    }
    const temporary = join(directory, `${key}.artifact.tmp-${String(process.pid)}`)
    ensurePathContainment(input.cacheDir, temporary)
    ensurePathContainment(input.cacheDir, artifactPath)
    copyFileSync(input.sourceFile, temporary)
    if (!await matchesFile(temporary, input.artifact.sha512, input.artifact.size)) {
      rmSync(temporary, { force: true })
      return { kind: 'failed', detail: 'the copy does not match the downloaded artifact' }
    }
    renameSync(temporary, artifactPath)
    const record: StoredRecord = {
      schemaVersion: SCHEMA_VERSION,
      identity: input.identity,
      platform: input.platform,
      arch: input.arch,
      artifact: input.artifact,
      ...previous?.key === key && previous.blockmap !== undefined ? { blockmap: previous.blockmap } : {},
      key,
    }
    writeRecord(input.cacheDir, record)
    removeUnreferenced(input.cacheDir, key)
    return { kind: 'saved', artifactPath }
  } catch (error) {
    return { kind: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Keep the artifact an install just landed from, before its launch sweeps it.
 *
 * The launch after an install is the only moment the artifact the installer read
 * is still on disk, so this runs inside that launch and must not wait: it links
 * the file — a copy only where a link between the two paths is refused — and
 * records what the install receipt already says about it. The record is a claim,
 * not a proof: [[prepareDifferentialBase]] re-reads the file and checks its size
 * and digest before any later transfer uses it, so a torn link or a receipt that
 * outlived its file costs a full download rather than a bad difference.
 * @param input - the artifact to keep, as the install receipt and the staged file describe it.
 * @returns whether the artifact and its record are committed.
 */
export function keepInstalledArtifact(input: SaveBaselineInput): BaselineSave {
  try {
    const directory = differentialCacheDir(input.cacheDir)
    mkdirSync(directory, { recursive: true })
    const key = baselineKey(input.identity, input.platform, input.arch, input.artifact.sha512)
    const artifactPath = join(directory, `${key}.artifact`)
    ensurePathContainment(input.cacheDir, artifactPath)
    const previous = readRecord(input.cacheDir)
    if (previous?.key !== key || !existsSync(artifactPath)) {
      const temporary = join(directory, `${key}.artifact.tmp-${String(process.pid)}`)
      ensurePathContainment(input.cacheDir, temporary)
      rmSync(temporary, { force: true })
      try {
        linkSync(input.sourceFile, temporary)
      } catch {
        // A link is refused across volumes and on some Windows shares; the copy
        // is the same file, only paid for here.
        copyFileSync(input.sourceFile, temporary)
      }
      renameSync(temporary, artifactPath)
    }
    writeRecord(input.cacheDir, {
      schemaVersion: SCHEMA_VERSION,
      identity: input.identity,
      platform: input.platform,
      arch: input.arch,
      artifact: input.artifact,
      ...previous?.key === key && previous.blockmap !== undefined ? { blockmap: previous.blockmap } : {},
      key,
    })
    removeUnreferenced(input.cacheDir, key)
    return { kind: 'saved', artifactPath }
  } catch (error) {
    return { kind: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Prove one kept artifact against the build running now, and pair it with a blockmap.
 *
 * Nothing here decides whether an update exists: the caller only reaches this
 * after freezing a candidate, and the answer is only how that candidate's bytes
 * will be transferred. Every refusal is reported, never raised, because a
 * missing baseline costs bandwidth and nothing else.
 * @param input - the running build, the frozen candidate, and the blockmap URL to read when none is kept.
 * @returns the verified pair, or the reason this transfer is a full download.
 */
export async function prepareDifferentialBase(input: PrepareDifferentialBaseInput): Promise<DifferentialPreparation> {
  const record = readRecord(input.cacheDir)
  if (record === undefined) {
    return { kind: 'unavailable', reason: 'no-baseline', detail: 'no differential baseline is kept' }
  }
  if (record.platform !== input.offer.platform || record.arch !== input.offer.arch) {
    return {
      kind: 'unavailable',
      reason: 'no-baseline',
      detail: `the kept baseline is for ${record.platform}/${record.arch}, this transfer is ${input.offer.platform}/${input.offer.arch}`,
    }
  }
  if (!isSameBuild(record.identity, input.running)) {
    return {
      kind: 'unavailable',
      reason: 'no-baseline',
      detail: 'the kept baseline is another build than the one running',
    }
  }
  const directory = differentialCacheDir(input.cacheDir)
  const artifactPath = join(directory, `${record.key}.artifact`)
  if (!await matchesFile(artifactPath, record.artifact.sha512, record.artifact.size)) {
    return { kind: 'unavailable', reason: 'baseline-invalid', detail: 'the kept artifact is missing or no longer matches its record' }
  }
  const blockmapPath = join(directory, `${record.key}.blockmap`)
  if (record.blockmap !== undefined && await matchesFile(blockmapPath, record.blockmap.sha512, record.blockmap.size)) {
    try {
      if (isBlockmap(readFileSync(blockmapPath))) {
        return { kind: 'prepared', base: { oldFile: artifactPath, oldBlockMapFile: blockmapPath } }
      }
    } catch {
      // The file vanished between the check and the read, or cannot be read:
      // the blockmap below is the same one, fetched again.
    }
  }
  let bytes: Buffer
  try {
    bytes = await downloadBlockmap(input.blockMapUrlFor(record.artifact.fileName), input.fetch ?? globalThis.fetch)
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: 'blockmap-unavailable',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  const digest = createHash('sha512').update(bytes).digest('base64')
  const temporary = join(directory, `${record.key}.blockmap.tmp-${String(process.pid)}`)
  try {
    ensurePathContainment(input.cacheDir, temporary)
    ensurePathContainment(input.cacheDir, blockmapPath)
    writeFileSync(temporary, bytes)
    renameSync(temporary, blockmapPath)
    writeRecord(input.cacheDir, { ...record, blockmap: { sha512: digest, size: bytes.byteLength } })
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: 'cache-write-failed',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  return { kind: 'prepared', base: { oldFile: artifactPath, oldBlockMapFile: blockmapPath } }
}
