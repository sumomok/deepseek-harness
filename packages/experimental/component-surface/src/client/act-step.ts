/**
 * The `act_component` step this page is running, held where the step executor
 * and the seat both see it, so a gesture a block reports while the agent's own
 * `click` or `set` step runs is reported as that step's.
 *
 * One holder per plugin instance, created by `client/index.ts` and handed to the
 * channel seat that runs steps and to the seats that report gestures; this
 * module keeps no state of its own. The holder carries one step at most, which
 * holds because the host runs one `act_component` call at a time and only the
 * tab that claimed a call runs its steps.
 *
 * Only a `click` or a `set` is held, from the moment it starts until the
 * executor resumes after the step's own promise settles. What is marked is
 * what a block reports in that time: what the press or the write reports
 * synchronously, what is reported while a `set` waits for a select to take
 * its option, and possibly a promise callback the press or the write queued
 * directly, since how many microtask hops fall inside depends on the step. A
 * report a block sends from a timer or a later task — an answer from a
 * backend the press asked — and every report sent while a `wait` step runs
 * are reported as the user's; a gesture the user makes inside a held step's
 * window is reported as the step's. The README records both as limitations.
 * @module @deepseek-ai/dsh-experimental-component-surface/client/act-step
 */
import type { ComponentAction } from '../component-call.ts'

/** One step of one `act_component` call while it runs. */
export interface RunningActStep {
  /** The entry the call acts in. */
  readonly entryId: string
  /** The call the step belongs to. */
  readonly callId: string
  /** Which of the call's steps, counting from 1. */
  readonly step: number
}

/** Where the running step is held; `current` is empty between steps and while a `wait` step runs. */
export interface ActStepHolder {
  /** The `click` or `set` step running now, or `undefined` while none is. */
  current: RunningActStep | undefined
}

/**
 * Create the holder one plugin instance shares between its step executor and its seats.
 * @returns an empty holder.
 */
export function actStepHolder(): ActStepHolder {
  return { current: undefined }
}

/**
 * Mark one reported gesture with the step running in its entry, where one is.
 * @param holder - the plugin instance's holder.
 * @param action - the gesture as the block reported it.
 * @returns the gesture, carrying `step` when a step of a call acting in the same
 *   entry is running, and unchanged otherwise.
 */
export function markRunningStep(holder: ActStepHolder, action: ComponentAction): ComponentAction {
  const running = holder.current
  if (running?.entryId !== action.entryId) return action
  return { ...action, step: { call: running.callId, index: running.step } }
}
