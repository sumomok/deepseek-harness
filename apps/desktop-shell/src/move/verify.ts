/**
 * Checking a copy against its source before the source is given up
 * (design doc 3.5).
 *
 * Both trees are read directory by directory and compared by their exact name
 * sets, so a name the target file system changed (Unicode normalization,
 * letter case) shows up as one missing and one extra entry. Files must match
 * their done-log record in size, the source must still be what was copied
 * (size, modification time, inode), permission bits must match (except on
 * Windows, which has none), and, where asked, the copy is read again
 * and its SHA-256 compared with the record. Links must hold the text the
 * copier gives them, and no link may resolve into the old home, neither by
 * its text nor on disk.
 *
 * The check returns every problem it finds; repairing them is the caller's
 * decision.
 * @module @deepseek-ai/dsh-desktop-shell/move/verify
 */

import { lstat, readdir, readlink } from 'node:fs/promises'
import { realpathSync, type Stats } from 'node:fs'
import { posix, win32 } from 'node:path'
import { DATA_ID_FILENAME } from '../data-location.ts'
import { fromExtendedLengthPath } from '../link-target.ts'
import { hashFile, planLinkResolved, readDoneLog, type ByteProgress, type CopyRequest } from './copier.ts'
import { linkCreation, sameTarget } from './links.ts'
import { isIgnorableName, isInsidePath, MOVE_STATE_FILENAME, nativePath } from './tree.ts'

/** One way the copy differs from the source. */
export type VerifyProblem =
  | { kind: 'missing'; rel: string }
  | { kind: 'extra'; rel: string }
  | { kind: 'type'; rel: string }
  | { kind: 'not-recorded'; rel: string }
  | { kind: 'source-changed'; rel: string }
  | { kind: 'size'; rel: string }
  | { kind: 'mode'; rel: string }
  | { kind: 'content'; rel: string }
  | { kind: 'link'; rel: string; expected: string; actual: string }
  | { kind: 'link-into-old-root'; rel: string; resolved: string }

/** What {@link verifyTree} checks. */
export interface VerifyRequest extends CopyRequest {
  /** Which files are read again and hashed: all, none, or the listed relative paths. */
  hash: 'all' | 'none' | readonly string[]
}

/** What the check found. */
export interface VerifyReport {
  problems: VerifyProblem[]
  /** Files compared. */
  files: number
  /** Bytes read again to hash. */
  hashedBytes: number
}

/** Names at the top of a home that are not data: the identity and the move marker. */
const ROOT_MARKERS = new Set([DATA_ID_FILENAME, MOVE_STATE_FILENAME])

type Kind = 'dir' | 'file' | 'link' | 'other'

/**
 * The kind of an entry, without following a link.
 * @param stats - its `lstat`.
 * @returns the kind.
 */
function kindOf(stats: Stats): Kind {
  if (stats.isSymbolicLink()) return 'link'
  if (stats.isDirectory()) return 'dir'
  return stats.isFile() ? 'file' : 'other'
}

/**
 * Compare the copy with the source.
 * @param request - the trees, the exclusions, how links moved, the done log, and what to hash.
 * @param signal - stops the check between entries and chunks.
 * @param onProgress - called with the bytes hashed so far.
 * @param onActivity - called after every entry compared, so a watcher can tell a slow check from a hung one.
 * @returns every problem found; none means the copy matches.
 * @throws on abort, or when either tree cannot be read.
 */
export async function verifyTree(
  request: VerifyRequest, signal?: AbortSignal, onProgress?: (progress: ByteProgress) => void, onActivity?: () => void,
): Promise<VerifyReport> {
  const { source, dest, links } = request
  const platform = links.platform
  const api = platform === 'win32' ? win32 : posix
  const exclude = new Set(request.exclude)
  const done = readDoneLog(request.doneLog)
  const selected = request.hash === 'all' || request.hash === 'none' ? undefined : new Set(request.hash)
  const shouldHash = (rel: string): boolean => request.hash === 'all' || (selected?.has(rel) ?? false)
  const report: VerifyReport = { problems: [], files: 0, hashedBytes: 0 }
  const sameMode = (a: number, b: number): boolean => platform === 'win32' || (a & 0o7777) === (b & 0o7777)
  const total = request.hash === 'none'
    ? 0
    : [...done.values()].filter(record => shouldHash(record.rel)).reduce((sum, record) => sum + record.size, 0)
  const progress: ByteProgress = { done: 0, total }

  const listed = async (root: string, rel: string, atRoot: boolean): Promise<Map<string, Kind>> => {
    const kinds = new Map<string, Kind>()
    for (const name of await readdir(nativePath(root, rel))) {
      const child = rel === '' ? name : `${rel}/${name}`
      if (atRoot && ROOT_MARKERS.has(name)) continue
      if (exclude.has(child)) continue
      kinds.set(name, kindOf(await lstat(nativePath(root, child))))
    }
    return kinds
  }

  const checkLink = async (rel: string): Promise<void> => {
    const finalPath = nativePath(links.destRoot, rel)
    const original = await readlink(nativePath(source, rel))
    const plan = planLinkResolved(original, rel, links)
    const raw = plan.kind === 'keep' ? original : plan.target
    const expected = linkCreation(raw, finalPath, platform).target
    const actual = await readlink(nativePath(dest, rel))
    if (!sameTarget(actual, expected, api.dirname(finalPath), platform)) {
      report.problems.push({ kind: 'link', rel, expected, actual })
    }
    const text = fromExtendedLengthPath(actual)
    const byText = api.resolve(api.dirname(finalPath), text)
    if (links.sourceRoots.some(root => isInsidePath(byText, root, platform))) {
      report.problems.push({ kind: 'link-into-old-root', rel, resolved: byText })
      return
    }
    let onDisk: string
    try {
      onDisk = realpathSync(api.resolve(api.dirname(nativePath(dest, rel)), text))
    } catch {
      // ENOENT for a dangling link: nothing on disk to resolve, and its text
      // was checked above.
      return
    }
    if (links.sourceRoots.some(root => isInsidePath(onDisk, root, platform))) {
      report.problems.push({ kind: 'link-into-old-root', rel, resolved: onDisk })
    }
  }

  const checkFile = async (rel: string): Promise<void> => {
    report.files += 1
    const record = done.get(rel)
    if (record === undefined) {
      report.problems.push({ kind: 'not-recorded', rel })
      return
    }
    const now = await lstat(nativePath(source, rel))
    if (now.size !== record.size || now.mtimeMs !== record.mtimeMs || now.ino !== record.ino) {
      report.problems.push({ kind: 'source-changed', rel })
      return
    }
    const copy = await lstat(nativePath(dest, rel))
    if (copy.size !== record.size) {
      report.problems.push({ kind: 'size', rel })
      return
    }
    if (!sameMode(now.mode, copy.mode)) {
      report.problems.push({ kind: 'mode', rel })
      return
    }
    if (!shouldHash(rel)) return
    const digest = await hashFile(nativePath(dest, rel), signal, (bytes) => {
      report.hashedBytes += bytes
      progress.done += bytes
      onProgress?.(progress)
    })
    if (digest !== record.sha256) report.problems.push({ kind: 'content', rel })
  }

  const walk = async (rel: string): Promise<void> => {
    signal?.throwIfAborted()
    const atRoot = rel === ''
    const sourceKinds = await listed(source, rel, atRoot)
    const destKinds = await listed(dest, rel, atRoot)
    for (const [name, kind] of sourceKinds) {
      signal?.throwIfAborted()
      const child = atRoot ? name : `${rel}/${name}`
      if (kind === 'other') continue
      const copied = destKinds.get(name)
      if (copied === undefined) {
        report.problems.push({ kind: 'missing', rel: child })
        continue
      }
      if (copied !== kind) {
        report.problems.push({ kind: 'type', rel: child })
        continue
      }
      onActivity?.()
      if (kind === 'dir') {
        const [from, to] = await Promise.all([lstat(nativePath(source, child)), lstat(nativePath(dest, child))])
        if (!sameMode(from.mode, to.mode)) report.problems.push({ kind: 'mode', rel: child })
        await walk(child)
      } else if (kind === 'file') await checkFile(child)
      else await checkLink(child)
    }
    for (const name of destKinds.keys()) {
      // A file browser may drop its own files into the copy while it is open;
      // they are not data and are not reported.
      if (isIgnorableName(name, platform) && !sourceKinds.has(name)) continue
      if (sourceKinds.get(name) === undefined || sourceKinds.get(name) === 'other') {
        report.problems.push({ kind: 'extra', rel: atRoot ? name : `${rel}/${name}` })
      }
    }
  }

  await walk('')
  return report
}
