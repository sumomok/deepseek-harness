/**
 * What becomes of each link when the Harness home moves.
 *
 * A link whose target lies inside the old home (the profiles keep absolute
 * links into their own `.dsh-module-fallback`, design doc 1.3) is rewritten to
 * the same place inside the new home; otherwise it would keep resolving into
 * the old home and break once that is deleted. A relative link that stays
 * inside the home keeps its text. A relative link that climbs out of the home
 * would name a different place after the move, so it is rewritten to the
 * absolute path it named. Every other link keeps its text.
 *
 * The old home can be named more than one way — the path the shell was given,
 * its real path, a `~/.dsh` link to it — and links carry whichever spelling
 * their writer used, so every alias counts as the old home.
 *
 * Windows makes directory links as junctions, which store an absolute target.
 * Node resolves a relative junction target against the process's working
 * directory, not the link's, so {@link linkCreation} resolves it first.
 * @module @deepseek-ai/dsh-desktop-shell/move/links
 */

import { lstatSync, readlinkSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { fromExtendedLengthPath } from '../link-target.ts'
import { isInsidePath } from './tree.ts'

/** Where a move takes links from and to. */
export interface LinkMove {
  /** Every spelling of the old home; the first is its real path, which relative links resolve against. */
  sourceRoots: readonly string[]
  /** The new home. */
  destRoot: string
  platform: NodeJS.Platform
}

/** What happens to one link. */
export type LinkPlan =
  | { kind: 'keep' }
  | { kind: 'rewrite'; target: string; reason: 'inside-root' | 'relative-escapes-root' }

/**
 * The path functions of `platform`.
 * @param platform - the platform.
 * @returns its path module.
 */
function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

/**
 * Decide what one link becomes.
 * @param raw - the link's text as `readlink` returned it.
 * @param rel - the link's path relative to the home, `/`-separated.
 * @param move - the old and new homes.
 * @returns keep the text, or the new target.
 */
export function planLink(raw: string, rel: string, move: LinkMove): LinkPlan {
  const api = pathApi(move.platform)
  const text = fromExtendedLengthPath(raw)
  const [canonical] = move.sourceRoots
  if (canonical === undefined) throw new Error('planLink: no source root')
  if (api.isAbsolute(text)) {
    for (const root of move.sourceRoots) {
      if (!isInsidePath(text, root, move.platform)) continue
      const inner = api.relative(api.resolve(root), api.resolve(text))
      return { kind: 'rewrite', target: inner === '' ? move.destRoot : api.join(move.destRoot, inner), reason: 'inside-root' }
    }
    return { kind: 'keep' }
  }
  const linkDir = api.dirname(nativePathFor(api, canonical, rel))
  const resolved = api.resolve(linkDir, text)
  if (isInsidePath(resolved, canonical, move.platform)) return { kind: 'keep' }
  return { kind: 'rewrite', target: resolved, reason: 'relative-escapes-root' }
}

/**
 * `rel` under `root` with the given path module, so plans for Windows can be
 * computed on any host.
 * @param api - the path module.
 * @param root - the root.
 * @param rel - the `/`-separated relative path.
 * @returns the joined path.
 */
function nativePathFor(api: typeof posix, root: string, rel: string): string {
  return rel === '' ? root : api.join(root, ...rel.split('/'))
}

/**
 * The target text a link has at its new place.
 * @param raw - the link's text in the old home.
 * @param rel - its relative path.
 * @param move - the old and new homes.
 * @returns the text to create the link with (before {@link linkCreation}).
 */
export function movedLinkTarget(raw: string, rel: string, move: LinkMove): string {
  const plan = planLink(raw, rel, move)
  return plan.kind === 'keep' ? raw : plan.target
}

/** The arguments `symlink` takes for one link. */
export interface LinkCreation {
  target: string
  type: 'junction' | 'file' | undefined
}

/**
 * How to create a link at `linkPath` with `target` on `platform`. POSIX makes
 * a plain symbolic link with the text unchanged. Windows makes a junction for
 * a directory (no developer mode needed; the target is made absolute against
 * the link's own directory) and a file symbolic link otherwise; a target that
 * does not exist is taken for a directory, since the links a Harness home
 * holds are package directories.
 * @param target - the target text.
 * @param linkPath - where the link is created.
 * @param platform - the platform.
 * @param isFile - tells whether the resolved target is a file; follows links on disk in the app.
 * @returns the `symlink` arguments.
 */
export function linkCreation(
  target: string,
  linkPath: string,
  platform: NodeJS.Platform,
  isFile: (path: string) => boolean = targetIsFile,
): LinkCreation {
  if (platform !== 'win32') return { target, type: undefined }
  const absolute = win32.resolve(win32.dirname(linkPath), fromExtendedLengthPath(target))
  return isFile(absolute) ? { target, type: 'file' } : { target: absolute, type: 'junction' }
}

/**
 * Whether a path is a file, following links.
 * @param path - the path.
 * @returns true for a file; false for a directory, a missing path, or anything unreadable.
 */
function targetIsFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    // ENOENT for a dangling target: taken for a directory, as documented.
    return false
  }
}

/**
 * Whether two link texts name the same place, by `platform`'s path rules: the
 * extended-length prefix and a trailing separator are ignored, a relative
 * text resolves against the link's directory, and Windows ignores case.
 * @param a - one text, as `readlink` returned it or as it was planned.
 * @param b - the other.
 * @param linkDir - the directory holding the link.
 * @param platform - whose path rules apply.
 * @returns true when both resolve to the same path.
 */
export function sameTarget(a: string, b: string, linkDir: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform)
  const canonical = (text: string): string => {
    const resolved = api.resolve(linkDir, fromExtendedLengthPath(text))
    return platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return canonical(a) === canonical(b)
}

/** One link rewritten in place when the home moves by rename on one volume. */
export interface InPlaceRewrite {
  /** The link's path relative to the home. */
  rel: string
  /** Its text before the move. */
  from: string
  /** Its target after the move. */
  to: string
}

/**
 * The links to rewrite after a rename on one volume: every link whose plan is
 * a rewrite. The list is recorded in the journal before the rename, so an
 * interrupted rewrite can be finished, and undone on rollback.
 * @param links - the links of the old home, from its scan.
 * @param move - the old and new homes.
 * @returns one rewrite per link that changes.
 */
export function planInPlaceRewrites(links: ReadonlyArray<{ rel: string; target: string }>, move: LinkMove): InPlaceRewrite[] {
  const rewrites: InPlaceRewrite[] = []
  for (const link of links) {
    const plan = planLink(link.target, link.rel, move)
    if (plan.kind === 'rewrite') rewrites.push({ rel: link.rel, from: link.target, to: plan.target })
  }
  return rewrites
}

/** The file-system calls a rewrite makes; replaced in tests to stand in for Windows. */
export interface RewriteFs {
  isLink: (path: string) => boolean
  readlink: (path: string) => string
  symlink: (target: string, path: string, type: LinkCreation['type']) => void
  unlink: (path: string) => void
}

/** The real file system. */
export const NODE_REWRITE_FS: RewriteFs = {
  isLink: path => lstatSync(path).isSymbolicLink(),
  readlink: path => readlinkSync(path),
  symlink: (target, path, type) => { symlinkSync(target, path, type) },
  unlink: (path) => { unlinkSync(path) },
}

/** What one in-place rewrite found. */
export type RewriteOutcome = 'rewritten' | 'already' | 'changed-by-someone-else'

/**
 * Point one link at `to`, when it still reads `from`. Idempotent: a link that
 * already reads `to` is left alone, so an interrupted pass can run again, and
 * the same call with `from` and `to` swapped undoes it.
 * @param root - the home the link lies in now.
 * @param from - the text it is expected to hold.
 * @param to - the target it gets.
 * @param rel - its relative path.
 * @param platform - the platform.
 * @param fs - the file-system calls.
 * @returns what was done; a link holding neither text is left as it is.
 * @throws when the link is gone or cannot be replaced.
 */
export function rewriteInPlace(
  root: string,
  { rel, from, to }: InPlaceRewrite,
  platform: NodeJS.Platform,
  fs: RewriteFs = NODE_REWRITE_FS,
): RewriteOutcome {
  const api = pathApi(platform)
  const path = nativePathFor(api, root, rel)
  if (!fs.isLink(path)) throw new Error(`${path} is no longer a link`)
  const current = fs.readlink(path)
  const linkDir = api.dirname(path)
  if (sameTarget(current, to, linkDir, platform)) return 'already'
  if (!sameTarget(current, from, linkDir, platform)) return 'changed-by-someone-else'
  const creation = linkCreation(to, path, platform)
  // unlink removes the link itself; on Windows it removes the junction's
  // reparse point and never what it points to.
  fs.unlink(path)
  fs.symlink(creation.target, path, creation.type)
  return 'rewritten'
}
