/**
 * Which downloads the shell places itself, and where it writes them.
 *
 * The window is a browser surface without a browser's download manager, so a
 * download the served UI starts reaches Electron's default routine — a modal
 * Save As sheet carrying no explanation of what is being saved or who asked.
 * The shell takes over the downloads that come from the server it started
 * itself, and leaves every other one to that default.
 *
 * Same-origin is decided over the whole redirect chain, not the final URL:
 * every hop `DownloadItem.getURLChain()` reports must belong to the server's
 * origin. A transfer that starts elsewhere and redirects into the server is
 * not the shell's to place, and one that starts at the server and redirects
 * out of it is no longer the server's file.
 *
 * Each hop's origin comes from `new URL(url).origin`, which resolves a `blob:`
 * URL to the origin of the page that minted it: a page that fetches its own
 * bytes and hands them to an `<a download>` is downloading from itself, and is
 * taken over on the same terms as a direct `/api` URL. `data:`, `about:`,
 * `file:` and an opaque `blob:` have no origin of their own, so none of them
 * can match a server origin.
 *
 * Nothing here touches Electron, so the policy is exercised directly by
 * `tests/download-policy.spec.ts`.
 * @module @deepseek-ai/dsh-desktop/download-policy
 */

import { extname, join } from 'node:path'

/**
 * How many ` (n)` names are tried before the download is handed back to
 * Electron. The limit exists so the search terminates: a directory that
 * somehow holds every candidate must not end in a path that is already a
 * file, because the download would then overwrite it.
 */
const UNIQUE_SUFFIX_LIMIT = 1_000

/** The name a download is saved under when its own suggestion is only path syntax. */
const FALLBACK_FILENAME = 'download'

/** One download offered to the shell, and everything the decision reads. */
export interface DownloadRequest {
  /** Every hop the download went through, as `DownloadItem.getURLChain()` reports it, original first. */
  urls: readonly string[]
  /** The embedded server's origin — `ServerHandle.url`, which is already an origin and nothing else. */
  serverOrigin: string
  /** The name the download suggests, as `DownloadItem.getFilename()` reports it. */
  filename: string
  /** The directory a taken-over download is written to. */
  downloadsDir: string
  /**
   * Paths this process has already given to transfers that have not finished.
   * A download's name is derived from what it is exporting, so two gestures on
   * one session produce the same name; nothing is on disk under it until the
   * first transfer writes its first byte, and without this set the second
   * download would be handed the same path and overwrite the first.
   */
  claimed: ReadonlySet<string>
  /** Whether a candidate path is already taken on disk; `existsSync` in the shell. */
  exists: (candidate: string) => boolean
}

/** Why a download was left to Electron rather than placed by the shell. */
export type DownloadDefaultReason =
  /** Some hop of the chain does not belong to the embedded server. */
  | 'other-origin'
  /** Every candidate name in the downloads folder is taken; the alternative was overwriting a file. */
  | 'no-free-name'

/**
 * What the shell does with one download: `save` writes it to `path` without
 * asking, `default` leaves the download to Electron, sheet and all.
 */
export type DownloadDecision = { kind: 'save'; path: string } | { kind: 'default'; reason: DownloadDefaultReason }

/**
 * Decide one download.
 * @param request - the download and the state the decision reads.
 * @returns where to write it, or that it is not the shell's to place and why.
 */
export function decideDownload(request: DownloadRequest): DownloadDecision {
  if (!servedThroughout(request.urls, request.serverOrigin)) return { kind: 'default', reason: 'other-origin' }
  const taken = (candidate: string): boolean => request.claimed.has(candidate) || request.exists(candidate)
  const path = uniquePath(join(request.downloadsDir, safeFilename(request.filename)), taken)
  return path === undefined ? { kind: 'default', reason: 'no-free-name' } : { kind: 'save', path }
}

/**
 * A path in the same directory that nothing occupies yet.
 * @param path - the path the download would take.
 * @param taken - whether a candidate path is already spoken for.
 * @returns `path` when it is free, otherwise the same name with ` (2)`,
 * ` (3)` … inserted before its extension — the last dot-suffix, so
 * `session.tar.gz` becomes `session.tar (2).gz`. Undefined when
 * {@link UNIQUE_SUFFIX_LIMIT} names are all taken, which is the caller's cue
 * to hand the download back rather than overwrite a file.
 */
export function uniquePath(path: string, taken: (candidate: string) => boolean): string | undefined {
  if (!taken(path)) return path
  const extension = extname(path)
  const stem = path.slice(0, path.length - extension.length)
  for (let index = 2; index <= UNIQUE_SUFFIX_LIMIT; index += 1) {
    const candidate = `${stem} (${String(index)})${extension}`
    if (!taken(candidate)) return candidate
  }
  return undefined
}

/**
 * Whether a download never left the embedded server.
 * @param urls - the redirect chain, original first.
 * @param serverOrigin - the origin the whole chain must belong to.
 * @returns true when every hop is the server's. An empty chain is false: a
 * download the shell cannot see the provenance of is not one it places.
 */
function servedThroughout(urls: readonly string[], serverOrigin: string): boolean {
  if (urls.length === 0) return false
  return urls.every(url => originOf(url) === serverOrigin)
}

/**
 * The origin a download URL belongs to.
 * @param url - the URL to read.
 * @returns the origin, or undefined when the URL has none of its own — a
 * `data:`, `about:`, `file:` or opaque-`blob:` URL, or a string that is not a
 * URL at all. A server origin is always a real `http(s)` authority, so an
 * undefined answer can never match one.
 */
function originOf(url: string): string | undefined {
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    // `URL` throws only for a string that is not a URL. `DownloadItem` never
    // carries one; a caller that passes one gets the same answer as an
    // originless URL, which is the answer that takes nothing over.
    return undefined
  }
  return origin === 'null' ? undefined : origin
}

/**
 * The bare name a download is saved under.
 * @param filename - the name the download suggests.
 * @returns its last path segment, or {@link FALLBACK_FILENAME} when that
 * segment names a directory rather than a file. Chromium sanitizes
 * `DownloadItem.getFilename()` before the shell ever sees it; the strip is
 * repeated because this function is the only step between a suggested name and
 * a written path, and it must hold on its own.
 */
function safeFilename(filename: string): string {
  const segment = filename.split(/[/\\]/).pop() ?? ''
  return segment === '' || segment === '.' || segment === '..' ? FALLBACK_FILENAME : segment
}
