/**
 * What electron-updater's own logger is allowed to write into `dsh-server.log`
 * — the file a user is asked to send when an update goes wrong.
 *
 * electron-updater logs through four channels. The `debug` channel is dropped
 * but for the two lines in [[KEPT_DEBUG_PREFIXES]]. What it otherwise carries
 * is a differential download's entire plan as pretty-printed JSON, one
 * `{ kind, start, end }` object per block, then one `download range: bytes=…`
 * line per range issued (`DifferentialDownloader.js:41`, `:184`); one line per
 * checksum that repeats in the blockmap (`downloadPlanBuilder.js:100`); and
 * `MacUpdater`'s Squirrel proxy and architecture trace (`MacUpdater.js:44`,
 * `:47`, `:59`, `:69`, `:129`, `:131`, `:208`, `:210`). `AppUpdater.js:290`
 * writes there too, from a method this shell never calls. In one observed
 * update the plan dump alone was around 650 lines of JSON. None of them names a
 * version, a URL, a size or a failure, so they answer no support question and
 * bury the lines that do. What a differential download is worth knowing reaches
 * the `info` channel from those same two files and is kept:
 * `File has <n> changed blocks` and
 * `Full: <size>, To download: <size> (<percent>%)`.
 *
 * `info`, `warn` and `error` are otherwise passed through unchanged, with one
 * rewrite. A differential download that cannot proceed is caught upstream and
 * reported on the `error` channel as `Cannot download differentially, fallback
 * to full download: <stack>`, after which the update completes by full
 * download — so a successful update left a stack trace under the word `error`
 * in the file support reads, and was reported as a crash. It becomes one line
 * naming the reason and what the updater did instead.
 *
 * Nothing here touches electron, so `tests/updater-log.spec.ts` exercises the
 * mapping directly.
 * @module @deepseek-ai/dsh-desktop/updater-log
 */

/** The channels electron-updater's `Logger` writes through. */
export type UpdaterLogChannel = 'debug' | 'info' | 'warn' | 'error'

/**
 * The starts of the two `debug` messages that are kept; every other line on
 * that channel is dropped. Both keep the `debug:` marker that `warn` and
 * `error` lines carry, so a line in the file still says which channel wrote it.
 *
 * `nativeUpdater.update-downloaded` (`MacUpdater.js:24`) is the only record
 * that Squirrel finished staging the update, and it accompanies the
 * `squirrelDownloadedUpdate` flag that decides which branch `quitAndInstall()`
 * takes (`MacUpdater.js:241`) — whether the install proceeds at once or waits
 * for Squirrel. `updater cache dir: <path>` (`AppUpdater.js:552`) names the
 * directory whose contents decide whether the next update can be differential.
 * Its prefix keeps a trailing space because upstream's template is
 * `updater cache dir: ${cacheDir}`, so the space is part of the fixed text and
 * not of the path. Neither line has an `info` or `warn` equivalent, and both
 * answer a question support asks about an install that stalled or transferred a
 * whole artifact.
 */
const KEPT_DEBUG_PREFIXES = ['nativeUpdater.update-downloaded', 'updater cache dir: '] as const

/**
 * The message a caught differential-download failure is reported with, ahead of
 * the `stack` of what was caught or, for a thrown non-`Error`, that value.
 * `AppUpdater.differentialDownloadInstaller` logs it for Windows and macOS
 * alike (`AppUpdater.js:705`, which macOS reaches through `MacUpdater.js:102`);
 * `NsisUpdater.js:170` and `AppImageUpdater.js:67` log the same text for the
 * web-installer and AppImage paths.
 */
const DIFFERENTIAL_FALLBACK_PREFIX = 'Cannot download differentially, fallback to full download: '

/**
 * A leading `Error: ` or `HttpError: ` on the first line of a rendered stack,
 * which names the class rather than what went wrong.
 */
const ERROR_NAME_PREFIX = /^[A-Za-z_$][A-Za-z0-9_$]*: /

/**
 * How much of the reason a dropped differential download puts in its line. The
 * cap bounds a single long first line, and has to clear the longest one that
 * can reach this line: the 217-character `sha512 checksum mismatch, expected …,
 * got …` that `DigestTransform.validate` throws
 * (`builder-util-runtime/out/httpExecutor.js:431`), which is worth nothing
 * truncated because both 88-character digests are the content. The longer
 * 238-character mismatch beside it (`checkSha2`, `:439`) reaches only the full
 * download, through `configurePipes` (`:457`). An `HttpError` needs no room at
 * all — its header dump is on later lines, which the first-line split has
 * already removed.
 */
const REASON_LIMIT = 320

/**
 * Name what stopped a differential download, from the text that follows
 * [[DIFFERENTIAL_FALLBACK_PREFIX]]: the first line of the rendered stack,
 * without its class name and capped at [[REASON_LIMIT]].
 * @param rendered - everything after the prefix, which is a stack or a value.
 * @returns a single-line identification.
 */
function fallbackReason(rendered: string): string {
  const [first = ''] = rendered.split('\n')
  const reason = first.replace(ERROR_NAME_PREFIX, '')
  return reason.length > REASON_LIMIT ? `${reason.slice(0, REASON_LIMIT)}…` : reason
}

/**
 * Render one message electron-updater logged as the entry to append, or `null`
 * when this shell keeps nothing of it.
 * @param channel - the channel the library wrote through.
 * @param message - whatever it wrote, of any shape: the library types these
 * arguments as `any` and passes strings, errors and plain values alike.
 * @returns the complete entry, newline included, or `null` to write nothing.
 */
export function updaterLogLine(channel: UpdaterLogChannel, message: unknown): string | null {
  switch (channel) {
    case 'debug': {
      const text = String(message)
      if (!KEPT_DEBUG_PREFIXES.some(prefix => text.startsWith(prefix))) return null
      return `[updater] debug: ${text}\n`
    }
    case 'info':
      return `[updater] ${String(message)}\n`
    case 'warn':
      return `[updater] warn: ${String(message)}\n`
    case 'error': {
      const text = String(message)
      if (!text.startsWith(DIFFERENTIAL_FALLBACK_PREFIX)) return `[updater] error: ${text}\n`
      const reason = fallbackReason(text.slice(DIFFERENTIAL_FALLBACK_PREFIX.length))
      return `[updater] differential download unavailable (${reason}); this update transfers the whole artifact\n`
    }
  }
}
