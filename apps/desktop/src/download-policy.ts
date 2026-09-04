/**
 * Which downloads the shell takes over, what the save dialog offers, and what
 * the user is shown when the transfer ends.
 *
 * The window is a browser surface without a browser's download manager, so a
 * download the served UI starts reaches Electron's default routine — a Save As
 * sheet carrying no explanation of what is being saved or who asked. The shell
 * takes over the downloads that come from the server it started itself, and
 * leaves every other one to that default.
 *
 * A taken-over download still asks. What the shell replaces is the unexplained
 * sheet, not the choice: the dialog it puts up names the file being saved,
 * offers the system downloads folder under a name nothing there occupies yet,
 * and lets the user put it anywhere. Where the file went is then shown by
 * selecting it in the system file manager, because the page that started the
 * download says only that it started.
 *
 * Everything the embedded server serves as an attachment arrives here — the
 * session-log export, the sidebar's file downloads, whatever a later plugin
 * adds — so the dialog names the file it was handed and constrains nothing
 * about it. A dialog that assumed one kind of file would rename the others:
 * a `zip` filter turns `report.pdf` into `report.zip` on macOS, where Electron
 * maps `filters` onto `setAllowedFileTypes:` without `allowsOtherFileTypes`.
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
 * Nothing here calls into Electron — the `SaveDialogOptions` import is a type
 * and is erased — so the policy is exercised directly by
 * `tests/download-policy.spec.ts`.
 * @module @deepseek-ai/dsh-desktop/download-policy
 */

import { basename, extname, join } from 'node:path'
import type { SaveDialogOptions } from 'electron'

/**
 * How many ` (n)` names are tried before the plain name is offered anyway. The
 * limit exists so the search terminates; the name it gives up on is a
 * suggestion in a dialog, which the system guards with its own replace prompt.
 */
const UNIQUE_SUFFIX_LIMIT = 1_000

/** The name a download is offered under when its own suggestion is only path syntax. */
const FALLBACK_FILENAME = 'download'

/** One download offered to the shell, and everything the decision reads. */
export interface DownloadRequest {
  /** Every hop the download went through, as `DownloadItem.getURLChain()` reports it, original first. */
  urls: readonly string[]
  /** The embedded server's origin — `ServerHandle.url`, which is already an origin and nothing else. */
  serverOrigin: string
  /** The name the download suggests, as `DownloadItem.getFilename()` reports it. */
  filename: string
  /** The directory the dialog opens in. */
  downloadsDir: string
  /** Whether a candidate path is already taken on disk; `existsSync` in the shell. */
  exists: (candidate: string) => boolean
}

/**
 * What the shell does with one download: `ask` puts `dialog` up and writes
 * wherever the user says, `default` leaves the download to Electron.
 */
export type DownloadDecision = { kind: 'ask'; dialog: SaveDialogOptions } | { kind: 'default' }

/** The terminal state Electron reports on `DownloadItem`'s `done` event. */
export type DownloadState = 'completed' | 'cancelled' | 'interrupted'

/** The error box shown when a transfer the user agreed to did not produce a file. */
export interface DownloadAlert {
  /** The headline: the file the user asked for is not there. */
  message: string
  /** One line naming the file and what to do about it. */
  detail: string
}

/**
 * What the shell does once a transfer it offered reaches a terminal state.
 * `reveal` and `alert` are never both present: a transfer either produced a
 * file to show or a failure to report.
 */
export interface DownloadOutcome {
  /** The `dsh-server.log` line, newline included. */
  line: string
  /** The saved file to select in the system file manager; absent unless the transfer completed. */
  reveal?: string
  /** The error box to put on screen; absent unless the transfer failed. */
  alert?: DownloadAlert
}

/**
 * Decide one download.
 * @param request - the download and the state the decision reads.
 * @returns the save dialog to put up, or that the download is not the shell's
 * to take over.
 */
export function decideDownload(request: DownloadRequest): DownloadDecision {
  if (!servedThroughout(request.urls, request.serverOrigin)) return { kind: 'default' }
  const name = safeFilename(request.filename)
  const suggested = join(request.downloadsDir, name)
  return {
    kind: 'ask',
    dialog: {
      title: '保存文件',
      // Both are set because each reaches one set of platforms: `message` is
      // macOS-only (`@platform darwin` in `electron.d.ts`), and `title` is
      // what the others show.
      message: `保存 ${name}`,
      defaultPath: uniquePath(suggested, request.exists) ?? suggested,
      buttonLabel: '保存',
    },
  }
}

/**
 * Say what happened to a transfer the shell offered a dialog for.
 *
 * `interrupted` reaches the user as a write failure rather than a network
 * one. The transfers the shell takes over come off loopback, and the
 * session-log export's bytes are already in the page's memory when the
 * `blob:` download starts, so what fails at this point is putting them on
 * disk: a full volume, a location that is not writable, one that went away.
 * @param state - the terminal state Electron reported.
 * @param savePath - the path the user chose, as `DownloadItem.getSavePath()`
 * reports it; empty when the dialog was dismissed before a path existed.
 * @param filename - the name the download suggested, which is all there is to
 * name the file by when no path was ever chosen.
 * @returns the log line, and what to put on screen with it.
 */
export function downloadOutcome(state: DownloadState, savePath: string, filename: string): DownloadOutcome {
  const named = savePath === '' ? filename : savePath
  switch (state) {
    case 'completed':
      return { line: `[desktop] download saved: ${savePath}\n`, reveal: savePath }
    // Dismissing the dialog is the user declining the download, and needs no
    // answer beyond the line that records it.
    case 'cancelled':
      return { line: `[desktop] download cancelled: ${named}\n` }
    case 'interrupted':
      return {
        line: `[desktop] download interrupted: ${named}\n`,
        alert: { message: '文件没有保存成功', detail: `${basename(named)}:写入失败,请检查保存位置后重试。` },
      }
  }
}

/**
 * A path in the same directory that nothing occupies yet.
 * @param path - the path the download would be offered under.
 * @param taken - whether a candidate path is already spoken for.
 * @returns `path` when it is free, otherwise the same name with ` (2)`,
 * ` (3)` … inserted before its extension — the last dot-suffix, so
 * `session.tar.gz` becomes `session.tar (2).gz`. Undefined when
 * {@link UNIQUE_SUFFIX_LIMIT} names are all taken, which is the caller's cue
 * to offer the plain name and let the dialog handle the collision.
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
 * download the shell cannot see the provenance of is not one it takes over.
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
 * The bare name a download is offered under.
 * @param filename - the name the download suggests.
 * @returns its last path segment, or {@link FALLBACK_FILENAME} when that
 * segment names a directory rather than a file. Chromium sanitizes
 * `DownloadItem.getFilename()` before the shell ever sees it; the strip is
 * repeated because this function is the only step between a suggested name and
 * the path the dialog opens on, and it must hold on its own.
 */
function safeFilename(filename: string): string {
  const segment = filename.split(/[/\\]/).pop() ?? ''
  return segment === '' || segment === '.' || segment === '..' ? FALLBACK_FILENAME : segment
}
