/**
 * The order of the steps around the embedded server's end: an unexpected
 * exit, a crash rebind, a quit, and a window reopened while quitting. Each
 * function takes its effects as hooks, so the sequencing is testable without
 * Electron; `main.ts` supplies the real ones.
 *
 * The steps exist because the served UI's sign-in cookie is not bound to the
 * process that issued it: it is signed with a secret the Harness home keeps
 * and names its host and port, so it stays valid, until it expires, for any
 * later server on the same port ([[@deepseek-ai/dsh-desktop-shell/server-port]]
 * remembers that port for the next launch). While the server is gone and the
 * window still open, the web client keeps reconnecting to that port with the
 * cookie, and any local process listening there could take a copy. So:
 *
 * - An unexpected exit first forgets the remembered port and removes the
 *   cookies, before the recovery ladder runs. Every ladder outcome —
 *   rebind, whole-app relaunch, or the stop dialog — then starts from a state
 *   where no launch asks for the dead port and no request carries a cookie.
 * - A crash rebind starts on a port the system picks.
 * - A quit first records that the stop is intentional, for the crash-resume
 *   plugin ([[@deepseek-ai/dsh-desktop-shell/crash-resume-sentinel]]), then
 *   removes the cookies with a short bound, then stops the server; the stop is
 *   sent whether or not the removal finished. The stop a mandatory update
 *   forces at launch records the same first. An unexpected exit records
 *   nothing.
 * - Reopening the window while quitting does nothing, so no new token
 *   exchange issues a cookie for a server about to be gone.
 * - An install that failed after the quit began undoes the quit: it clears
 *   the quitting state first, so the window can be shown again, restarts the
 *   server through the ordinary start unless the mandatory-update block holds
 *   the app, and then shows the window.
 * @module @deepseek-ai/dsh-desktop-shell/server-lifecycle
 */

import type { ServerHandle, ServerSpec } from './server.ts'
import { startOnPort } from './server-port.ts'

/**
 * How long a cookie removal may hold up the step after it. The removal is a
 * local cookie-store operation that normally finishes in milliseconds; the
 * bound only keeps a store that never answers from delaying a stop or the
 * recovery ladder.
 */
export const COOKIE_CLEAR_BOUND_MS = 500

/**
 * Wait for `work` or `ms`, whichever comes first.
 * @param work - the operation to wait for; its failure counts as finished.
 * @param ms - the bound.
 * @returns `done` when `work` settled first, `timeout` otherwise.
 */
async function bounded(work: Promise<unknown>, ms: number): Promise<'done' | 'timeout'> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => { resolve('timeout') }, ms) })
  const settled = work.then(() => 'done' as const, () => 'done' as const)
  const outcome = await Promise.race([settled, deadline])
  clearTimeout(timer)
  return outcome
}

/** What an unexpected server exit needs before the recovery ladder. */
export interface CrashHooks<T> {
  /** Drop the remembered server port, so no later launch asks for the dead server's port. */
  forgetPort: () => void
  /** Remove the served UI's sign-in cookies. */
  clearCookies: () => Promise<unknown>
  /** Run the recovery ladder. */
  ladder: () => Promise<T>
  /** One log line, ending in a newline. */
  log: (line: string) => void
}

/**
 * Respond to an unexpected server exit: forget the port and remove the
 * cookies, the removal bounded by [[COOKIE_CLEAR_BOUND_MS]], then run the
 * ladder.
 * @param hooks - the effects.
 * @returns what the ladder returned.
 */
export async function respondToCrash<T>(hooks: CrashHooks<T>): Promise<T> {
  hooks.forgetPort()
  if (await bounded(hooks.clearCookies(), COOKIE_CLEAR_BOUND_MS) === 'timeout') {
    hooks.log(`[desktop] cookie removal after the server exit did not finish within ${String(COOKIE_CLEAR_BOUND_MS)}ms; recovering anyway\n`)
  }
  return hooks.ladder()
}

/**
 * Start a crash rebind on a port the system picks, never the crashed server's.
 * @param spec - the recorded launch spec.
 * @param start - starts one server.
 * @param log - receives [[startOnPort]]'s lines.
 * @returns the running server and the spec with its new port.
 */
export async function rebindOnNewPort(
  spec: ServerSpec, start: (spec: ServerSpec) => Promise<ServerHandle>, log: (line: string) => void,
): Promise<{ server: ServerHandle; spec: ServerSpec }> {
  return startOnPort({ ...spec, port: 0 }, start, log)
}

/** What a quit's server stop needs. */
export interface StopHooks {
  /** Record, synchronously, that the coming stop is intentional; never throws. */
  markIntentional: () => void
  /** Terminate the server; resolves once it exited. */
  stop: () => Promise<void>
  /** Remove the served UI's sign-in cookies. */
  clearCookies: () => Promise<unknown>
  /** One log line, ending in a newline. */
  log: (line: string) => void
  /** How long the stop may take before the quit goes ahead without it. */
  timeoutMs: number
}

/**
 * Stop the server for a quit: record that the stop is intentional, remove the
 * cookies, waiting at most [[COOKIE_CLEAR_BOUND_MS]] for that, then send the
 * stop and wait at most `timeoutMs` for it. A removal that fails or never
 * answers delays the stop by the bound and does not prevent it.
 * @param hooks - the effects and the stop deadline.
 * @returns `stopped`, or `timeout` when the stop did not finish in time.
 */
export async function stopForQuit(hooks: StopHooks): Promise<'stopped' | 'timeout'> {
  hooks.markIntentional()
  if (await bounded(hooks.clearCookies(), COOKIE_CLEAR_BOUND_MS) === 'timeout') {
    hooks.log(`[desktop] cookie removal did not finish within ${String(COOKIE_CLEAR_BOUND_MS)}ms; stopping the server anyway\n`)
  }
  const outcome = await bounded(hooks.stop(), hooks.timeoutMs)
  if (outcome === 'timeout') {
    hooks.log(`[desktop] server did not stop within ${String(hooks.timeoutMs)}ms; exiting anyway\n`)
    return 'timeout'
  }
  return 'stopped'
}

/** What the stop a mandatory update forces at launch needs. */
export interface UpdateStopHooks {
  /** Record, synchronously, that the coming stop is intentional; never throws. */
  markIntentional: () => void
  /** Terminate the server; resolves once it exited. */
  stop: () => Promise<void>
}

/**
 * Stop the server a launch started because a mandatory update blocks the app:
 * record that the stop is intentional, then stop it.
 * @param hooks - the effects.
 * @returns once the server exited.
 */
export async function stopForMandatoryUpdate(hooks: UpdateStopHooks): Promise<void> {
  hooks.markIntentional()
  await hooks.stop()
}

/** What bringing the app to the front needs. */
export interface RevealHooks {
  /** Whether a quit has begun. */
  quitting: () => boolean
  /** Uncover the existing window; false when there is none. */
  revealExisting: () => boolean
  /** Open a window on the served UI, when a server is running. */
  openWindow: () => void
}

/**
 * Bring the app to the front, unless it is quitting: a window opened then
 * would exchange a launch token for a fresh cookie that outlives the server.
 * @param hooks - the effects.
 */
export function revealApp(hooks: RevealHooks): void {
  if (hooks.quitting()) return
  if (hooks.revealExisting()) return
  hooks.openWindow()
}

/** What bringing the app back after a failed install needs. */
export interface ResumeHooks {
  /** Whether the mandatory-update block holds the app, which keeps the served UI closed. */
  blocking: boolean
  /** Clear the quitting state the install's teardown set. */
  clearQuitting: () => void
  /** Start the server again through the ordinary start; handles its own failure. */
  restartServer: () => Promise<void>
  /** Bring the app window to the front. */
  reveal: () => void
}

/**
 * Bring the app back after the installer it handed over to failed and left
 * this process running with its server stopped: clear the quitting state,
 * restart the server unless the mandatory block holds the app, then show the
 * window. Clearing comes first because [[revealApp]] does nothing while
 * quitting.
 * @param hooks - the effects.
 */
export async function resumeAfterFailedInstall(hooks: ResumeHooks): Promise<void> {
  hooks.clearQuitting()
  if (!hooks.blocking) await hooks.restartServer()
  hooks.reveal()
}
