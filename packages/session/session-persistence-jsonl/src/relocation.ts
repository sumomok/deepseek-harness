/**
 * Crash-safe relocation of one stored JSONL Session to the storage location of
 * another cwd. Three facts hold at every instant, for every process and for
 * builds without relocation support: at most one directory under the root
 * holds canonical generations of the Session; the highest generation's header
 * cwd names that directory; and once the target current generation exists the
 * source directory holds none. Prior generations move into the target under
 * non-canonical names, the source current generation is hidden, and
 * publishing the rewritten current generation in the target is the commit
 * point. A root-level intent record names both directories; it is published
 * without replacing another intent, and only a holder of both directories'
 * leases recovers or deletes it. Recovery rolls
 * the move back while the target current generation is absent and completes
 * it when that generation continues the moved log. Between hiding the source
 * and publishing the target the Session is absent, so another process may
 * store a new Session with the same id; publishing the target or restoring the
 * source checks every other project directory first, recovery compares a
 * target current generation with the moved log, and restoring a hidden file
 * never replaces a different one, so a new Session in another project
 * directory, at the target, or in the source directory stops the move with the
 * intent and every hidden file left in place. A relocation that dies before
 * publishing its intent leaves an intent temporary and lock-only Session
 * directories, which the backend's first operation removes.
 * @module dsh-session-persistence-jsonl/relocation
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  link as fsLink,
  open as fsOpen,
  readFile as fsReadFile,
  readdir as fsReaddir,
  rename as fsRename,
  rmdir as fsRmdir,
  stat as fsStat,
  unlink as fsUnlink,
  type FileHandle,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import z from '@deepseek-ai/schemastery'
import { SESSION_FORMAT_VERSION, SessionId as makeSessionId } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError, SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import {
  encodeSegment, generationLogFilename, parseGenerationLogFilename, sessionDir, type JsonlCompression,
} from './format.ts'
import { readStableJsonlFile, type JsonlExpectedPrefix, type JsonlVerifiedGeneration } from './generation.ts'
import { LEASE_FILENAME, SessionWriteLease } from './lease.ts'
import { JsonlVerificationRejectedError, verifyCurrentGenerationInWorker } from './migration-verifier.ts'
import { publishNewFileWin32, replaceFileWin32 } from './win32.ts'
import { compressZstdFrame, decompressZstdFrame, scanZstdFrames } from './zstd.ts'

const INTENT_KIND = 'dsh-session-relocation'
const INTENT_FILE = /^\.relocate\.[0-9a-f]{64}\.json$/
const INTENT_TEMPORARY = /^\.relocate\.[0-9a-f]{64}\.json\.[0-9a-f]+\.tmp$/

const intentSchema = z.object({
  kind: z.const(INTENT_KIND).required(),
  version: z.const(1).required(),
  id: z.string().required(),
  token: z.string().pattern(/^[0-9a-f]{12}$/).required(),
  fromDir: z.string().required(),
  toDir: z.string().required(),
  fromCwd: z.string(),
  toCwd: z.string().required(),
  current: z.string().required(),
  sourceEnd: z.natural().required(),
  prior: z.array(z.string()).required(),
  sameDirectory: z.boolean().required(),
  createdAt: z.natural().required(),
})

/** One relocation as recorded in its root-level intent file. */
interface RelocationIntent {
  readonly kind: typeof INTENT_KIND
  readonly version: 1
  readonly id: string
  readonly token: string
  /** Source Session directory, relative to the root. */
  readonly fromDir: string
  /** Target Session directory, relative to the root. */
  readonly toDir: string
  readonly fromCwd?: string | undefined
  readonly toCwd: string
  /** Current-generation filename of the configured encoding. */
  readonly current: string
  /**
   * Committed byte length of the source current generation, header included:
   * where its torn tail begins, or its whole length when none is torn.
   */
  readonly sourceEnd: number
  /** Historical generation filenames moved with the Session. */
  readonly prior: readonly string[]
  readonly sameDirectory: boolean
  readonly createdAt: number
}

/** Absolute locations derived from one intent. */
interface RelocationPaths {
  readonly root: string
  readonly compression: JsonlCompression
  readonly intent: RelocationIntent
  readonly intentPath: string
  readonly intentTemporary: string
  readonly sourceDir: string
  readonly targetDir: string
  readonly stagePath: string
  readonly sourceCurrent: string
  readonly hiddenCurrent: string
  readonly targetCurrent: string
}

/** Storage that contradicts an intent; the intent and every file stay in place. */
interface Conflict {
  readonly kind: 'conflict'
  readonly reason: string
}

type Completion = { readonly kind: 'completed'; readonly sourceRetained: boolean } | Conflict
type Rollback = { readonly kind: 'rolled-back' } | Conflict
/**
 * Result of recovering one intent file; `busy` leaves it for a later recovery,
 * and `gone` means another backend settled it after it was found.
 */
type Settlement = Completion | Rollback | { readonly kind: 'busy' } | { readonly kind: 'gone' }
/** Disk-derived verdict for a cross-directory intent. */
type Decision = { readonly kind: 'rollback' } | { readonly kind: 'complete' } | Conflict

/** Named step after which a relocation test may simulate process death. */
export type JsonlRelocationPhase =
  | 'intent-written'
  | 'staged'
  | 'prior-hidden'
  | 'current-hidden'
  | 'published'
  | 'prior-restored'
  | 'cleaned'
  | 'replaced'

/** One relocation the backend prepared while holding the source and target write leases. */
export interface JsonlRelocationPlan {
  /** Resolved backend root. */
  readonly root: string
  readonly id: SessionId
  readonly compression: JsonlCompression
  /** Directory holding the Session's generations, spelled as discovery listed it. */
  readonly sourceDir: string
  /** `sessionDir(root, toCwd, id)`. */
  readonly targetDir: string
  /** Whether source and target name one physical directory. */
  readonly sameDirectory: boolean
  readonly fromCwd: string | undefined
  readonly toCwd: string
  /** Rewritten current header record, trailing newline included. */
  readonly headerLine: string
  /** Committed byte length of the source current generation; absent keeps the whole file. */
  readonly sourceEnd: number | undefined
  /** Encoded batch of records recovered from a torn tail; empty when there are none. */
  readonly recoveredBatch: Buffer | string
  /** Logical event count the rewritten generation must decode to. */
  readonly eventCount: number
}

/** Result of a relocation that reached its commit point. */
export interface JsonlRelocationOutcome {
  /** Failure after the commit point; the move stands and recovery finishes it. */
  readonly failure?: unknown
  /** Whether the intent record remains for a later recovery. */
  readonly intentRetained: boolean
  /** Whether the source directory remains because it holds unrecognized files. */
  readonly sourceRetained: boolean
}

interface RelocationFileSystem {
  open(path: string, flags: string, mode?: number): Promise<FileHandle>
  readFile(path: string): Promise<Buffer>
  readdir(path: string): Promise<string[]>
  /** Names of the entries that are directories, not symbolic links to them, as discovery lists project directories. */
  listDirectories(path: string): Promise<string[]>
  stat(path: string): Promise<{ readonly dev: bigint; readonly ino: bigint }>
  link(existingPath: string, newPath: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  unlink(path: string): Promise<void>
  rmdir(path: string): Promise<void>
}

type VerifyGeneration = (
  path: string,
  compression: JsonlCompression,
  expectedId: string,
  expectedEventCount: number,
  expectedPrefix?: JsonlExpectedPrefix,
  signal?: AbortSignal,
) => Promise<JsonlVerifiedGeneration>

interface RelocationInternals {
  readonly fs: RelocationFileSystem
  readonly platform: NodeJS.Platform
  readonly randomToken: () => string
  readonly publishNewWin32: typeof publishNewFileWin32
  readonly replaceWin32: typeof replaceFileWin32
  readonly verify: VerifyGeneration
  readonly barrier: (phase: JsonlRelocationPhase, index?: number) => void | Promise<void>
}

/** Dependency overrides for an isolated relocation runtime. */
export type JsonlRelocationRuntimeOverrides = Partial<Omit<RelocationInternals, 'fs'>> & {
  readonly fs?: Partial<RelocationFileSystem>
}

/** One Session directory as the backend's root walk lists it. */
export interface JsonlSessionDirectory {
  readonly dir: string
  /** Entry names inside the directory. */
  readonly names: readonly string[]
}

/** Bound relocation operations used by the backend and by deterministic tests. */
export interface JsonlRelocationRuntime {
  /**
   * Run the relocation steps without recovering from a failure, so a failing
   * barrier leaves exactly the disk state of a process that died there.
   * @param plan - the prepared relocation; the caller holds its leases.
   * @param signal - cancellation observed until the commit point.
   * @returns the settled outcome.
   */
  execute(plan: JsonlRelocationPlan, signal?: AbortSignal): Promise<JsonlRelocationOutcome>
  /**
   * Run the relocation steps and recover in place from a failure: before the
   * intent stands, the call removes its intent temporary and a lock-only
   * target directory, leaves any intent already at the intent path, and
   * rethrows; before the commit point the move rolls back and the failure
   * rethrows; after it the move completes and the failure returns in the
   * outcome. An intent already at the intent path refuses the move with
   * `SessionPersistenceCorruptionError` naming it.
   * @param plan - the prepared relocation; the caller holds its leases.
   * @param signal - cancellation observed until the commit point.
   * @returns the settled outcome.
   */
  relocate(plan: JsonlRelocationPlan, signal?: AbortSignal): Promise<JsonlRelocationOutcome>
  /**
   * Settle an intent left for one Session by an earlier relocation while
   * holding the leases of both directories it names: the caller's lease on
   * `held` counts for the intent directory that names the same physical
   * directory, and this call takes and releases the others. The intent is read
   * again under those leases and settled only when unchanged. An intent
   * another backend removes before it is read counts as settled.
   * @param root - resolved backend root.
   * @param compression - configured encoding.
   * @param id - the Session about to be relocated.
   * @param held - a Session directory whose lease the caller holds.
   * @returns whether an intent for `id` existed; resolution means none remains.
   * @throws {SessionAlreadyOwnedError} while another holder keeps either directory.
   * @throws {SessionPersistenceCorruptionError} when the intent is malformed
   *   or contradicts the storage, including a Session of the same id stored
   *   while the moved one was absent; the message names the intent file.
   */
  settle(root: string, compression: JsonlCompression, id: SessionId, held?: string): Promise<boolean>
  /**
   * Recover every intent under the root. Intent temporaries stay for
   * {@link JsonlRelocationRuntime.discardRemainders}, which removes one only
   * when no relocation of its Session is running. Never rejects: each failure
   * is reported and its intent stays.
   * @param root - resolved backend root.
   * @param compression - configured encoding.
   * @param warn - receives one message per intent left in place.
   */
  sweep(root: string, compression: JsonlCompression, warn: (message: string) => void): Promise<void>
  /**
   * Remove what a relocation that died before publishing its intent left: its
   * intent temporaries and the Session directories it created, which hold
   * nothing but a lock file, and the lock-only source directory a locker
   * recreated while a relocation retired it. A lock-only directory counts only
   * when the same Session is stored in another directory or an intent
   * temporary names the Session, so a create that has not stored its first
   * event keeps its directory. The removal holds the leases of the lock-only
   * directories and, when it removes an intent temporary, of every directory
   * of that Session, since only a holder of the directory the Session occupies
   * writes one. A Session whose intent stands or whose directory another
   * holder keeps is skipped. Never rejects: each failure is reported and the
   * Session's remainders stay.
   * @param root - resolved backend root.
   * @param directories - every Session directory under the root with its entry names.
   * @param warn - receives one message per Session whose remainders stay after a failure.
   */
  discardRemainders(root: string, directories: readonly JsonlSessionDirectory[], warn: (message: string) => void): Promise<void>
  /**
   * Whether two directory spellings name one physical directory; an absent
   * directory names none.
   * @param target - the directory derived from the new cwd.
   * @param source - the directory holding the Session.
   * @returns true when both resolve to one directory.
   */
  isSameDirectory(target: string, source: string): Promise<boolean>
  /**
   * Remove a Session directory that holds nothing but its lock file. The
   * caller still holds that lock and releases it afterwards. A directory that
   * another process removes or refills meanwhile stays as it is.
   * @param dir - the Session directory to discard.
   */
  discardDirectory(dir: string): Promise<void>
}

const defaultFileSystem: RelocationFileSystem = {
  open: (path, flags, mode) => fsOpen(path, flags, mode),
  readFile: path => fsReadFile(path),
  readdir: path => fsReaddir(path),
  listDirectories: async path => (await fsReaddir(path, { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name),
  stat: path => fsStat(path, { bigint: true }),
  link: fsLink,
  rename: fsRename,
  unlink: fsUnlink,
  rmdir: path => fsRmdir(path),
}

const defaultInternals: RelocationInternals = {
  fs: defaultFileSystem,
  platform: process.platform,
  randomToken: () => randomBytes(6).toString('hex'),
  publishNewWin32: publishNewFileWin32,
  replaceWin32: replaceFileWin32,
  verify: verifyCurrentGenerationInWorker,
  barrier: () => {},
}

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code
}

/** Whether a filesystem-owned failure should retain its original errno and path. */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof (error as NodeJS.ErrnoException | null)?.code === 'string'
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Invert {@link encodeSegment}; a name it did not produce keeps every character outside a `~XXXX` escape. */
function decodeSegment(segment: string): string {
  return segment.replace(/~([0-9A-F]{4})/g, (_escape, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
}

/** Whether a file name is a canonical generation of either encoding. */
function isCanonicalName(name: string): boolean {
  return parseGenerationLogFilename(name, 'none') !== undefined || parseGenerationLogFilename(name, 'zstd') !== undefined
}

/**
 * Name the root-level intent file of one Session's relocation. The fixed-length
 * digest keeps the name within filesystem component limits for any id.
 * @param root - resolved backend root.
 * @param id - the relocated Session.
 * @returns the absolute intent path.
 */
export function relocationIntentPath(root: string, id: string): string {
  return join(root, `.relocate.${sha256(id)}.json`)
}

/**
 * Name the staged rewritten current generation. The suffix keeps it outside
 * the canonical generation names of both encodings.
 * @param current - the current-generation filename.
 * @param token - the relocation's random token.
 * @returns the staged filename.
 */
export function relocationStageName(current: string, token: string): string {
  return `${current}.relocate-${token}.tmp`
}

/**
 * Name a generation hidden during relocation. The suffix keeps it outside the
 * canonical generation names of both encodings.
 * @param name - the canonical generation filename.
 * @param token - the relocation's random token.
 * @returns the hidden filename.
 */
export function relocationHiddenName(name: string, token: string): string {
  return `${name}.relocating-${token}`
}

function pathsOf(root: string, compression: JsonlCompression, intent: RelocationIntent): RelocationPaths {
  const intentPath = relocationIntentPath(root, intent.id)
  const sourceDir = join(root, intent.fromDir)
  const targetDir = join(root, intent.toDir)
  return {
    root,
    compression,
    intent,
    intentPath,
    intentTemporary: `${intentPath}.${intent.token}.tmp`,
    sourceDir,
    targetDir,
    stagePath: join(intent.sameDirectory ? sourceDir : targetDir, relocationStageName(intent.current, intent.token)),
    sourceCurrent: join(sourceDir, intent.current),
    hiddenCurrent: join(sourceDir, relocationHiddenName(intent.current, intent.token)),
    targetCurrent: join(targetDir, intent.current),
  }
}

async function syncDirectory(path: string, x: RelocationInternals): Promise<void> {
  if (x.platform === 'win32') return
  const handle = await x.fs.open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function removeIfPresent(path: string, x: RelocationInternals): Promise<void> {
  try {
    await x.fs.unlink(path)
  } catch (error: unknown) {
    if (!hasCode(error, 'ENOENT')) throw error
  }
}

async function statIfPresent(
  path: string,
  x: RelocationInternals,
): Promise<{ readonly dev: bigint; readonly ino: bigint } | undefined> {
  try {
    return await x.fs.stat(path)
  } catch (error: unknown) {
    if (hasCode(error, 'ENOENT')) return undefined
    throw error
  }
}

async function pathExists(path: string, x: RelocationInternals): Promise<boolean> {
  return await statIfPresent(path, x) !== undefined
}

/**
 * Whether two spellings name one physical directory or two; `absent` when
 * either names none. Identical spellings name one directory even when absent.
 */
async function relateDirectories(
  left: string,
  right: string,
  x: RelocationInternals,
): Promise<'same' | 'different' | 'absent'> {
  if (left === right) return 'same'
  const leftInfo = await statIfPresent(left, x)
  if (leftInfo === undefined) return 'absent'
  const rightInfo = await statIfPresent(right, x)
  if (rightInfo === undefined) return 'absent'
  return leftInfo.dev === rightInfo.dev && leftInfo.ino === rightInfo.ino ? 'same' : 'different'
}

/** Canonical generation filenames of either encoding in one directory; an absent directory holds none. */
async function canonicalNames(dir: string, x: RelocationInternals): Promise<string[]> {
  let names: string[]
  try {
    names = await x.fs.readdir(dir)
  } catch (error: unknown) {
    if (hasCode(error, 'ENOENT')) return []
    throw error
  }
  return names.filter(isCanonicalName).sort()
}

/**
 * Whether any Session directory holds canonical generations of the intent's
 * id, searched the way discovery searches project directories. The caller has
 * established that neither the source nor the target holds any.
 */
async function storedElsewhere(paths: RelocationPaths, x: RelocationInternals): Promise<boolean> {
  const segment = encodeSegment(paths.intent.id)
  for (const project of await x.fs.listDirectories(paths.root)) {
    if ((await canonicalNames(join(paths.root, project, segment), x)).length > 0) return true
  }
  return false
}

const STORED_ELSEWHERE = 'another project directory holds a stored log of the session'

/**
 * Move a hidden file back to a canonical name without replacing an existing
 * file. A hidden file that is gone, whether before the move or between a
 * refused move and the comparison, counts as absent.
 */
async function restoreHidden(from: string, to: string, x: RelocationInternals): Promise<'absent' | 'restored' | 'conflict'> {
  try {
    if (x.platform === 'win32') {
      await x.publishNewWin32(from, to)
    } else {
      await x.fs.link(from, to)
      await syncDirectory(dirname(to), x)
      await x.fs.unlink(from)
    }
    return 'restored'
  } catch (error: unknown) {
    if (hasCode(error, 'ENOENT')) return 'absent'
    if (!hasCode(error, 'EEXIST')) throw error
  }
  let hidden: Buffer
  try {
    hidden = await x.fs.readFile(from)
  } catch (error: unknown) {
    if (hasCode(error, 'ENOENT')) return 'absent'
    throw error
  }
  if (!hidden.equals(await x.fs.readFile(to))) return 'conflict'
  await x.fs.unlink(from)
  return 'restored'
}

/**
 * Publish the intent without replacing one already at its path: an intent of
 * an earlier relocation of the same id names hidden files that only it can
 * restore. Sets `progress.intentPublished` once the intent stands at its path.
 */
async function writeIntent(
  paths: RelocationPaths,
  progress: { intentPublished: boolean },
  x: RelocationInternals,
): Promise<void> {
  const { intent } = paths
  const handle = await x.fs.open(paths.intentTemporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify({ ...intent, fromCwd: intent.fromCwd ?? null })}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    if (x.platform === 'win32') {
      await x.publishNewWin32(paths.intentTemporary, paths.intentPath)
    } else {
      await x.fs.link(paths.intentTemporary, paths.intentPath)
    }
  } catch (error: unknown) {
    if (!hasCode(error, 'EEXIST')) throw error
    throw new SessionPersistenceCorruptionError(
      `session "${intent.id}": an earlier relocation's intent "${paths.intentPath}" remains, so this relocation cannot record its own`,
      { cause: error },
    )
  }
  progress.intentPublished = true
  if (x.platform !== 'win32') await x.fs.unlink(paths.intentTemporary)
  await syncDirectory(paths.root, x)
}

async function deleteIntent(paths: RelocationPaths, x: RelocationInternals): Promise<void> {
  await removeIfPresent(paths.intentTemporary, x)
  await removeIfPresent(paths.intentPath, x)
  await syncDirectory(paths.root, x)
}

function invalidIntent(path: string, reason: string, cause: unknown = new Error(reason)): SessionPersistenceCorruptionError {
  return new SessionPersistenceCorruptionError(`relocation intent "${path}" is invalid: ${reason}`, { cause })
}

/** Read and validate one intent file; nothing on disk changes when it is invalid. */
async function readIntent(
  root: string,
  compression: JsonlCompression,
  path: string,
  x: RelocationInternals,
): Promise<RelocationIntent> {
  let intent: RelocationIntent
  try {
    intent = intentSchema(JSON.parse((await x.fs.readFile(path)).toString('utf8')) as Parameters<typeof intentSchema>[0])
  } catch (error: unknown) {
    if (isErrnoException(error)) throw error
    throw invalidIntent(path, String(error), error)
  }
  if (intent.id.length === 0 || basename(path) !== basename(relocationIntentPath(root, intent.id))) {
    throw invalidIntent(path, 'the file name does not identify the recorded session')
  }
  if (!isAbsolute(intent.toCwd)
    || intent.toDir !== relative(root, sessionDir(root, intent.toCwd, makeSessionId(intent.id)))) {
    throw invalidIntent(path, 'the target directory does not belong to the target cwd')
  }
  const source = intent.fromDir.split(sep)
  if (source.length !== 2 || ['', '.', '..'].includes(source[0] as string) || source[1] !== encodeSegment(intent.id)) {
    throw invalidIntent(path, 'the source directory is not a session directory under the root')
  }
  const relation = await relateDirectories(join(root, intent.fromDir), join(root, intent.toDir), x)
  if (!intent.sameDirectory && relation === 'same') {
    throw invalidIntent(path, 'a cross-directory relocation names one directory')
  }
  // A same-directory move records two spellings only for an alias of the source directory;
  // settling it removes only the source-side stage and the intent, so a spelling that names
  // no directory any more is no contradiction.
  if (intent.sameDirectory && relation === 'different') {
    throw invalidIntent(path, 'a same-directory relocation names two directories')
  }
  if (intent.current !== generationLogFilename(SESSION_FORMAT_VERSION, compression)
    || intent.prior.some(name => (parseGenerationLogFilename(name, compression) ?? SESSION_FORMAT_VERSION) >= SESSION_FORMAT_VERSION)) {
    throw invalidIntent(path, 'the generation names do not match this backend')
  }
  return intent
}

/**
 * Remove intent temporaries of one Session that a process left when it died
 * before publishing its intent. Only a relocation holding the lock of the
 * directory the Session occupies writes them, so a caller holding that lock
 * races no writer.
 */
async function removeIntentTemporaries(root: string, id: SessionId, x: RelocationInternals): Promise<void> {
  const prefix = `${basename(relocationIntentPath(root, id))}.`
  const stale = (await x.fs.readdir(root)).filter(name => name.startsWith(prefix) && INTENT_TEMPORARY.test(name))
  for (const name of stale) await removeIfPresent(join(root, name), x)
  if (stale.length > 0) await syncDirectory(root, x)
}

/** One relocation ready to record: its locations and the source current generation it stages. */
interface PreparedRelocation {
  readonly paths: RelocationPaths
  /** The source current generation as read under the caller's leases. */
  readonly source: Buffer
}

/**
 * Refuse a cross-filesystem move or an occupied target, then read the source
 * current generation and record the Session's generations and committed length.
 */
async function prepareIntent(
  plan: JsonlRelocationPlan,
  signal: AbortSignal | undefined,
  x: RelocationInternals,
): Promise<PreparedRelocation> {
  if (!plan.sameDirectory) {
    const project = dirname(plan.targetDir)
    const [source, target] = [await x.fs.stat(plan.sourceDir), await x.fs.stat(project)]
    if (source.dev !== target.dev) {
      throw new Error(
        `cannot relocate session "${plan.id}": "${plan.sourceDir}" and "${project}" are on different filesystems`,
      )
    }
    const [occupied] = await canonicalNames(plan.targetDir, x)
    if (occupied !== undefined) {
      throw new SessionPersistenceCorruptionError(
        `cannot relocate session "${plan.id}": the target already holds a stored log (raw log: ${join(plan.targetDir, occupied)})`,
        { cause: new Error('relocation target is occupied') },
      )
    }
  }
  await removeIntentTemporaries(plan.root, plan.id, x)
  const current = generationLogFilename(SESSION_FORMAT_VERSION, plan.compression)
  const prior = (await canonicalNames(plan.sourceDir, x)).filter(name => name !== current)
  const { bytes } = await readStableJsonlFile(join(plan.sourceDir, current), signal)
  const paths = pathsOf(plan.root, plan.compression, {
    kind: INTENT_KIND,
    version: 1,
    id: plan.id,
    token: x.randomToken(),
    fromDir: relative(plan.root, plan.sourceDir),
    toDir: relative(plan.root, plan.targetDir),
    fromCwd: plan.fromCwd,
    toCwd: plan.toCwd,
    current,
    sourceEnd: plan.sourceEnd ?? bytes.length,
    prior,
    sameDirectory: plan.sameDirectory,
    createdAt: Date.now(),
  })
  return { paths, source: bytes }
}

/** Byte offset just past a generation's header record; undefined when that record is incomplete. */
function headerEnd(bytes: Buffer, compression: JsonlCompression): number | undefined {
  if (compression === 'zstd') return scanZstdFrames(bytes, 1).frames[0]?.end
  const newline = bytes.indexOf(0x0A)
  return newline === -1 ? undefined : newline + 1
}

/** Decode one generation's header record; undefined when it does not decode. */
async function decodeHeader(record: Buffer, compression: JsonlCompression): Promise<unknown> {
  try {
    return JSON.parse((compression === 'zstd' ? await decompressZstdFrame(record) : record).toString('utf8'))
  } catch {
    // A record that does not decode is no header a relocation wrote.
    return undefined
  }
}

/** Whether two header records hold the same fields apart from cwd, the one field a relocation rewrites. */
async function sameHeaderButCwd(source: Buffer, target: Buffer, compression: JsonlCompression): Promise<boolean> {
  const left = await decodeHeader(source, compression)
  const right = await decodeHeader(target, compression)
  return left !== undefined && right !== undefined
    && isDeepStrictEqual(Object.assign({}, left, { cwd: null }), Object.assign({}, right, { cwd: null }))
}

/**
 * Whether the target current generation continues the moved log rather than
 * holding another Session of the same id. A log only grows by appending and a
 * relocation rewrites only the header record's cwd, so a published target
 * begins with the staged copy while that exists. Otherwise the target's header
 * record matches the hidden source's in every field but cwd, and its bytes
 * after the header begin with the hidden source's committed bytes (the length
 * the intent records) after its header; the staged copy put any records
 * recovered from a torn tail after them. Without either file no copy of the
 * moved current generation remains to compare or to lose.
 */
async function targetContinuesSource(paths: RelocationPaths, x: RelocationInternals): Promise<boolean> {
  const target = await x.fs.readFile(paths.targetCurrent)
  if (await pathExists(paths.stagePath, x)) {
    const staged = await x.fs.readFile(paths.stagePath)
    return target.subarray(0, staged.length).equals(staged)
  }
  if (!await pathExists(paths.hiddenCurrent, x)) return true
  const hidden = await x.fs.readFile(paths.hiddenCurrent)
  const { compression, intent: { sourceEnd } } = paths
  const sourceStart = headerEnd(hidden, compression)
  const targetStart = headerEnd(target, compression)
  if (sourceStart === undefined || targetStart === undefined || sourceEnd < sourceStart || sourceEnd > hidden.length) return false
  if (!await sameHeaderButCwd(hidden.subarray(0, sourceStart), target.subarray(0, targetStart), compression)) return false
  const committed = hidden.subarray(sourceStart, sourceEnd)
  return target.subarray(targetStart, targetStart + committed.length).equals(committed)
}

/**
 * Write the rewritten current generation beside its destination and verify it
 * in a worker: the new header record, the source's committed bytes (the length
 * the intent records) after its header, then any records recovered from its
 * torn tail.
 */
async function stage(
  plan: JsonlRelocationPlan,
  { paths, source }: PreparedRelocation,
  signal: AbortSignal | undefined,
  x: RelocationInternals,
): Promise<void> {
  const start = headerEnd(source, plan.compression)
  if (start === undefined) throw new Error('the source current generation has no complete header record')
  const header = plan.compression === 'zstd' ? await compressZstdFrame(plan.headerLine) : Buffer.from(plan.headerLine)
  const recovered = typeof plan.recoveredBatch === 'string' ? Buffer.from(plan.recoveredBatch) : plan.recoveredBatch
  const content = Buffer.concat([header, source.subarray(start, paths.intent.sourceEnd), recovered])
  const handle = await x.fs.open(paths.stagePath, 'wx', 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(dirname(paths.stagePath), x)
  let verified: JsonlVerifiedGeneration
  try {
    verified = await x.verify(paths.stagePath, plan.compression, plan.id, plan.eventCount, undefined, signal)
  } catch (error: unknown) {
    if (error instanceof JsonlVerificationRejectedError) {
      throw new SessionPersistenceCorruptionError(
        `session "${plan.id}": the relocated log failed verification: ${error.message} (raw log: ${paths.sourceCurrent})`,
        { cause: error },
      )
    }
    if (isErrnoException(error) || signal?.aborted === true) throw error
    throw new Error(
      `session "${plan.id}": the verification Worker failed before judging the staged relocated log "${paths.stagePath}": ${String(error)}`,
      { cause: error },
    )
  }
  if (verified.bytes !== content.length || verified.digest !== sha256(content)) {
    throw new SessionPersistenceCorruptionError(
      `session "${plan.id}": the staged relocated log changed during verification (raw log: ${paths.stagePath})`,
      { cause: new Error('verified bytes differ from the written stage') },
    )
  }
}

/** Publish the staged generation as the target current generation without replacing a different file. */
async function publishCurrent(paths: RelocationPaths, x: RelocationInternals): Promise<void> {
  try {
    if (x.platform === 'win32') {
      await x.publishNewWin32(paths.stagePath, paths.targetCurrent)
    } else {
      await x.fs.link(paths.stagePath, paths.targetCurrent)
    }
  } catch (error: unknown) {
    if (!hasCode(error, 'EEXIST')) throw error
    if (!await targetContinuesSource(paths, x)) {
      throw new SessionPersistenceCorruptionError(
        `session "${paths.intent.id}": the relocation target already holds a different log (raw log: ${paths.targetCurrent})`,
        { cause: error },
      )
    }
  }
  await syncDirectory(paths.targetDir, x)
}

/** Entry names of one directory; an absent directory has none. */
async function entryNames(dir: string, x: RelocationInternals): Promise<string[]> {
  try {
    return await x.fs.readdir(dir)
  } catch (error: unknown) {
    if (hasCode(error, 'ENOENT')) return []
    throw error
  }
}

/** Removals of a source directory whose lock file another locker keeps recreating before the source counts as retired. */
const RETIRE_ATTEMPTS = 3

/**
 * Remove the source lock file and directory. Locking the source directory
 * recreates its lock file, as another backend's recovery or a write open that
 * resolved the source does, so a directory that holds nothing but that file
 * again is removed again; one whose lock file returns on every attempt stays
 * for the next startup's remainder cleanup.
 * @returns whether unrecognized files keep the directory.
 */
async function retireSource(sourceDir: string, x: RelocationInternals): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    await removeIfPresent(join(sourceDir, LEASE_FILENAME), x)
    try {
      await x.fs.rmdir(sourceDir)
      break
    } catch (error: unknown) {
      if (hasCode(error, 'ENOENT')) return false
      if (!hasCode(error, 'ENOTEMPTY')) throw error
    }
    if ((await entryNames(sourceDir, x)).some(name => name !== LEASE_FILENAME)) return true
    if (attempt === RETIRE_ATTEMPTS) return false
  }
  await syncDirectory(dirname(sourceDir), x)
  return false
}

/** Remove a Session directory that holds nothing but its lock file; one removed or refilled meanwhile stays as it is. */
async function discardDirectory(dir: string, x: RelocationInternals): Promise<void> {
  if ((await entryNames(dir, x)).some(name => name !== LEASE_FILENAME)) return
  await removeIfPresent(join(dir, LEASE_FILENAME), x)
  try {
    await x.fs.rmdir(dir)
  } catch (error: unknown) {
    // Another remover took the directory first, or a locker recreated its lock file.
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTEMPTY')) return
    throw error
  }
  await syncDirectory(dirname(dir), x)
}

type Barrier = RelocationInternals['barrier']
const noBarrier: Barrier = () => {}

/** Restore the prior generations' names in the target, then remove every source remainder and the intent. */
async function complete(paths: RelocationPaths, x: RelocationInternals, barrier: Barrier): Promise<Completion> {
  const { intent } = paths
  for (const [index, name] of intent.prior.entries()) {
    const restored = await restoreHidden(
      join(paths.targetDir, relocationHiddenName(name, intent.token)),
      join(paths.targetDir, name),
      x,
    )
    if (restored === 'conflict') return { kind: 'conflict', reason: `the target already holds a different "${name}"` }
    await barrier('prior-restored', index)
  }
  await syncDirectory(paths.targetDir, x)
  await removeIfPresent(paths.stagePath, x)
  await removeIfPresent(paths.hiddenCurrent, x)
  const sourceRetained = await retireSource(paths.sourceDir, x)
  await deleteIntent(paths, x)
  await barrier('cleaned')
  return { kind: 'completed', sourceRetained }
}

/** Return every hidden generation to the source, then discard the target remainder and the intent. */
async function rollback(paths: RelocationPaths, x: RelocationInternals): Promise<Rollback> {
  const { intent } = paths
  if (await restoreHidden(paths.hiddenCurrent, paths.sourceCurrent, x) === 'conflict') {
    return { kind: 'conflict', reason: `the source already holds a different "${intent.current}"` }
  }
  for (const name of intent.prior) {
    const restored = await restoreHidden(
      join(paths.targetDir, relocationHiddenName(name, intent.token)),
      join(paths.sourceDir, name),
      x,
    )
    if (restored === 'conflict') return { kind: 'conflict', reason: `the source already holds a different "${name}"` }
  }
  await syncDirectory(paths.sourceDir, x)
  await removeIfPresent(paths.stagePath, x)
  await discardDirectory(paths.targetDir, x)
  await deleteIntent(paths, x)
  return { kind: 'rolled-back' }
}

/** Decide from disk facts alone whether a cross-directory relocation committed. */
async function decide(paths: RelocationPaths, x: RelocationInternals): Promise<Decision> {
  if (await pathExists(paths.targetCurrent, x)) {
    if ((await canonicalNames(paths.sourceDir, x)).length > 0) {
      return { kind: 'conflict', reason: 'both the source and the target hold a stored log' }
    }
    if (!await targetContinuesSource(paths, x)) {
      return { kind: 'conflict', reason: 'the target log does not continue the source current generation' }
    }
    return { kind: 'complete' }
  }
  if ((await canonicalNames(paths.targetDir, x)).length > 0) {
    return { kind: 'conflict', reason: 'the target holds a stored log without its current generation' }
  }
  if (!await pathExists(paths.sourceCurrent, x) && !await pathExists(paths.hiddenCurrent, x)) {
    return { kind: 'conflict', reason: 'the source current generation and its hidden copy are both missing' }
  }
  // Rolling back makes an empty source visible again, next to any Session of the same id stored meanwhile.
  if ((await canonicalNames(paths.sourceDir, x)).length === 0 && await storedElsewhere(paths, x)) {
    return { kind: 'conflict', reason: STORED_ELSEWHERE }
  }
  return { kind: 'rollback' }
}

/** Discard a same-directory stage; whether one remained tells an interrupted move from a replaced log. */
async function settleSameDirectory(paths: RelocationPaths, x: RelocationInternals): Promise<Settlement> {
  const staged = await pathExists(paths.stagePath, x)
  await removeIfPresent(paths.stagePath, x)
  await deleteIntent(paths, x)
  return staged ? { kind: 'rolled-back' } : { kind: 'completed', sourceRetained: false }
}

/** Recover one intent whose directories the caller holds. */
async function recoverHeld(paths: RelocationPaths, x: RelocationInternals): Promise<Settlement> {
  if (paths.intent.sameDirectory) return settleSameDirectory(paths, x)
  const decision = await decide(paths, x)
  if (decision.kind === 'rollback') return rollback(paths, x)
  if (decision.kind === 'complete') return complete(paths, x, noBarrier)
  return decision
}

/** Read one intent file; `undefined` when it is gone. */
async function readIntentIfPresent(
  root: string,
  compression: JsonlCompression,
  path: string,
  x: RelocationInternals,
): Promise<RelocationIntent | undefined> {
  try {
    return await readIntent(root, compression, path, x)
  } catch (error: unknown) {
    if (hasCode(error, 'ENOENT')) return undefined
    throw error
  }
}

/** Attempts at one intent file whose content changes between its read and its locks before it counts as busy. */
const INTENT_READ_ATTEMPTS = 3

/**
 * Recover one intent file while holding the leases of its existing
 * directories; the caller's lease on `held` counts for the directory naming
 * the same physical directory. An intent changes only under the lease of the
 * directory its Session occupies, so the intent read before locking is read
 * again under the leases and recovered only when unchanged.
 */
async function recoverFile(
  root: string,
  compression: JsonlCompression,
  path: string,
  x: RelocationInternals,
  held?: string,
): Promise<Settlement> {
  for (let attempt = 0; attempt < INTENT_READ_ATTEMPTS; attempt += 1) {
    const intent = await readIntentIfPresent(root, compression, path, x)
    if (intent === undefined) return { kind: 'gone' }
    const paths = pathsOf(root, compression, intent)
    const locked: Array<{ readonly dir: string; readonly lease: SessionWriteLease }> = []
    try {
      let busy = false
      for (const dir of intent.sameDirectory ? [paths.sourceDir] : [paths.sourceDir, paths.targetDir]) {
        if (held !== undefined && await relateDirectories(dir, held, x) === 'same') continue
        // Locking an absent directory would recreate it through the lease's mkdir.
        if (!await pathExists(dir, x)) continue
        try {
          locked.push({ dir, lease: await SessionWriteLease.acquire(dir, makeSessionId(intent.id)) })
        } catch (error: unknown) {
          if (!(error instanceof SessionAlreadyOwnedError)) throw error
          busy = true
          break
        }
      }
      const current = busy ? undefined : await readIntentIfPresent(root, compression, path, x)
      if (current !== undefined && isDeepStrictEqual(current, intent)) return await recoverHeld(paths, x)
      // Locking recreates the lock file of a directory a relocation was retiring, which holds nothing else.
      for (const { dir } of locked) await discardDirectory(dir, x)
      if (busy) return { kind: 'busy' }
      if (current === undefined) return { kind: 'gone' }
    } finally {
      for (const { lease } of locked.reverse()) await lease.release()
    }
  }
  return { kind: 'busy' }
}

function conflictError(paths: RelocationPaths, reason: string, cause: unknown): SessionPersistenceCorruptionError {
  return new SessionPersistenceCorruptionError(
    `session "${paths.intent.id}": relocation stopped because ${reason}; the intent "${paths.intentPath}" stays for inspection`,
    { cause },
  )
}

/** How far one relocation call got: whether its intent stands, and whether it reached the commit point. */
interface RelocationProgress {
  intentPublished: boolean
  committed: boolean
}

/** Run the steps for one prepared intent; a thrown failure leaves the disk exactly as it stands. */
async function run(
  plan: JsonlRelocationPlan,
  prepared: PreparedRelocation,
  progress: RelocationProgress,
  signal: AbortSignal | undefined,
  x: RelocationInternals,
): Promise<JsonlRelocationOutcome> {
  const { paths } = prepared
  const { intent } = paths
  await writeIntent(paths, progress, x)
  await x.barrier('intent-written')
  signal?.throwIfAborted()
  await stage(plan, prepared, signal, x)
  await x.barrier('staged')
  signal?.throwIfAborted()
  if (intent.sameDirectory) {
    if (x.platform === 'win32') {
      await x.replaceWin32(paths.stagePath, paths.sourceCurrent)
    } else {
      await x.fs.rename(paths.stagePath, paths.sourceCurrent)
    }
    progress.committed = true
    await syncDirectory(paths.sourceDir, x)
    await x.barrier('replaced')
    await deleteIntent(paths, x)
    return { intentRetained: false, sourceRetained: false }
  }
  for (const [index, name] of intent.prior.entries()) {
    await x.fs.rename(join(paths.sourceDir, name), join(paths.targetDir, relocationHiddenName(name, intent.token)))
    await x.barrier('prior-hidden', index)
    signal?.throwIfAborted()
  }
  await syncDirectory(paths.sourceDir, x)
  await syncDirectory(paths.targetDir, x)
  await x.fs.rename(paths.sourceCurrent, paths.hiddenCurrent)
  await syncDirectory(paths.sourceDir, x)
  await x.barrier('current-hidden')
  signal?.throwIfAborted()
  if (await storedElsewhere(paths, x)) {
    throw new SessionPersistenceCorruptionError(`session "${intent.id}": ${STORED_ELSEWHERE}`, { cause: new Error(STORED_ELSEWHERE) })
  }
  await publishCurrent(paths, x)
  progress.committed = true
  await x.barrier('published')
  const settled = await complete(paths, x, x.barrier)
  if (settled.kind === 'conflict') throw conflictError(paths, settled.reason, undefined)
  return { intentRetained: false, sourceRetained: settled.sourceRetained }
}

/** Settle a failure raised inside one relocation call while its leases are still held. */
async function recoverInCall(
  paths: RelocationPaths,
  progress: Readonly<RelocationProgress>,
  failure: unknown,
  x: RelocationInternals,
): Promise<JsonlRelocationOutcome> {
  const { id } = paths.intent
  const retained = `the intent "${paths.intentPath}" stays for startup recovery`
  const rollbackFailed = (error: unknown): AggregateError =>
    new AggregateError([failure, error], `relocation of session "${id}" failed and its rollback failed; ${retained}`)
  const cleanupFailed = (error: unknown): JsonlRelocationOutcome => ({
    failure: new AggregateError([failure, error], `relocation of session "${id}" committed but its cleanup failed; ${retained}`),
    intentRetained: true,
    sourceRetained: false,
  })
  if (paths.intent.sameDirectory) {
    try {
      await settleSameDirectory(paths, x)
    } catch (error: unknown) {
      if (!progress.committed) throw rollbackFailed(error)
      return cleanupFailed(error)
    }
    if (!progress.committed) throw failure
    return { failure, intentRetained: false, sourceRetained: false }
  }
  let decision: Decision
  try {
    decision = await decide(paths, x)
  } catch (error: unknown) {
    throw new AggregateError([failure, error], `relocation of session "${id}" failed and its storage could not be inspected; ${retained}`)
  }
  if (decision.kind === 'conflict') throw conflictError(paths, decision.reason, failure)
  if (decision.kind === 'rollback') {
    let settled: Rollback
    try {
      settled = await rollback(paths, x)
    } catch (error: unknown) {
      throw rollbackFailed(error)
    }
    if (settled.kind === 'conflict') throw conflictError(paths, settled.reason, failure)
    throw failure
  }
  let settled: Completion
  try {
    settled = await complete(paths, x, noBarrier)
  } catch (error: unknown) {
    return cleanupFailed(error)
  }
  if (settled.kind === 'conflict') {
    return { failure: conflictError(paths, settled.reason, failure), intentRetained: true, sourceRetained: false }
  }
  return { failure, intentRetained: false, sourceRetained: settled.sourceRetained }
}

/** The remainders of one Session that a dead relocation left, found by the root walk. */
interface SessionRemainders {
  /** Names the remainders in a warning. */
  readonly label: string
  readonly id: SessionId
  readonly intentPath: string
  /** Directories whose leases the removal holds; each one holding nothing but a lock file is removed. */
  readonly lock: readonly string[]
  readonly temporaries: readonly string[]
}

/** Remove one Session's remainders under the leases they depend on; a held lease or a standing intent keeps them. */
async function discardSessionRemainders(remainders: SessionRemainders, x: RelocationInternals): Promise<void> {
  // Locking would leave a lock file in every directory of a Session whose intent keeps them.
  if (await pathExists(remainders.intentPath, x)) return
  const leases: SessionWriteLease[] = []
  try {
    for (const dir of remainders.lock) {
      // Locking a directory removed since the walk would recreate it through the lease's mkdir.
      if (!await pathExists(dir, x)) continue
      try {
        leases.push(await SessionWriteLease.acquire(dir, remainders.id))
      } catch (error: unknown) {
        if (error instanceof SessionAlreadyOwnedError) return
        throw error
      }
    }
    // A relocation that published its intent before these leases owns these files until it settles.
    if (await pathExists(remainders.intentPath, x)) return
    for (const path of remainders.temporaries) await removeIfPresent(path, x)
    if (remainders.temporaries.length > 0) await syncDirectory(dirname(remainders.intentPath), x)
    for (const dir of remainders.lock) await discardDirectory(dir, x)
  } finally {
    for (const lease of leases.reverse()) await lease.release()
  }
}

async function discardRemainders(
  root: string,
  directories: readonly JsonlSessionDirectory[],
  warn: (message: string) => void,
  x: RelocationInternals,
): Promise<void> {
  let rootNames: string[]
  try {
    rootNames = await x.fs.readdir(root)
  } catch (error: unknown) {
    if (!hasCode(error, 'ENOENT')) warn(`relocation remainders under "${root}" cannot be listed: ${String(error)}`)
    return
  }
  const temporaries = new Map<string, string[]>()
  for (const name of rootNames.filter(entry => INTENT_TEMPORARY.test(entry))) {
    const intent = name.slice(0, name.indexOf('.json.') + '.json'.length)
    temporaries.set(intent, [...temporaries.get(intent) ?? [], join(root, name)])
  }
  const sessions = new Map<string, JsonlSessionDirectory[]>()
  for (const entry of directories) sessions.set(basename(entry.dir), [...sessions.get(basename(entry.dir)) ?? [], entry])
  const found: SessionRemainders[] = []
  for (const [segment, dirs] of sessions) {
    const id = makeSessionId(decodeSegment(segment))
    const intentPath = relocationIntentPath(root, id)
    const temps = temporaries.get(basename(intentPath)) ?? []
    temporaries.delete(basename(intentPath))
    const empty = dirs.filter(entry => entry.names.every(name => name === LEASE_FILENAME)).map(entry => entry.dir)
    const stored = dirs.some(entry => entry.names.some(isCanonicalName))
    if (temps.length === 0 && (empty.length === 0 || !stored)) continue
    found.push({
      label: `session "${id}"`, id, intentPath, lock: temps.length > 0 ? dirs.map(entry => entry.dir) : empty, temporaries: temps,
    })
  }
  // No relocation is in flight for a Session without a directory, so nothing writes these intent temporaries.
  for (const [intent, temps] of temporaries) {
    const intentPath = join(root, intent)
    found.push({ label: `intent "${intentPath}"`, id: makeSessionId(intent), intentPath, lock: [], temporaries: temps })
  }
  for (const remainders of found) {
    try {
      await discardSessionRemainders(remainders, x)
    } catch (error: unknown) {
      warn(`relocation remainders of ${remainders.label} stay: ${String(error)}`)
    }
  }
}

function withOverrides(overrides: JsonlRelocationRuntimeOverrides): RelocationInternals {
  return {
    ...defaultInternals,
    ...overrides,
    fs: { ...defaultFileSystem, ...overrides.fs },
  }
}

/**
 * Create one relocation runtime with fixed filesystem, platform, verifier,
 * and barrier dependencies.
 * @param overrides - deterministic filesystem, platform, verifier, and crash dependencies.
 * @returns bound relocation operations.
 */
export function createJsonlRelocationRuntime(
  overrides: JsonlRelocationRuntimeOverrides = {},
): JsonlRelocationRuntime {
  const x = withOverrides(overrides)
  return {
    async execute(plan, signal) {
      return run(plan, await prepareIntent(plan, signal, x), { intentPublished: false, committed: false }, signal, x)
    },
    async relocate(plan, signal) {
      let prepared: PreparedRelocation | undefined
      const progress: RelocationProgress = { intentPublished: false, committed: false }
      try {
        prepared = await prepareIntent(plan, signal, x)
        return await run(plan, prepared, progress, signal, x)
      } catch (failure: unknown) {
        if (prepared !== undefined && progress.intentPublished) return recoverInCall(prepared.paths, progress, failure, x)
        // Nothing moved and no intent of this call stands; an intent already at its path belongs to another relocation.
        if (prepared !== undefined) await removeIfPresent(prepared.paths.intentTemporary, x)
        if (!plan.sameDirectory) await discardDirectory(plan.targetDir, x)
        throw failure
      }
    },
    async settle(root, compression, id, held) {
      const path = relocationIntentPath(root, id)
      if (!await pathExists(path, x)) return false
      const settled = await recoverFile(root, compression, path, x, held)
      if (settled.kind === 'busy') throw new SessionAlreadyOwnedError(id)
      if (settled.kind === 'conflict') {
        throw new SessionPersistenceCorruptionError(
          `session "${id}": an earlier relocation cannot settle because ${settled.reason} (intent: ${path})`,
          { cause: new Error(settled.reason) },
        )
      }
      return true
    },
    async sweep(root, compression, warn) {
      let names: string[]
      try {
        names = await x.fs.readdir(root)
      } catch (error: unknown) {
        if (!hasCode(error, 'ENOENT')) warn(`relocation intents under "${root}" cannot be listed: ${String(error)}`)
        return
      }
      for (const name of names.filter(entry => INTENT_FILE.test(entry)).sort()) {
        const path = join(root, name)
        try {
          const settled = await recoverFile(root, compression, path, x)
          if (settled.kind === 'busy') {
            warn(`relocation intent "${path}" stays: another holder keeps one of its directories`)
          } else if (settled.kind === 'conflict') {
            warn(`relocation intent "${path}" stays: ${settled.reason}`)
          } else if (settled.kind === 'completed' && settled.sourceRetained) {
            warn(`relocation intent "${path}" completed; its source directory holds other files and stays`)
          }
        } catch (error: unknown) {
          warn(`relocation intent "${path}" stays: ${String(error)}`)
        }
      }
    },
    discardRemainders: (root, directories, warn) => discardRemainders(root, directories, warn, x),
    isSameDirectory: async (target, source) => await relateDirectories(target, source, x) === 'same',
    discardDirectory: dir => discardDirectory(dir, x),
  }
}
