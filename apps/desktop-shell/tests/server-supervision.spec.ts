/**
 * The recovery ladder's decision logic: which tier one unexpected server exit
 * lands on, how the L0 rebind sequence spaces and counts its attempts, the
 * 10-minute flapping window, and the L2 guard after a recovery relaunch.
 * @module
 */

import { describe, expect, it } from 'vitest'
import {
  classifyStoppedDialogAnswer,
  L2_GUARD_WINDOW_MS,
  REBIND_DELAYS_MS,
  RECOVERY_RELAUNCH_FLAG,
  type RecoveryHooks,
  STOPPED_DIALOG_BUTTONS,
  STOPPED_DIALOG_CANCEL_INDEX,
  UNEXPECTED_EXIT_ESCALATION_COUNT,
  UNEXPECTED_EXIT_WINDOW_MS,
  initialSupervisorState,
  isRecoveryRelaunchInstance,
  onRebindFailed,
  onRebindSucceeded,
  onUnexpectedServerExit,
  runRecoveryLadder,
  type SupervisorState,
} from '../src/server-supervision.ts'

describe('isRecoveryRelaunchInstance', () => {
  it('is true only when argv carries the flag', () => {
    expect(isRecoveryRelaunchInstance(['node', 'main.js'])).toBe(false)
    expect(isRecoveryRelaunchInstance(['node', 'main.js', RECOVERY_RELAUNCH_FLAG])).toBe(true)
  })
})

describe('onUnexpectedServerExit', () => {
  it('starts the L0 sequence at its first, shortest backoff', () => {
    const { state, action } = onUnexpectedServerExit(initialSupervisorState, 1_000, false, 0)
    expect(action).toEqual({ type: 'recover', attempt: 1, totalAttempts: REBIND_DELAYS_MS.length, delayMs: REBIND_DELAYS_MS[0] })
    expect(state.recentUnexpectedExits).toEqual([1_000])
    expect(state.rebindFailures).toBe(0)
  })

  it('escalates straight to relaunch on the Nth unexpected exit inside the window, even with no prior rebind failures', () => {
    let state: SupervisorState = initialSupervisorState
    for (let i = 0; i < UNEXPECTED_EXIT_ESCALATION_COUNT - 1; i++) {
      const step = onUnexpectedServerExit(state, i * 1_000, false, 0)
      expect(step.action.type).toBe('recover')
      state = step.state
    }
    const last = onUnexpectedServerExit(state, (UNEXPECTED_EXIT_ESCALATION_COUNT - 1) * 1_000, false, 0)
    expect(last.action).toEqual({ type: 'relaunch' })
  })

  it('does not count an unexpected exit outside the trailing window', () => {
    let state: SupervisorState = initialSupervisorState
    state = onUnexpectedServerExit(state, 0, false, 0).state
    state = onUnexpectedServerExit(state, UNEXPECTED_EXIT_WINDOW_MS + 1, false, 0).state
    // Both exits happened, but the first fell out of the window by the time
    // the second arrived, so only one is inside it — not an escalation.
    expect(state.recentUnexpectedExits).toEqual([UNEXPECTED_EXIT_WINDOW_MS + 1])
    const third = onUnexpectedServerExit(state, UNEXPECTED_EXIT_WINDOW_MS + 2, false, 0)
    expect(third.action.type).toBe('recover')
  })

  it('prunes an exit the instant it ages out of the window, exactly at the boundary', () => {
    const state: SupervisorState = { recentUnexpectedExits: [0, UNEXPECTED_EXIT_WINDOW_MS - 1], rebindFailures: 0 }
    const { state: next } = onUnexpectedServerExit(state, UNEXPECTED_EXIT_WINDOW_MS, false, 0)
    // now(=WINDOW_MS) - 0 is exactly WINDOW_MS, no longer "< WINDOW_MS".
    expect(next.recentUnexpectedExits).toEqual([UNEXPECTED_EXIT_WINDOW_MS - 1, UNEXPECTED_EXIT_WINDOW_MS])
  })

  it('resets rebindFailures on a fresh unexpected exit', () => {
    const flapping: SupervisorState = { recentUnexpectedExits: [0], rebindFailures: 2 }
    const { state } = onUnexpectedServerExit(flapping, 1_000, false, 0)
    expect(state.rebindFailures).toBe(0)
  })

  it('goes straight to stop, not recover, when this instance is itself a recovery relaunch and the exit falls inside the L2 guard window', () => {
    const { state, action } = onUnexpectedServerExit(initialSupervisorState, 5_000, true, 0)
    expect(action).toEqual({ type: 'stop' })
    // The guard verdict does not touch the ladder's own bookkeeping.
    expect(state).toBe(initialSupervisorState)
  })

  it('is exactly at the L2 guard boundary: still guarded one ms before it, ordinary L0 at it', () => {
    const guarded = onUnexpectedServerExit(initialSupervisorState, L2_GUARD_WINDOW_MS - 1, true, 0)
    expect(guarded.action).toEqual({ type: 'stop' })
    const atBoundary = onUnexpectedServerExit(initialSupervisorState, L2_GUARD_WINDOW_MS, true, 0)
    expect(atBoundary.action.type).toBe('recover')
  })

  it('runs the ordinary ladder once a recovery-relaunch instance has outlived the L2 guard window', () => {
    const { action } = onUnexpectedServerExit(initialSupervisorState, 1_000_000, true, 0)
    expect(action.type).toBe('recover')
  })

  it('measures the L2 guard window from this process\'s own start, not from zero', () => {
    const processStartedAt = 50_000
    const guarded = onUnexpectedServerExit(initialSupervisorState, processStartedAt + L2_GUARD_WINDOW_MS - 1, true, processStartedAt)
    expect(guarded.action).toEqual({ type: 'stop' })
  })
})

describe('onRebindFailed / onRebindSucceeded', () => {
  it('walks the rest of REBIND_DELAYS_MS after the first exit, then escalates once exhausted', () => {
    let state = onUnexpectedServerExit(initialSupervisorState, 0, false, 0).state
    for (let i = 1; i < REBIND_DELAYS_MS.length; i++) {
      const step = onRebindFailed(state)
      expect(step.action).toEqual({ type: 'recover', attempt: i + 1, totalAttempts: REBIND_DELAYS_MS.length, delayMs: REBIND_DELAYS_MS[i] })
      state = step.state
    }
    const exhausted = onRebindFailed(state)
    expect(exhausted.action).toEqual({ type: 'relaunch' })
    expect(exhausted.state.rebindFailures).toBe(REBIND_DELAYS_MS.length)
  })

  it('resets rebindFailures to 0 on success, leaving the exit history untouched', () => {
    const state: SupervisorState = { recentUnexpectedExits: [42], rebindFailures: 2 }
    expect(onRebindSucceeded(state)).toEqual({ recentUnexpectedExits: [42], rebindFailures: 0 })
  })
})

/** What a recovery run's hooks were called with; mutated live, so read it after the run rather than destructuring its fields early. */
interface RecoveryCalls {
  delays: number[]
  rebindCalls: number
  notified: number
}

/** Collect a recovery run's hook calls against an instant clock. */
function recorder(rebindResults: readonly boolean[]): { hooks: RecoveryHooks; calls: RecoveryCalls } {
  const calls: RecoveryCalls = { delays: [], rebindCalls: 0, notified: 0 }
  return {
    calls,
    hooks: {
      sleep: async (ms) => { calls.delays.push(ms) },
      rebind: async () => {
        const result = rebindResults[calls.rebindCalls] ?? false
        calls.rebindCalls += 1
        return result
      },
      notifyRecovering: () => { calls.notified += 1 },
    },
  }
}

describe('runRecoveryLadder', () => {
  it('recovers on the first attempt: one notification, one wait, one rebind', async () => {
    const { hooks, calls } = recorder([true])
    const { state, outcome } = await runRecoveryLadder(initialSupervisorState, 0, false, 0, hooks)
    expect(outcome).toBe('recovered')
    expect(calls.delays).toEqual([REBIND_DELAYS_MS[0]])
    expect(calls.rebindCalls).toBe(1)
    expect(calls.notified).toBe(1)
    expect(state.rebindFailures).toBe(0)
  })

  it('walks the whole backoff plan before recovering on the last attempt', async () => {
    const { hooks, calls } = recorder([false, false, true])
    const { outcome } = await runRecoveryLadder(initialSupervisorState, 0, false, 0, hooks)
    expect(outcome).toBe('recovered')
    expect(calls.delays).toEqual([...REBIND_DELAYS_MS])
    expect(calls.rebindCalls).toBe(REBIND_DELAYS_MS.length)
  })

  it('relaunches once every L0 attempt fails, without exceeding the attempt cap', async () => {
    const { hooks, calls } = recorder([])
    const { state, outcome } = await runRecoveryLadder(initialSupervisorState, 0, false, 0, hooks)
    expect(outcome).toBe('relaunch')
    expect(calls.delays).toEqual([...REBIND_DELAYS_MS])
    expect(calls.rebindCalls).toBe(REBIND_DELAYS_MS.length)
    expect(state.rebindFailures).toBe(REBIND_DELAYS_MS.length)
  })

  it('goes straight to stop on an L2-guarded exit, without ever waiting, rebinding, or notifying', async () => {
    const { hooks, calls } = recorder([true])
    const { outcome } = await runRecoveryLadder(initialSupervisorState, 1_000, true, 0, hooks)
    expect(outcome).toBe('stop')
    expect(calls.delays).toEqual([])
    expect(calls.rebindCalls).toBe(0)
    expect(calls.notified).toBe(0)
  })

  it('escalates straight to relaunch on the Nth flapping exit without attempting a rebind', async () => {
    let state = initialSupervisorState
    for (let i = 0; i < UNEXPECTED_EXIT_ESCALATION_COUNT - 1; i++) {
      state = onUnexpectedServerExit(state, i * 1_000, false, 0).state
    }
    const { hooks, calls } = recorder([true])
    const { outcome } = await runRecoveryLadder(state, (UNEXPECTED_EXIT_ESCALATION_COUNT - 1) * 1_000, false, 0, hooks)
    expect(outcome).toBe('relaunch')
    expect(calls.rebindCalls).toBe(0)
  })
})

describe('classifyStoppedDialogAnswer', () => {
  it('classifies each button by its index in STOPPED_DIALOG_BUTTONS', () => {
    expect(classifyStoppedDialogAnswer(STOPPED_DIALOG_BUTTONS.indexOf('重试'))).toBe('retry')
    expect(classifyStoppedDialogAnswer(STOPPED_DIALOG_BUTTONS.indexOf('打开日志'))).toBe('open-log')
    expect(classifyStoppedDialogAnswer(STOPPED_DIALOG_BUTTONS.indexOf('关闭'))).toBe('dismiss')
  })

  it('routes the cancelId (Esc, or any other way of dismissing without a button) to dismiss', () => {
    expect(classifyStoppedDialogAnswer(STOPPED_DIALOG_CANCEL_INDEX)).toBe('dismiss')
  })

  it('treats an index outside the buttons array as dismiss, the safe default', () => {
    expect(classifyStoppedDialogAnswer(-1)).toBe('dismiss')
    expect(classifyStoppedDialogAnswer(99)).toBe('dismiss')
  })

  it('never routes cancelId to retry or open-log', () => {
    expect(classifyStoppedDialogAnswer(STOPPED_DIALOG_CANCEL_INDEX)).not.toBe('retry')
    expect(classifyStoppedDialogAnswer(STOPPED_DIALOG_CANCEL_INDEX)).not.toBe('open-log')
  })
})
