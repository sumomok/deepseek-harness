/**
 * The one line a block says about the gesture it last reported, and the rule
 * for whether another one may still be reported.
 *
 * A renderer is told rather than remembering: the placement package unmounts a
 * block whenever the user looks at something else, so a control that kept its
 * own pressed flag would come back untouched and let one gesture be reported
 * twice. Every interactive component in this row therefore draws the same four
 * sentences from the same {@link ComponentActionState} — which is why they live
 * here rather than once per component, and why the dictionary keys they name
 * are the row's own `action.*` rather than any one component's.
 *
 * `el.confirm-bar` keeps its own copy of these sentences under `confirmBar.*`:
 * a bar answers one question once and says so in its own words, and rewording
 * it is a change to that block rather than to every block that reports
 * anything.
 * @module @deepseek-ai/dsh-experimental-component-kit/src/client/action-state
 */
import css from './action-state.module.css'
import type { ComponentActionState, ComponentKitTranslate } from './renderer.ts'

/**
 * The line each state is said with. A closed table, so a state added to the
 * contract fails to compile here rather than leaving a block silent about
 * itself.
 */
const ACTION_STATE_LINE = {
  sending: 'action.sending',
  sent: 'action.sent',
  queued: 'action.queued',
  refused: 'action.refused',
} as const satisfies Readonly<Record<Exclude<ComponentActionState, 'idle'>, string>>

/** The states a further gesture may still be reported from. */
export const PRESSABLE: readonly ComponentActionState[] = ['idle', 'refused']

/** What {@link ActionStateLine} draws. */
export interface ActionStateLineProps {
  /** How far the block's last reported gesture got. */
  readonly state: ComponentActionState
  /** This row's translate. */
  readonly t: ComponentKitTranslate
}

/**
 * Say where the block's last gesture went.
 * @param props - the state and this row's translate.
 * @returns the line, or nothing at all for a block nobody has touched.
 */
export function ActionStateLine({ state, t }: ActionStateLineProps) {
  if (state === 'idle') return null
  return (
    <p className={css.state} data-component-sent data-component-state={state}>{t(ACTION_STATE_LINE[state])}</p>
  )
}
