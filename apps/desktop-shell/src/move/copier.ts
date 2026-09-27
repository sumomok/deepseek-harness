/**
 * Copying a directory tree to another volume so that an interruption at any
 * moment loses at most the file being copied.
 *
 * Every file is read once while its SHA-256 is computed, written, flushed,
 * then read back from the destination and hashed again; the two digests must
 * match. Only then is one line appended to the done log: the relative path,
 * the size, the source's modification time and inode as `fstat` reported them
 * when it was opened, and the digest. A later run skips a file whose line
 * matches both the source as it is now and the size of the copy, and copies
 * everything else again. The log is appended without a flush: a lost tail only
 * makes files copy again, and a torn last line is ignored.
 *
 * Links are recreated with the text {@link planLinkResolved} gives, resolved
 * against their final place (the copy is renamed into place later), never
 * followed. Sockets, pipes, and devices are not copied. Directory permissions
 * are applied last, so a read-only directory does not stop its own copy.
 *
 * The readback shows that what was written is what reads back; it may come
 * from the page cache rather than the disk surface (design doc 3.5).
 *
 * Contents, permission bits, and modification times are copied; extended
 * attributes (macOS quarantine flags, Finder tags, resource forks), ACLs, and
 * ownership are not. The copy is the home's data, which the Harness writes
 * itself and reads through none of those.
 * @module @deepseek-ai/dsh-desktop-shell/move/copier
 */

import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, realpathSync, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, readlink, symlink, utimes } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { fsyncDirectory, writeDurably } from '../durable-file.ts'
import { fromExtendedLengthPath } from '../link-target.ts'
import { linkCreation, planLink, sameTarget, type LinkMove, type LinkPlan } from './links.ts'
import { removeTree } from './remove.ts'
import { isInsidePath, nativePath, scanTree, type TreeEntry, type TreeScan } from './tree.ts'

/** Bytes read and written per step. */
export const COPY_CHUNK_BYTES = 1024 * 1024

/** One line of the done log. */
export interface DoneRecord {
  rel: string
  /** Bytes copied. */
  size: number
  /** The source's modification time when it was opened for the copy. */
  mtimeMs: number
  /** The source's inode when it was opened for the copy. */
  ino: number
  /** SHA-256 of the bytes copied, hex. */
  sha256: string
}

/**
 * Check one parsed done-log line.
 * @param value - the parsed JSON.
 * @returns the record, or `undefined` when a field is missing or of the wrong type.
 */
function doneRecord(value: unknown): DoneRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { rel, size, mtimeMs, ino, sha256 } = value as Record<string, unknown>
  if (typeof rel !== 'string' || typeof size !== 'number' || typeof mtimeMs !== 'number') return undefined
  if (typeof ino !== 'number' || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return undefined
  return { rel, size, mtimeMs, ino, sha256 }
}

/**
 * Parse a done log. Lines that do not parse (a torn last line) are ignored; a
 * later line for the same path replaces an earlier one.
 * @param text - the log's content.
 * @returns the records by relative path.
 */
export function parseDoneLog(text: string): Map<string, DoneRecord> {
  const done = new Map<string, DoneRecord>()
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // A torn line from an interrupted append: that file is copied again.
      continue
    }
    const record = doneRecord(parsed)
    if (record !== undefined) done.set(record.rel, record)
  }
  return done
}

/**
 * Read a done log.
 * @param file - the log.
 * @returns the records; none when the log does not exist.
 * @throws when the log exists but cannot be read.
 */
export function readDoneLog(file: string): Map<string, DoneRecord> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    throw error
  }
  return parseDoneLog(text)
}

/**
 * Drop records from a done log, so those files are copied again.
 * @param file - the log.
 * @param rels - the relative paths to forget.
 * @throws when the log cannot be rewritten.
 */
export function forgetDone(file: string, rels: ReadonlySet<string>): void {
  const kept = [...readDoneLog(file).values()].filter(record => !rels.has(record.rel))
  writeDurably(file, Buffer.from(kept.map(record => `${JSON.stringify(record)}\n`).join('')))
}

/**
 * What one link becomes: {@link planLink}, and in addition an absolute link
 * that is kept but resolves on disk into the old home through a spelling the
 * plan does not know (a parent folder reached through another link) is
 * rewritten to the same place in the new home.
 * @param raw - the link's text.
 * @param rel - its relative path.
 * @param move - the old and new homes.
 * @param realpath - resolves a path on disk; throws when it does not exist.
 * @returns the plan.
 */
export function planLinkResolved(raw: string, rel: string, move: LinkMove, realpath: (path: string) => string = realpathSync): LinkPlan {
  const plan = planLink(raw, rel, move)
  if (plan.kind === 'rewrite') return plan
  const api = move.platform === 'win32' ? win32 : posix
  // A relative text the plan kept stays inside the home by its text, which
  // is what it will mean at the new place too.
  if (!api.isAbsolute(fromExtendedLengthPath(raw))) return plan
  const [canonical] = move.sourceRoots
  if (canonical === undefined) return plan
  const linkDir = api.dirname(rel === '' ? canonical : api.join(canonical, ...rel.split('/')))
  let real: string
  try {
    real = realpath(api.resolve(linkDir, fromExtendedLengthPath(raw)))
  } catch {
    // ENOENT for a dangling link, or anything else unreachable: its text
    // cannot be resolved on disk, and the text alone decided.
    return plan
  }
  if (!isInsidePath(real, canonical, move.platform)) return plan
  const inner = api.relative(canonical, real)
  return { kind: 'rewrite', target: inner === '' ? move.destRoot : api.join(move.destRoot, inner), reason: 'inside-root' }
}

/** Progress of a copy or a check, in bytes. */
export interface ByteProgress {
  done: number
  total: number
}

/** What {@link copyTree} is asked to do. */
export interface CopyRequest {
  /** The real path of the tree to copy. */
  source: string
  /** Where the copy is made (the partial folder); created when missing. */
  dest: string
  /** Relative paths left out, with everything below them. */
  exclude: readonly string[]
  /** How links move; `destRoot` is where the copy will finally live, not `dest`. */
  links: LinkMove
  /** The done log. */
  doneLog: string
}

/** What a copy did. */
export interface CopyReport {
  /** Files written this run. */
  copied: string[]
  /** Files skipped because the done log already had them. */
  skipped: number
  /** Bytes written this run. */
  bytesCopied: number
  /** The scan the copy followed. */
  scan: TreeScan
}

/** Thrown when a file reads back different from what was written. */
export class CopyMismatchError extends Error {
  /** The file's relative path. */
  readonly rel: string

  /** @param rel - the file's relative path. */
  constructor(rel: string) {
    super(`${rel} read back different from what was written`)
    this.name = 'CopyMismatchError'
    this.rel = rel
  }
}

/**
 * Hash a file.
 * @param path - the file.
 * @param signal - stops between chunks.
 * @param onBytes - called with each chunk's size.
 * @returns the hex SHA-256.
 */
export async function hashFile(path: string, signal?: AbortSignal, onBytes?: (bytes: number) => void): Promise<string> {
  const hash = createHash('sha256')
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
    for (;;) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      onBytes?.(bytesRead)
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

/**
 * Copy one file, hashing on the way, flush it, read it back and compare.
 * @param source - the source file.
 * @param dest - the destination; must not exist.
 * @param rel - the relative path, for the record.
 * @param mode - permission bits to give the copy once written.
 * @param signal - stops between chunks.
 * @param onBytes - called with each chunk's size.
 * @returns the record to log.
 * @throws a {@link CopyMismatchError} when the readback differs.
 */
async function copyFileChecked(
  source: string, dest: string, rel: string, mode: number, signal: AbortSignal | undefined, onBytes: (bytes: number) => void,
): Promise<DoneRecord> {
  const input = await open(source, 'r')
  let record: DoneRecord
  try {
    const stats = await input.stat()
    const output = await open(dest, 'wx', 0o600)
    const hash = createHash('sha256')
    let size = 0
    try {
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
      for (;;) {
        signal?.throwIfAborted()
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
        if (bytesRead === 0) break
        const chunk = buffer.subarray(0, bytesRead)
        hash.update(chunk)
        let written = 0
        while (written < bytesRead) written += (await output.write(chunk, written, bytesRead - written)).bytesWritten
        size += bytesRead
        onBytes(bytesRead)
      }
      await output.sync()
    } finally {
      await output.close()
    }
    record = { rel, size, mtimeMs: stats.mtimeMs, ino: stats.ino, sha256: hash.digest('hex') }
    await utimes(dest, stats.atime, stats.mtime)
  } finally {
    await input.close()
  }
  if (await hashFile(dest, signal) !== record.sha256) throw new CopyMismatchError(rel)
  await chmod(dest, mode)
  return record
}

/**
 * Whether a done record still describes both the source and its copy.
 * @param record - the record.
 * @param entry - the source file as scanned now.
 * @param destSize - the copy's size, or `undefined` when there is no copy.
 * @returns true when the file need not be copied again.
 */
export function recordStillHolds(record: DoneRecord | undefined, entry: Extract<TreeEntry, { kind: 'file' }>, destSize: number | undefined): boolean {
  return record !== undefined && record.size === entry.size && record.mtimeMs === entry.mtimeMs && record.ino === entry.ino
    && destSize === record.size
}

/**
 * What is at `path`, without following a link.
 * @param path - the path.
 * @returns its stats, or `undefined` when nothing is there.
 */
async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Remove whatever is at `path` so something else can be created there.
 * @param path - the path.
 * @param platform - the platform.
 * @throws when something remains.
 */
async function clear(path: string, platform: NodeJS.Platform): Promise<void> {
  const report = await removeTree(path, { platform })
  if (report.leftovers.length > 0) throw new Error(`cannot replace ${path}: ${report.leftovers.map(left => `${left.path} ${left.code}`).join(', ')}`)
}

/**
 * Copy `source` into `dest`, resuming from the done log.
 * @param request - the trees, what to leave out, how links move, and the done log.
 * @param signal - stops the copy between chunks.
 * @param onProgress - called with the bytes handled so far, skipped files included.
 * @param onActivity - called after every entry read or written, so a watcher can tell a slow copy from a hung one.
 * @returns what was copied.
 * @throws on abort, on a {@link CopyMismatchError}, or when a file cannot be read or written.
 */
export async function copyTree(
  request: CopyRequest, signal?: AbortSignal, onProgress?: (progress: ByteProgress) => void, onActivity?: () => void,
): Promise<CopyReport> {
  const { source, dest, links } = request
  const platform = links.platform
  const scan = await scanTree(source, { exclude: request.exclude, signal, onActivity })
  const done = readDoneLog(request.doneLog)
  const report: CopyReport = { copied: [], skipped: 0, bytesCopied: 0, scan }
  const progress: ByteProgress = { done: 0, total: scan.bytes }
  const advance = (bytes: number): void => {
    progress.done += bytes
    onProgress?.(progress)
    onActivity?.()
  }
  await mkdir(dest, { recursive: true, mode: 0o700 })
  const dirs: Array<{ path: string; mode: number }> = [{ path: dest, mode: 0o700 }]
  for (const entry of scan.entries) {
    signal?.throwIfAborted()
    onActivity?.()
    const target = nativePath(dest, entry.rel)
    const existing = await lstatOrUndefined(target)
    switch (entry.kind) {
      case 'dir': {
        if (existing !== undefined && !existing.isSymbolicLink() && existing.isDirectory()) {
          await chmod(target, (existing.mode & 0o777) | 0o700)
        } else {
          if (existing !== undefined) await clear(target, platform)
          await mkdir(target, { mode: 0o700 })
        }
        dirs.push({ path: target, mode: entry.mode })
        break
      }
      case 'file': {
        const destSize = existing !== undefined && existing.isFile() ? existing.size : undefined
        if (recordStillHolds(done.get(entry.rel), entry, destSize)) {
          report.skipped += 1
          advance(entry.size)
          break
        }
        if (existing !== undefined) await clear(target, platform)
        const record = await copyFileChecked(nativePath(source, entry.rel), target, entry.rel, entry.mode, signal, advance)
        appendFileSync(request.doneLog, `${JSON.stringify(record)}\n`)
        report.copied.push(entry.rel)
        report.bytesCopied += record.size
        // A file that grew during the copy moves the total with it.
        if (record.size !== entry.size) progress.total += record.size - entry.size
        break
      }
      case 'link': {
        const plan = planLinkResolved(entry.target, entry.rel, links)
        const finalPath = nativePath(links.destRoot, entry.rel)
        const creation = linkCreation(plan.kind === 'keep' ? entry.target : plan.target, finalPath, platform)
        if (existing?.isSymbolicLink() === true) {
          const current = await readlink(target)
          if (sameTarget(current, creation.target, posixOrWin(platform).dirname(finalPath), platform)) break
        }
        if (existing !== undefined) await clear(target, platform)
        await symlink(creation.target, target, creation.type)
        break
      }
      case 'other':
        break
      default:
        entry satisfies never
    }
  }
  for (const dir of dirs.reverse()) {
    fsyncDirectory(dir.path)
    await chmod(dir.path, dir.mode)
  }
  return report
}

/**
 * The path module of `platform`.
 * @param platform - the platform.
 * @returns `win32` or `posix`.
 */
function posixOrWin(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

/**
 * Remove a file from the destination that is no longer in the source.
 * @param dest - the destination root.
 * @param rel - the relative path.
 * @param platform - the platform.
 * @throws when it cannot be removed.
 */
export async function removeExtra(dest: string, rel: string, platform: NodeJS.Platform): Promise<void> {
  const path = nativePath(dest, rel)
  const parent = posixOrWin(platform).dirname(path)
  const stats = await lstatOrUndefined(parent)
  if (stats !== undefined) await chmod(parent, (stats.mode & 0o777) | 0o700)
  await clear(path, platform)
}
