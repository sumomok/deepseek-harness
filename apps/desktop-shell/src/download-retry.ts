/**
 * The retry policy for an interrupted update transfer — a download or a check
 * — and the classification that decides which failures it applies to.
 *
 * electron-updater retries nothing and keeps nothing of a failed transfer: any
 * error out of `executeDownload` unlinks the partial file and empties the
 * pending directory, and the full download sends no `Range` header, so an
 * attempt after a failure re-transfers the whole artifact. The plan for that
 * path is therefore bounded — a handful of attempts over half a minute —
 * because each attempt costs the artifact again. What an exhausted plan leads
 * to is [[transferWithFallback]]: the same artifact transferred by the shell's own
 * resumable downloader, which keeps what already arrived and can afford a slower,
 * longer plan of its own.
 *
 * Nothing here touches electron, so the policy is exercised directly by
 * `tests/download-retry.spec.ts` with an injected clock.
 * @module @deepseek-ai/dsh-desktop-shell/download-retry
 */

/** Whether a download failure is worth another attempt. */
export type DownloadFailure = 'transient' | 'fatal'

/**
 * Delay before each retry; the length of the list is the number of retries.
 * Three attempts spread over 26 seconds cover the interruptions a multi-hundred
 * megabyte transfer actually meets — a Wi-Fi handover, a route change, a reload
 * of the feed's nginx — while staying short enough that the mandatory launch
 * block, which downloads before the app opens, does not read as a hang. A
 * failure that outlives the plan is reported instead of retried further,
 * because each further attempt costs the whole artifact again.
 *
 * The delays carry no jitter. The feed is a static directory whose clients
 * check on their own launch times and four-hour timers, so retries are already
 * spread and synchronized ones are not a load it can meet badly.
 */
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 6_000, 18_000]

/**
 * Delay before each retry of the shell's own resumable transfer; the length of
 * the list is the number of retries.
 *
 * This plan is longer and slower than [[RETRY_DELAYS_MS]] because an attempt
 * costs a request rather than the artifact: the bytes already on disk are kept
 * and the next attempt asks for the rest. Nothing is on screen while it runs
 * and nothing waits for it, so the ten minutes it spans are spent covering an
 * outage that outlasts a route change rather than holding anything up.
 */
export const RESUME_RETRY_DELAYS_MS: readonly number[] = [2_000, 10_000, 30_000, 120_000, 300_000]

/**
 * Delay before each retry of an update check; the length of the list is the
 * number of retries.
 *
 * A check transfers one small manifest, so an interruption costs a request
 * rather than the whole artifact and the plan is tighter than
 * [[RETRY_DELAYS_MS]]. Four seconds of waiting keeps the plan inside the
 * fifteen the mandatory launch gate allows, so a gate that meets a dropped
 * connection reaches its verdict from a retry rather than from its own timeout.
 */
export const CHECK_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000]

/**
 * The code the shell's own resumable transfer attaches to a body that ended
 * before the artifact did — a peer that reset or closed the connection
 * mid-transfer, a connection that went silent past its idle bound, an answer
 * shorter than the length it promised. `resumable-download.ts` raises it so the
 * classification below reads a code this repository owns rather than the
 * message Node's `fetch` happens to carry, and so the bytes already on disk are
 * resumed rather than given up on.
 */
export const TRANSFER_CUT_CODE = 'DSH_TRANSFER_CUT'

/**
 * Codes for a connection that failed to open, was cut, or timed out.
 *
 * The `E…` names are Node's and libuv's, reaching a download from Node's own
 * sockets and from the file stream the artifact is written through. The
 * `UND_ERR_…` names are undici's, which is the HTTP client behind Node's
 * `fetch` and therefore behind the resumable transfer: it reports a socket that
 * was cut, a connect or header or body read that timed out, and a request that
 * was aborted, under codes of its own. Electron's `net`, which is the executor
 * electron-updater's own download runs on, reports the same conditions through
 * [[TRANSIENT_MESSAGES]] instead.
 *
 * `UND_ERR_ABORTED` is transient because every abort this repository issues is
 * the resumable transfer's own idle bound giving up on a silent connection;
 * nothing here cancels a transfer a user asked for.
 */
const TRANSIENT_SYSCALL_CODES: ReadonlySet<string> = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ESOCKETTIMEDOUT',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_ABORTED',
  TRANSFER_CUT_CODE,
])

/**
 * `name` of the failures a request that was given up on raises, which is the
 * only thing identifying them.
 *
 * `AbortSignal.timeout()` rejects a `fetch` with a `DOMException` named
 * `TimeoutError` and `AbortController.abort()` with one named `AbortError`.
 * Neither carries a string `code` — `DOMException.code` is the numeric legacy
 * value, 23 and 20 — and neither message names a network condition, so
 * [[errorCodes]] finds nothing and the fail-closed default would call a feed
 * that answered slowly fatal.
 *
 * Both are transient because every bound this repository sets is a wait it gave
 * up on rather than a verdict about what it was waiting for: `fetchFeed`'s 20 s
 * on one manifest, and the resumable transfer's idle bound on a silent
 * connection. Nothing here cancels a transfer a user asked for.
 */
const ABANDONED_REQUEST_NAMES: ReadonlySet<string> = new Set(['TimeoutError', 'AbortError'])

/**
 * Message fragments that identify a transient failure carrying no `code`.
 * `Request timed out` and `Request has been aborted by the server` are
 * builder-util-runtime's own texts (`HttpExecutor.addTimeOutHandler` and
 * `addErrorAndTimeoutHandlers`); `socket hang up` is Node's text for a server
 * that closed the connection before answering; every failure Electron's `net`
 * module reports names a `net::ERR_…` reason, and the download path on both
 * platforms runs on that module through `ElectronHttpExecutor`.
 *
 * The last three are Node's `fetch`: `terminated` is the whole message of the
 * `TypeError` it raises for a response body the peer cut, `fetch failed` the
 * one it raises for a request that never got a response at all, and `other side
 * closed` undici's own text underneath the first. Each normally arrives over a
 * `cause` carrying a code, which [[errorCodes]] reads; they are listed here
 * because a `fetch` polyfill, a transform, or a future undici may pass the
 * message on without one, and a cut transfer is worth resuming either way.
 */
const TRANSIENT_MESSAGES: readonly string[] = [
  'Request timed out',
  'Request has been aborted by the server',
  'socket hang up',
  'net::ERR_',
  'terminated',
  'fetch failed',
  'other side closed',
]

/**
 * Prefix of every refusal electron-updater raises through `newError` — an
 * installer signed by someone else (`ERR_UPDATER_INVALID_SIGNATURE`), a
 * manifest naming no zip (`ERR_UPDATER_ZIP_FILE_NOT_FOUND`), an unparsable
 * version. Repeating the transfer reaches the same verdict.
 */
const FATAL_CODE_PREFIX = 'ERR_UPDATER_'

/**
 * `DigestTransform` rejecting the bytes that arrived, which carries a code of
 * its own rather than the `ERR_UPDATER_` prefix. The artifact the feed serves
 * does not match the checksum the manifest publishes for it, and no attempt
 * changes that.
 */
const CHECKSUM_MISMATCH_CODE = 'ERR_CHECKSUM_MISMATCH'

/**
 * How much of a message [[describeDownloadError]] puts in a log line. An
 * `HttpError` message carries the response's whole header dump.
 */
const MESSAGE_LOG_LIMIT = 160

/**
 * Statuses reported as `Cannot download "<url>", status <n>: <text>` by
 * `HttpExecutor.doDownload`, which is the one download failure that names an
 * HTTP status in prose rather than in a code.
 */
const DOWNLOAD_STATUS_PATTERN = /^Cannot download "[^"]*", status (\d{3}):/

/** `HttpError.code`, which is the status the response carried, or -1 when it carried none. */
const HTTP_ERROR_CODE_PATTERN = /^HTTP_ERROR_(-?\d+)$/

/**
 * The code naming one HTTP status a transfer was refused with, spelled the way
 * `HttpError.code` spells it so [[classifyDownloadError]] reads a status the
 * same way whichever half of the transfer met it.
 *
 * `resumable-download.ts` attaches it to an answer it will not transfer from.
 * That failure otherwise carries no code at all and its message is this
 * repository's own Chinese prose, which [[DOWNLOAD_STATUS_PATTERN]] does not
 * match — so a 503 from the feed was fatal and the bytes already on disk were
 * given up on.
 * @param status - the status the response carried.
 * @returns the code to attach to the failure.
 */
export function httpErrorCode(status: number): string {
  return `HTTP_ERROR_${String(status)}`
}

/**
 * How many `cause` links [[errorCodes]] follows. The chains this meets are two
 * or three long; the bound is what keeps a malformed one from being walked
 * forever alongside the cycle check, and no failure here is worth more links
 * than this.
 */
const MAX_CAUSE_DEPTH = 8

/** Separator between the codes [[describeDownloadError]] found down one chain, outermost first. */
const CODE_CHAIN_SEPARATOR = ' ← '

/**
 * Every `code` an error carries down its `cause` chain, outermost first and
 * without repeats.
 *
 * `code` is where Node's syscall failures, builder-util-runtime's `newError`,
 * and its `HttpError` all put their identification — but Node's `fetch` puts
 * none on the error it raises. A response body the peer cut arrives as a bare
 * `TypeError: terminated` whose `cause` is undici's `SocketError`, and that
 * cause is the only thing naming the condition, so a reader of the top level
 * alone sees a failure it cannot classify. Walking the chain is what finds it.
 *
 * Only string codes count: a `DOMException` carries a numeric `code`, which
 * names nothing this classifies by.
 * @param error - the value a download attempt failed with.
 * @returns the codes found, outermost first; empty when the chain carries none.
 */
function errorCodes(error: unknown): string[] {
  const found: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== 'object' || current === null || seen.has(current)) break
    seen.add(current)
    const value = (current as { code?: unknown }).code
    if (typeof value === 'string' && !found.includes(value)) found.push(value)
    current = (current as { cause?: unknown }).cause
  }
  return found
}

/**
 * The code that names what a download attempt failed with: the outermost one on
 * its `cause` chain, which is the most specific identification its raiser gave.
 * @param error - the value a download attempt failed with.
 * @returns the code, or undefined when the whole chain carries none.
 */
function errorCode(error: unknown): string | undefined {
  return errorCodes(error)[0]
}

/**
 * Whether one HTTP status names a condition the next attempt may not meet. 5xx
 * is the server failing rather than refusing, 408 and 425 ask for the request
 * again, and 429 asks for it later. Every other status is a decision about this
 * request that repeating cannot change.
 * @param status - the status the response carried.
 * @returns true when the same request is worth sending again.
 */
function statusIsTransient(status: number): boolean {
  return (status >= 500 && status <= 599) || status === 408 || status === 425 || status === 429
}

/**
 * Decide whether one download failure is worth another attempt.
 *
 * The rule is fail-closed: a failure is transient only when it matches a known
 * network condition, and everything else — including anything that is not an
 * `Error` — is fatal, so an unrecognized failure ends the download instead of
 * re-transferring the artifact three more times on a guess.
 *
 * The code is read off the whole `cause` chain, because Node's `fetch` names
 * the condition nowhere else: the outermost code decides, so a refusal that
 * wraps a network failure stays a refusal. A request given up on is read off
 * `name` before that, because it is the one failure here that carries no string
 * code at all.
 *
 * Both a download and a check are classified here. A check carries one edge of
 * its own: electron-updater wraps a 404 on the channel file as
 * `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`, which stays fatal, so a feed that has
 * no manifest for this channel is neither retried nor survived by the macOS
 * in-place tier. Every other check failure arrives as the error the request
 * itself failed with.
 * @param error - the value a download attempt failed with.
 * @returns whether the failure is transient or fatal.
 */
export function classifyDownloadError(error: unknown): DownloadFailure {
  if (!(error instanceof Error)) return 'fatal'
  if (ABANDONED_REQUEST_NAMES.has(error.name)) return 'transient'
  const code = errorCode(error)
  if (code !== undefined) {
    if (code.startsWith(FATAL_CODE_PREFIX) || code === CHECKSUM_MISMATCH_CODE) return 'fatal'
    if (TRANSIENT_SYSCALL_CODES.has(code)) return 'transient'
    const httpStatus = HTTP_ERROR_CODE_PATTERN.exec(code)
    if (httpStatus !== null) return statusIsTransient(Number(httpStatus[1])) ? 'transient' : 'fatal'
  }
  const message = error.message
  if (TRANSIENT_MESSAGES.some(fragment => message.includes(fragment))) return 'transient'
  const downloadStatus = DOWNLOAD_STATUS_PATTERN.exec(message)
  if (downloadStatus !== null) return statusIsTransient(Number(downloadStatus[1])) ? 'transient' : 'fatal'
  return 'fatal'
}

/**
 * Name one download failure in a log line: the codes down its `cause` chain
 * where it carries any — `ECONNRESET`, `HTTP_ERROR_503`,
 * `ERR_UPDATER_INVALID_SIGNATURE`, or `DSH_TRANSFER_CUT ← UND_ERR_SOCKET` —
 * and otherwise the first line of its message, capped at
 * [[MESSAGE_LOG_LIMIT]].
 *
 * The whole chain is named, not only its outermost code, because that is where
 * the condition is: a cut transfer's outer code says a transfer was cut and its
 * inner one says what cut it, and a log that carried only the first would
 * report every interruption identically.
 *
 * A request given up on is named `TimeoutError` or `AbortError`, which is where
 * its condition is; its message is prose about an operation being aborted and
 * names neither the bound that ended it nor what was being waited for.
 * @param error - the value a download attempt failed with.
 * @returns a single-line identification.
 */
export function describeDownloadError(error: unknown): string {
  const codes = errorCodes(error)
  if (codes.length > 0) return codes.join(CODE_CHAIN_SEPARATOR)
  if (error instanceof Error && ABANDONED_REQUEST_NAMES.has(error.name)) return error.name
  const [line = ''] = (error instanceof Error ? error.message : String(error)).split('\n')
  return line.length > MESSAGE_LOG_LIMIT ? `${line.slice(0, MESSAGE_LOG_LIMIT)}…` : line
}

/** What [[withRetry]] needs from its caller besides the attempt itself. */
export interface RetryHooks {
  /**
   * Report one interruption that is about to be retried. Called once per
   * retry, before the wait.
   * @param attempt - which retry this is, counting from 1.
   * @param total - how many retries the plan allows.
   * @param delayMs - the wait before this retry.
   * @param error - what interrupted the attempt.
   */
  onRetry: (attempt: number, total: number, delayMs: number, error: unknown) => void
  /**
   * Wait before the next attempt.
   * @param ms - how long to wait.
   * @returns a promise that settles when the wait is over.
   */
  sleep: (ms: number) => Promise<void>
}

/**
 * Run one transfer, repeating it on transient failures along `delays`.
 *
 * A fatal failure is not retried, and an exhausted plan stops retrying; both
 * reject with the error the last attempt failed with, so the caller sees the
 * failure itself and can classify it again with [[classifyDownloadError]] to
 * decide what its own surface does about it.
 * @param run - performs one whole attempt; called once per attempt.
 * @param delays - the wait before each retry; its length is the retry count.
 * @param hooks - reporting and the clock.
 * @returns a promise that resolves with what the completed attempt returned.
 */
export async function withRetry<T>(run: () => Promise<T>, delays: readonly number[], hooks: RetryHooks): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      const delayMs = delays[attempt - 1]
      if (delayMs === undefined || classifyDownloadError(error) === 'fatal') throw error
      hooks.onRetry(attempt, delays.length, delayMs, error)
      await hooks.sleep(delayMs)
    }
  }
}

/** How one transfer ended, once both halves of the plan have had their turn. */
export type TransferOutcome = 'completed' | 'resumed' | 'exhausted'

/** What [[transferWithFallback]] needs beyond [[RetryHooks]]. */
export interface FallbackHooks extends RetryHooks {
  /**
   * Report that the library's own transfer is being given up on and the
   * resumable one takes over. Called at most once per transfer.
   * @param error - the failure the retry plan ended on.
   */
  onFallback: (error: unknown) => void
}

/** The two halves of one transfer and the plan the first of them runs under. */
export interface FallbackPlan {
  /**
   * Perform one whole transfer through electron-updater, which is also what
   * takes a staged artifact out of the cache and raises `update-downloaded`.
   * @returns a promise that settles when that attempt is over.
   */
  run: () => Promise<void>
  /**
   * Transfer the artifact with the shell's own resumable downloader and stage
   * it where electron-updater reads a cached update from. Undefined where the
   * fallback must not be taken.
   * @returns true when the artifact is staged and [[run]] is worth calling again.
   */
  resume: (() => Promise<boolean>) | undefined
  /** The wait before each retry of [[run]]; its length is the retry count. */
  delays: readonly number[]
  /** Reporting and the clock. */
  hooks: FallbackHooks
}

/**
 * Run one transfer, and when the network alone defeats it, transfer the same
 * artifact again from where it stopped.
 *
 * The library's own path runs first and unchanged, because it is the one that
 * downloads a differential update: on a machine with the previous artifact
 * cached that transfers a fraction of the bytes, which no resumable full
 * download can beat. The fallback is therefore what an exhausted retry plan
 * leads to, never what replaces it. Once the artifact is staged, [[run]] is
 * called once more so the library validates the cache, takes the file from
 * there, and emits the event the rest of the channel listens for.
 *
 * A fatal failure is rethrown untouched: nothing about a refused signature or a
 * mismatched checksum is improved by transferring the same artifact again.
 * @param plan - the two halves, the retry plan, and the hooks.
 * @returns which half finished the transfer, or `exhausted` when neither did.
 * @throws the failure the library's transfer ended on when it is fatal or when
 * there is no fallback, and whatever the second [[run]] fails with.
 */
export async function transferWithFallback(plan: FallbackPlan): Promise<TransferOutcome> {
  try {
    await withRetry(plan.run, plan.delays, plan.hooks)
    return 'completed'
  } catch (error) {
    if (plan.resume === undefined || classifyDownloadError(error) === 'fatal') throw error
    plan.hooks.onFallback(error)
    if (!await plan.resume()) return 'exhausted'
    await plan.run()
    return 'resumed'
  }
}
