/**
 * Keep the default home `~/.dsh` pointing at the data directory the pointer
 * names, so a terminal `dsh` without `DSH_HOME` reads and writes the same data
 * as the desktop app.
 *
 * Only the entry `~/.dsh` itself is ever changed, and only when it is absent or
 * a link: a link (a junction on Windows, which needs no developer mode) is
 * removed with `unlink`, which removes the link and never what it points to.
 * A real directory or file there is left exactly as it is and reported —
 * whether it carries this installation's identity marker (a copy left behind)
 * or not (someone else's data) — because replacing it would mean deleting it.
 *
 * When the data directory is on a disk that is not attached, the link
 * dangles. The upstream CLI then fails with `ENOENT` on its first `mkdir`
 * under the home and creates nothing, neither at the link nor at its target.
 * @module @deepseek-ai/dsh-desktop-shell/home-link
 */

import { lstatSync, readlinkSync, symlinkSync, unlinkSync, type Stats } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { readDataId, type DataId } from './data-location.ts'
import { fromExtendedLengthPath, sameLinkTarget } from './profile-seed.ts'

/** What calibration reads from `lstat`. */
export type LinkStats = Pick<Stats, 'isSymbolicLink' | 'isDirectory'>

/** The file-system calls calibration makes; replaced in tests to stand in for Windows. */
export interface LinkFs {
  lstat: (path: string) => LinkStats
  readlink: (path: string) => string
  symlink: (target: string, path: string, type: 'junction' | undefined) => void
  unlink: (path: string) => void
}

/** The real file system. */
export const NODE_LINK_FS: LinkFs = {
  lstat: path => lstatSync(path),
  readlink: path => readlinkSync(path),
  symlink: (target, path, type) => { symlinkSync(target, path, type) },
  unlink: (path) => { unlinkSync(path) },
}

/**
 * The directory `~/.dsh` links to, when it is a link. A `DSH_HOME` naming
 * `~/.dsh` means that directory: recording the link itself would make the
 * pointer name the link this module rewrites, so the data would be taken for
 * wherever the link points next. Any link there counts, since calibration
 * re-points every link at `~/.dsh` whoever made it.
 * @param defaultHome - the default home, `~/.dsh`.
 * @param fs - the file-system calls; the real ones when absent.
 * @returns the absolute target, even when it does not exist, or `undefined` when `~/.dsh` is not a link.
 */
export function defaultHomeLinkTarget(defaultHome: string, fs: LinkFs = NODE_LINK_FS): string | undefined {
  let target: string
  try {
    if (!fs.lstat(defaultHome).isSymbolicLink()) return undefined
    target = fs.readlink(defaultHome)
  } catch {
    // ENOENT, or anything else that keeps `~/.dsh` from being read as a
    // link: the value then means the path itself, as it always did.
    return undefined
  }
  return resolve(dirname(defaultHome), fromExtendedLengthPath(target))
}

/** What calibration found at `~/.dsh` and did about it. */
export type HomeLinkOutcome =
  | { kind: 'not-needed' }
  | { kind: 'already-correct' }
  | { kind: 'created' }
  | { kind: 'repointed'; previous: string }
  | { kind: 'kept-directory'; reason: 'foreign' | 'same-id' }
  | { kind: 'kept-other' }
  | { kind: 'failed'; detail: string }

/** Inputs of {@link calibrateHomeLink}. */
export interface HomeLinkInput {
  /** The default home, `~/.dsh`. */
  defaultHome: string
  /** The data directory the pointer names. */
  dataHome: string
  /** The identity the data directory carries. */
  dataId: DataId
  platform: NodeJS.Platform
  fs?: LinkFs
}

/**
 * Point `~/.dsh` at the data directory when it is absent or a link to anywhere
 * else, and report what is there otherwise.
 * @param input - the two directories, the data identity, and the platform.
 * @returns what was found and done; failures are reported, not thrown.
 */
export function calibrateHomeLink(input: HomeLinkInput): HomeLinkOutcome {
  const { defaultHome, dataHome, dataId } = input
  const fs = input.fs ?? NODE_LINK_FS
  if (resolve(defaultHome) === resolve(dataHome)) return { kind: 'not-needed' }
  const type = input.platform === 'win32' ? 'junction' : undefined
  let existing: LinkStats | undefined
  try {
    existing = fs.lstat(defaultHome)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'failed', detail: String(error) }
    existing = undefined
  }
  try {
    if (existing === undefined) {
      fs.symlink(dataHome, defaultHome, type)
      return { kind: 'created' }
    }
    if (existing.isSymbolicLink()) {
      const previous = fs.readlink(defaultHome)
      if (sameLinkTarget(previous, dataHome, dirname(defaultHome))) return { kind: 'already-correct' }
      fs.unlink(defaultHome)
      fs.symlink(dataHome, defaultHome, type)
      return { kind: 'repointed', previous }
    }
  } catch (error) {
    return { kind: 'failed', detail: String(error) }
  }
  if (!existing.isDirectory()) return { kind: 'kept-other' }
  const id = readDataId(defaultHome)
  return { kind: 'kept-directory', reason: id.kind === 'ok' && id.id === dataId ? 'same-id' : 'foreign' }
}
