/**
 * The retry policy for an interrupted update transfer — a download or a check
 * — and the classification that decides which failures it applies to.
 *
 * electron-updater retries nothing and keeps nothing of a failed transfer: any
 * error out of `executeDownload` unlinks the partial file and empties the
 * pending directory, and the full download sends no `Range` header, so an
 * attempt after a failure re-transfers the whole artifact. The policy here is
 * therefore bounded — a handful of attempts over half a minute — and its whole
 * effect is that a connection dropped mid-transfer costs those seconds instead
 * of the rest of the session's update channel.
 *
 * Nothing here touches electron, so the policy is exercised directly by
 * `tests/download-retry.spec.ts` with an injected clock.
 * @module @deepseek-ai/dsh-desktop/download-retry
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
 * Node and libuv codes for a connection that failed to open, was cut, or timed
 * out. These reach a download from Node's own sockets and from the file stream
 * the artifact is written through; Electron's `net`, which is the executor the
 * download itself runs on, reports the same conditions through
 * [[TRANSIENT_MESSAGES]] instead.
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
])

/**
 * Message fragments that identify a transient failure carrying no `code`.
 * `Request timed out` and `Request has been aborted by the server` are
 * builder-util-runtime's own texts (`HttpExecutor.addTimeOutHandler` and
 * `addErrorAndTimeoutHandlers`); `socket hang up` is Node's text for a server
 * that closed the connection before answering; every failure Electron's `net`
 * module reports names a `net::ERR_…` reason, and the download path on both
 * platforms runs on that module through `ElectronHttpExecutor`.
 */
const TRANSIENT_MESSAGES: readonly string[] = [
  'Request timed out',
  'Request has been aborted by the server',
  'socket hang up',
  'net::ERR_',
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
 * The `code` an error carries, which is where Node's syscall failures,
 * builder-util-runtime's `newError`, and its `HttpError` all put their
 * identification.
 * @param error - the value a download attempt failed with.
 * @returns the code, or undefined when the error carries none.
 */
function errorCode(error: unknown): string | undefined {
  const value = (error as { code?: unknown } | null | undefined)?.code
  return typeof value === 'string' ? value : undefined
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
 * Name one download failure in a log line: the code the error carries where
 * there is one — `ECONNRESET`, `HTTP_ERROR_503`,
 * `ERR_UPDATER_INVALID_SIGNATURE` — and otherwise the first line of its
 * message, capped at [[MESSAGE_LOG_LIMIT]].
 * @param error - the value a download attempt failed with.
 * @returns a single-line identification.
 */
export function describeDownloadError(error: unknown): string {
  const code = errorCode(error)
  if (code !== undefined) return code
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
