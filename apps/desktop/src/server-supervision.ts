/**
 * The recovery ladder for the embedded server dying on its own, after startup
 * already succeeded once (see [[@deepseek-ai/dsh-desktop/server]] for the
 * startup path itself, which has its own retry).
 *
 * A dead child with nobody watching it is a frozen window with no explanation:
 * the field case this exists for ran 33 minutes with the shell's own
 * reconnect sockets quietly retrying against a server that was never coming
 * back. Three tiers, each a strictly worse outcome than the one before it, so
 * a machine that cannot recover still ends at a human decision instead of a
 * silent hang or a relaunch loop:
 *
 * - **L0** rebinds in place: reuse the same launch spec, with backoff, up to
 *   {@link REBIND_DELAYS_MS}'s length attempts.
 * - **L1** relaunches the whole app once, when L0 is exhausted or the server
 *   keeps dying often enough that rebinding it is not fixing anything.
 * - **L2** stops trying automatically, when even a fresh relaunch dies again
 *   almost immediately — the failure is not transient, and another relaunch
 *   would only loop.
 *
 * This module is the ladder's decision logic only: given what happened and
 * when, what to do about it. It spawns nothing, shows nothing on screen, and
 * knows nothing about Electron; the caller (`main.ts`) supplies those through
 * {@link RecoveryHooks} and carries out whatever {@link runRecoveryLadder}
 * decides.
 * @module @deepseek-ai/dsh-desktop/server-supervision
 */

/**
 * Backoff before each L0 rebind attempt; its length is also the attempt cap.
 * Three attempts spread over 21 seconds cover a server that stumbled on
 * startup — an antivirus scan still warming up, a port that needed a moment to
 * free — without holding a visibly dead window open for long before escalating.
 */
export const REBIND_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000]

/**
 * How many unexpected exits inside {@link UNEXPECTED_EXIT_WINDOW_MS} escalate
 * straight to L1, even when every individual rebind in between succeeded. A
 * server that keeps dying every few minutes is flapping, not stumbling once —
 * rebinding it again is not a fix, and each rebind's own window reload is a
 * visible interruption in its own right.
 */
export const UNEXPECTED_EXIT_ESCALATION_COUNT = 3

/** The trailing window {@link UNEXPECTED_EXIT_ESCALATION_COUNT} is counted over. */
export const UNEXPECTED_EXIT_WINDOW_MS = 10 * 60 * 1000

/**
 * How soon after an L1 relaunch a further unexpected exit is judged the same
 * failure recurring, rather than an unrelated later one. Inside this window
 * the ladder stops (L2) instead of relaunching again, which is what keeps a
 * genuinely broken install from relaunching forever.
 */
export const L2_GUARD_WINDOW_MS = 2 * 60 * 1000

/** The argv flag `app.relaunch` carries so the next instance knows it is L1's own relaunch, not an ordinary launch. */
export const RECOVERY_RELAUNCH_FLAG = '--dsh-recovery-relaunch'

/**
 * Whether this process's own argv carries {@link RECOVERY_RELAUNCH_FLAG}.
 * @param argv - this process's `process.argv`.
 * @returns true when this launch is L1's own relaunch.
 */
export function isRecoveryRelaunchInstance(argv: readonly string[]): boolean {
  return argv.includes(RECOVERY_RELAUNCH_FLAG)
}

/** The ladder's own memory between exits; opaque to the caller besides threading it back in. */
export interface SupervisorState {
  /** Unexpected-exit timestamps still inside {@link UNEXPECTED_EXIT_WINDOW_MS}, oldest first. */
  readonly recentUnexpectedExits: readonly number[]
  /** Failed rebind attempts since the most recent unexpected exit; a successful rebind resets this. */
  readonly rebindFailures: number
}

/** The state before any exit has been observed. */
export const initialSupervisorState: SupervisorState = { recentUnexpectedExits: [], rebindFailures: 0 }

/** One thing the ladder decided to do. */
export type SupervisorAction =
  /** Attempt an L0 rebind after `delayMs`; `attempt` of `totalAttempts` counting from 1. */
  | { type: 'recover'; attempt: number; totalAttempts: number; delayMs: number }
  /** Escalate to L1: relaunch the whole app, once. */
  | { type: 'relaunch' }
  /** Escalate to L2: stop automatic recovery: put the decision to the user. */
  | { type: 'stop' }

/**
 * Decide what to do about one unexpected server exit.
 * @param state - the ladder's state before this exit.
 * @param now - wall-clock ms of the exit.
 * @param isRecoveryRelaunchInstance - whether this process is itself L1's own relaunch.
 * @param processStartedAt - wall-clock ms this process started; read only when `isRecoveryRelaunchInstance`.
 * @returns the updated state and the single action to perform.
 */
export function onUnexpectedServerExit(
  state: SupervisorState,
  now: number,
  isRecoveryRelaunchInstance: boolean,
  processStartedAt: number,
): { state: SupervisorState; action: SupervisorAction } {
  if (isRecoveryRelaunchInstance && now - processStartedAt < L2_GUARD_WINDOW_MS) {
    return { state, action: { type: 'stop' } }
  }
  const recentUnexpectedExits = [...state.recentUnexpectedExits, now].filter(at => now - at < UNEXPECTED_EXIT_WINDOW_MS)
  const next: SupervisorState = { recentUnexpectedExits, rebindFailures: 0 }
  if (recentUnexpectedExits.length >= UNEXPECTED_EXIT_ESCALATION_COUNT) return { state: next, action: { type: 'relaunch' } }
  return { state: next, action: recoverAction(0) }
}

/**
 * Decide what to do after one L0 rebind attempt itself failed to bring the
 * server up (`startServer` rejected) — a second, independent failure, not the
 * newly-rebound server dying again later (that is a fresh
 * {@link onUnexpectedServerExit} call).
 * @param state - the ladder's state before this failure.
 * @returns the updated state and the single action to perform.
 */
export function onRebindFailed(state: SupervisorState): { state: SupervisorState; action: SupervisorAction } {
  const rebindFailures = state.rebindFailures + 1
  const next: SupervisorState = { ...state, rebindFailures }
  return { state: next, action: recoverAction(rebindFailures) }
}

/** Fold in a rebind that brought the server back up: the L0 sequence is over. */
export function onRebindSucceeded(state: SupervisorState): SupervisorState {
  return { ...state, rebindFailures: 0 }
}

/**
 * The next rebind attempt, or escalation once {@link REBIND_DELAYS_MS} is exhausted.
 * @param failuresSoFar - failed attempts already made in this L0 sequence.
 */
function recoverAction(failuresSoFar: number): SupervisorAction {
  const delayMs = REBIND_DELAYS_MS[failuresSoFar]
  if (delayMs === undefined) return { type: 'relaunch' }
  return { type: 'recover', attempt: failuresSoFar + 1, totalAttempts: REBIND_DELAYS_MS.length, delayMs }
}

/** How the ladder's L0 sequence ended. */
export type RecoveryOutcome = 'recovered' | 'relaunch' | 'stop'

/** What {@link runRecoveryLadder} needs from its caller besides the ladder's own decisions. */
export interface RecoveryHooks {
  /** Attempt one rebind (spawn plus retargeting every holder of the old URL); resolves true once the server is back up. */
  rebind: () => Promise<boolean>
  /** Wait before the next attempt; injected so tests run instantly. */
  sleep: (ms: number) => Promise<void>
  /**
   * Announce that automatic recovery is starting. Called once, before the
   * first attempt — never on a `relaunch` or `stop` verdict, which have their
   * own separate ways of telling the user.
   */
  notifyRecovering: () => void
}

/**
 * Run the ladder for one unexpected server exit: decide, and on an L0
 * verdict, carry out attempts through `hooks` until one succeeds or the
 * ladder itself escalates past what L0 can do.
 * @param state - the ladder's state before this exit.
 * @param now - wall-clock ms of the exit.
 * @param isRecoveryRelaunchInstance - whether this process is itself L1's own relaunch.
 * @param processStartedAt - wall-clock ms this process started.
 * @param hooks - the caller's restart, clock, and notification.
 * @returns the updated state and how the sequence ended.
 */
export async function runRecoveryLadder(
  state: SupervisorState,
  now: number,
  isRecoveryRelaunchInstance: boolean,
  processStartedAt: number,
  hooks: RecoveryHooks,
): Promise<{ state: SupervisorState; outcome: RecoveryOutcome }> {
  const first = onUnexpectedServerExit(state, now, isRecoveryRelaunchInstance, processStartedAt)
  if (first.action.type !== 'recover') return { state: first.state, outcome: first.action.type }
  hooks.notifyRecovering()
  let current = first.state
  let action = first.action
  for (;;) {
    await hooks.sleep(action.delayMs)
    const ok = await hooks.rebind()
    if (ok) return { state: onRebindSucceeded(current), outcome: 'recovered' }
    const failed = onRebindFailed(current)
    current = failed.state
    if (failed.action.type !== 'recover') return { state: current, outcome: failed.action.type }
    action = failed.action
  }
}
