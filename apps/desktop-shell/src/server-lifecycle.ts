/**
 * The order of the steps around the embedded server's end: an unexpected
 * exit, a crash rebind, a quit, and a window reopened while quitting or after
 * the backend was left stopped. Each function takes its effects as hooks, so
 * the sequencing is testable without Electron; `main.ts` supplies the real
 * ones.
 *
 * The steps exist because the served UI's sign-in cookie is not bound to the
 * process that issued it: it is signed with a secret the Harness home keeps
 * and names its host and port, so it stays valid, until it expires, for any
 * later server on the same port ([[@deepseek-ai/dsh-desktop-shell/server-port]]
 * remembers that port for the next launch). While the server is gone and the
 * window still open, the web client keeps reconnecting to that port, and so
 * would the shell's own notification stream. What a local process listening
 * there could do depends on whether the shell holds the port.
 *
 * **While the shell holds the port**
 * ([[@deepseek-ai/dsh-desktop-shell/listen-socket]]), this holds: from the
 * moment the bind is held until the shell process exits, a connection to
 * `127.0.0.1:<port>` is accepted by the shell's current server child or waits
 * in the socket's queue, and no other process accepts it. Two facts carry it,
 * and it rests on the first alone:
 *
 * 1. The address stays bound by the shell, so another process's bind of
 *    `127.0.0.1:<port>` fails with `EADDRINUSE` while no child runs. A bind of
 *    a wildcard address on the same port succeeds on macOS and receives none
 *    of the connections to the loopback address. On Windows a process of the
 *    same user that sets `SO_REUSEADDR` can bind over the address, as it can
 *    over the running server's own socket at any time. On Linux, where a
 *    socket that sets `SO_REUSEADDR` (libuv sets it on every bind there) may
 *    bind an address no socket listens on, the bind fails only from the first
 *    child's listen on, so another process can take the port before it; the
 *    app is packaged for macOS and Windows.
 * 2. The socket stays listening after a child dies, because the shell's copy
 *    keeps it open: on macOS the first child's listen put it in that state,
 *    and on Windows libuv listened on the shell's own copy when it first sent
 *    the socket. A connection made meanwhile waits in its queue and the next
 *    child answers it (observed on macOS; on Windows it follows from libuv's
 *    source and is checked on a Windows machine before release).
 *
 * So a crash rebind starts the next child on the same socket and keeps the
 * remembered port, and the window returns to the same origin, with the
 * storage that names its open session and drafts. A whole-app relaunch
 * releases the socket with the process; the next instance asks for the
 * remembered port like any launch, while no window is open to send to it.
 *
 * **Without the socket** — no bind held at launch, or a handoff that failed —
 * the port is free from the moment the child dies. An unexpected exit then
 * forgets the remembered port and a crash rebind takes a port the system
 * picks, so a process that takes the old port can answer only an origin the
 * shell has abandoned.
 *
 * In both cases:
 *
 * - An unexpected exit first stops the notification stream, forgets the
 *   remembered port unless the shell holds it, and removes the cookies, and
 *   only then runs the recovery ladder. Every ladder outcome — rebind,
 *   whole-app relaunch, or the stop dialog — then starts from a state where no
 *   request of the shell's own carries a cookie and no launch asks for a port
 *   another process may have taken. The removal costs a reload one token
 *   exchange.
 * - A quit first records that the stop is intentional, for the crash-resume
 *   plugin ([[@deepseek-ai/dsh-desktop-shell/crash-resume-sentinel]]), then
 *   removes the cookies with a short bound, then stops the server; the stop is
 *   sent whether or not the removal finished. The stop a mandatory update
 *   forces at launch, and a system shutdown or log-off, record the same. Only
 *   a server whose child is still running is recorded: an unexpected exit
 *   records nothing, and neither does a later quit of the crashed server.
 * - Reopening the window while quitting does nothing, so no new token
 *   exchange issues a cookie for a server about to be gone. Reopening it with
 *   no window open while the stopped-server dialog is on screen or after it
 *   was dismissed goes to that dialog rather than to a window on a server
 *   that is not running, and a retry there that succeeds opens the window.
 * - An install that failed after the quit began undoes the quit: it clears
 *   the quitting state first, so the window can be shown again, restarts the
 *   server unless the mandatory-update block holds the app — on the held
 *   socket as a crash rebind does, or through the ordinary start without
 *   one — and then shows the window.
 * @module @deepseek-ai/dsh-desktop-shell/server-lifecycle
 */

import { type IntentionalStopReason, writeIntentionalStop } from './crash-resume-sentinel.ts'
import type { ListenHandoff } from './listen-socket.ts'
import type { ServerHandle, ServerSpec } from './server.ts'
import type { StoppedDialogOutcome } from './server-supervision.ts'
import { startHeldOrFallback, startOnPort, type HeldStart } from './server-port.ts'

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
  /** Whether the shell holds the server's port, so that no other process can take it while the ladder runs. */
  keepsPort: boolean
  /** Close the shell's notification stream, so it does not reconnect with its cookie while no server runs. */
  stopNotifications: () => void
  /** Drop the remembered server port, so no later launch asks for the dead server's port; not called while the shell holds it. */
  forgetPort: () => void
  /** Remove the served UI's sign-in cookies. */
  clearCookies: () => Promise<unknown>
  /** Run the recovery ladder. */
  ladder: () => Promise<T>
  /** One log line, ending in a newline. */
  log: (line: string) => void
}

/**
 * Respond to an unexpected server exit: stop the notification stream, forget
 * the port unless the shell holds it, and remove the cookies, the removal
 * bounded by [[COOKIE_CLEAR_BOUND_MS]], then run the ladder.
 * @param hooks - the effects.
 * @returns what the ladder returned.
 */
export async function respondToCrash<T>(hooks: CrashHooks<T>): Promise<T> {
  hooks.stopNotifications()
  if (!hooks.keepsPort) hooks.forgetPort()
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

/** What a start on the held socket after the server stopped needs besides the start. */
export interface HeldRebindHooks {
  /** One log line, ending in a newline. */
  log: (line: string) => void
  /** Drop the remembered server port; runs only when the handoff fails, before the socket is closed. */
  forgetPort: () => void
  /**
   * Stop naming the socket as held; runs with {@link forgetPort}, before the
   * socket is closed, so a start without the socket that then fails too
   * leaves no closed socket for the next attempt to send.
   */
  release: () => void
}

/**
 * Start the server again on the socket the shell holds, after a crash or after
 * a failed install stopped it, so the window keeps its origin. When the
 * handoff fails, the start becomes a crash rebind without the socket: the
 * socket is released, the remembered port forgotten, the socket closed, and
 * the server started on a port the system picks, never the held one, since a
 * window may be open on that origin.
 * @param spec - the recorded launch spec.
 * @param handoff - the held socket and the preload.
 * @param start - starts one server.
 * @param hooks - the log, the port removal and the release of the socket.
 * @returns the running server, its spec, and the handoff it took or undefined after a fallback.
 */
export async function rebindOnHeldSocket(
  spec: ServerSpec, handoff: ListenHandoff, start: (spec: ServerSpec) => Promise<ServerHandle>, hooks: HeldRebindHooks,
): Promise<HeldStart> {
  return startHeldOrFallback({ ...spec, port: 0 }, handoff, start, {
    log: hooks.log,
    beforeClose: () => {
      hooks.release()
      hooks.forgetPort()
    },
  })
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

/** Where an intentional-stop sentinel goes, and where a failed write is logged. */
export interface SentinelTarget {
  /** The Harness home the server runs against. */
  home: string
  /** One log line, ending in a newline. */
  log: (line: string) => void
}

/**
 * Write the intentional-stop sentinel for `handle`, but only while its child
 * is still running. A server that already exited on its own was a crash, and
 * the shell keeps its handle after a crash (the recovery ladder, the stop
 * dialog, a quit, or an update install can all follow), so a later quit or
 * system shutdown must not turn that crash into a stop.
 * @param handle - the server about to be stopped, or undefined when none runs.
 * @param reason - why it is being stopped.
 * @param target - the home and the log.
 * @returns true when the sentinel write was attempted.
 */
export function markIntentionalStop(
  handle: Pick<ServerHandle, 'exited'> | undefined, reason: IntentionalStopReason, target: SentinelTarget,
): boolean {
  if (handle === undefined || handle.exited()) return false
  writeIntentionalStop(target.home, reason, target.log)
  return true
}

/** What a quit's stop of one server needs besides the server. */
export interface QuitStopContext extends SentinelTarget {
  /** Remove the served UI's sign-in cookies. */
  clearCookies: () => Promise<unknown>
  /** How long the stop may take before the quit goes ahead without it. */
  timeoutMs: number
}

/**
 * Stop `handle` for a quit through [[stopForQuit]], writing the sentinel with
 * reason `quit` first when the server is still running.
 * @param handle - the server to stop.
 * @param context - the home, the log, the cookie removal and the deadline.
 * @returns `stopped`, or `timeout` when the stop did not finish in time.
 */
export function stopServerForQuit(handle: ServerHandle, context: QuitStopContext): Promise<'stopped' | 'timeout'> {
  return stopForQuit({
    markIntentional: () => { markIntentionalStop(handle, 'quit', context) },
    stop: handle.stop, clearCookies: context.clearCookies, log: context.log, timeoutMs: context.timeoutMs,
  })
}

/**
 * Stop the server a launch started because a mandatory update blocks the app,
 * writing the sentinel with reason `update` first.
 * @param handle - the server to stop.
 * @param target - the home and the log.
 * @returns once the server exited.
 */
export async function stopForMandatoryUpdate(handle: ServerHandle, target: SentinelTarget): Promise<void> {
  markIntentionalStop(handle, 'update', target)
  await handle.stop()
}

/** What bringing the app to the front needs. */
export interface RevealHooks {
  /** Whether a quit has begun. */
  quitting: () => boolean
  /** Uncover the existing window; false when there is none. */
  revealExisting: () => boolean
  /** Whether the stopped-server dialog is on screen, or was dismissed with no server started since; see {@link StoppedDialog.stopped}. */
  backendStopped: () => boolean
  /** Show the stopped-server dialog, as asked by a reveal. */
  showStopped: () => void
  /** Open a window on the served UI, when a server is running. */
  openWindow: () => void
}

/**
 * Bring the app to the front, unless it is quitting: a window opened then
 * would exchange a launch token for a fresh cookie that outlives the server.
 * With no window to uncover while the stopped-server dialog is on screen or
 * was dismissed, it goes to that dialog instead of opening a window that
 * would wait on a server that is not running.
 * @param hooks - the effects.
 */
export function revealApp(hooks: RevealHooks): void {
  if (hooks.quitting()) return
  if (hooks.revealExisting()) return
  if (hooks.backendStopped()) {
    hooks.showStopped()
    return
  }
  hooks.openWindow()
}

/** What asked for the stopped-server dialog: the recovery ladder giving up, or a reveal with no window to uncover. */
export type StoppedDialogTrigger = 'ladder' | 'reveal'

/** What the stopped-server dialog needs. */
export interface StoppedDialogHooks {
  /** Show the dialog once and resolve with the button the user chose. */
  ask: () => Promise<StoppedDialogOutcome>
  /** Make one manual rebind attempt; resolves true once the server is back up. */
  rebind: () => Promise<boolean>
  /** Show the log file. */
  openLog: () => void
  /** One log line, ending in a newline. */
  log: (line: string) => void
  /** Bring the app to the front, opening a window on the served UI when none is open. */
  reveal: () => void
}

/** The stopped-server dialog and what it remembers between showings. */
export interface StoppedDialog {
  /**
   * Show the dialog until the user retries successfully or dismisses it. While
   * it is already on screen nothing is shown again; a reveal is only noted.
   * @param trigger - what asked for the dialog.
   * @returns once the dialog closed, or at once when it was already open.
   */
  run: (trigger: StoppedDialogTrigger) => Promise<void>
  /**
   * Whether the dialog is on screen, or was dismissed and no server started
   * since: either way no server runs, and a reveal goes to the dialog.
   * @returns true from the dialog's first showing until a retry succeeds or a server starts after a dismissal.
   */
  stopped: () => boolean
  /** Record that a server started outside the dialog, which ends a dismissal. */
  serverStarted: () => void
}

/**
 * The stopped-server dialog's sequence. 「重试」makes one rebind attempt and,
 * when it fails, asks again; 「打开日志」shows the log and asks again;
 * 「关闭」leaves the backend down until a retry or a server start. A
 * successful retry opens the window when a reveal asked for the dialog or
 * arrived while it was open: a reveal is a request to see the app, and the
 * rebind only retargets windows that exist.
 * @param hooks - the effects.
 * @returns the dialog.
 */
export function createStoppedDialog(hooks: StoppedDialogHooks): StoppedDialog {
  let state: 'none' | 'open' | 'dismissed' = 'none'
  let revealAsked = false
  return {
    async run(trigger) {
      if (state === 'open') {
        if (trigger === 'reveal') revealAsked = true
        return
      }
      state = 'open'
      revealAsked = trigger === 'reveal'
      hooks.log('[desktop] automatic recovery stopped after repeated crashes; asking the user\n')
      for (;;) {
        const outcome = await hooks.ask()
        switch (outcome) {
          case 'retry':
            if (!await hooks.rebind()) continue
            state = 'none'
            if (revealAsked) hooks.reveal()
            return
          case 'open-log':
            hooks.openLog()
            continue
          case 'dismiss':
            hooks.log('[desktop] user dismissed the crash dialog; backend stays down\n')
            state = 'dismissed'
            return
        }
      }
    },
    stopped: () => state !== 'none',
    serverStarted: () => {
      if (state === 'dismissed') state = 'none'
    },
  }
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
