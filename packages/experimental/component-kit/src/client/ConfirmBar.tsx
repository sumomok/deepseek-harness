/**
 * `el.confirm-bar` — a short prompt over a row of buttons.
 *
 * The block puts one decision in front of the user and reports which button was
 * pressed, and nothing else about it. It decides nothing itself: no button
 * carries a meaning this file knows, so a "delete" button here removes nothing
 * and a "confirm" button confirms nothing until the placement package does
 * something with the report.
 *
 * Every string it draws for the decision — the prompt, the explanation, each
 * button's label — comes from the block's properties, so that text is the
 * caller's; this file localizes only what it owns itself, the button row's
 * accessible name and the line saying a press was sent.
 *
 * A bar answers one question once, and it is told rather than remembering: the
 * placement package hands it {@link ComponentRendererProps.state}, folded out
 * of the session's own records, and the bar draws the line for that state and
 * refuses further presses in every state but `idle` and `refused`. A bar that
 * kept its own pressed flag would come back untouched whenever the placement
 * unmounted it — a user looking at something else and back — and let one
 * decision be reported twice; a bar that showed nothing until the agent
 * answered would leave a recorded press and a lost one looking the same, since
 * that answer is a whole turn away if it comes at all. `refused` is pressable
 * because reporting it again is the only thing left to try.
 */
import type { ComponentActionState, ComponentRendererProps } from './renderer.ts'
import css from './ConfirmBar.module.css'

/**
 * The action a press is reported under.
 *
 * A literal copy of the placement package's `CONFIRM_BAR_PRESS_ID`: this row
 * imports no placement package, so the two sides of the name each keep their
 * own copy, the way two client-adjacent packages keep a shared command name
 * (see `dismiss.ts`'s module doc in `dsh-experimental-content-column`). A press
 * reported under any other name is refused there and reaches no agent.
 */
const PRESS_ACTION_ID = 'press'

/** Payload property carrying the pressed button, as that action's schema declares it. */
const PRESSED_BUTTON_FIELD = 'buttonId'

/** How prominent one button is, and the only three answers the catalog admits. */
type ButtonTone = 'primary' | 'default' | 'danger'

/** One button, as this component draws it. */
interface ConfirmBarButton {
  /** The id reported when the user presses it. */
  readonly id: string
  /** The text on it. */
  readonly label: string
  /** Its prominence; a button that declared none is an ordinary one. */
  readonly tone: ButtonTone
}

/** The class of each tone, so a tone never selects a class name by concatenation. */
const TONE_CLASS: Readonly<Record<ButtonTone, string | undefined>> = {
  primary: css.primary,
  default: css.default,
  danger: css.danger,
}

/**
 * The line each state is said with. A closed table, so a state added to the
 * contract fails to compile here rather than drawing a bar that says nothing
 * about itself.
 */
const STATE_LINE = {
  sending: 'confirmBar.sending',
  sent: 'confirmBar.sent',
  queued: 'confirmBar.queued',
  refused: 'confirmBar.refused',
} as const satisfies Readonly<Record<Exclude<ComponentActionState, 'idle'>, string>>

/** The states a further press may still be reported from. */
const PRESSABLE: readonly ComponentActionState[] = ['idle', 'refused']

/**
 * Read one optional text property.
 *
 * The block's properties arrive as `Record<string, unknown>`: the placement
 * package checked them against the catalog schema, but the renderer table is
 * one type for every component, so each renderer narrows what it declared.
 * @param value - the property value.
 * @returns the text, or `undefined` when the block carries none.
 */
function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read one button's tone.
 * @param value - the `tone` property value.
 * @returns the declared tone, or `default`.
 */
function readTone(value: unknown): ButtonTone {
  return value === 'primary' || value === 'danger' ? value : 'default'
}

/**
 * Read the button row.
 * @param value - the `buttons` property value.
 * @returns every button carrying both an id and a label, in order.
 */
function readButtons(value: unknown): readonly ConfirmBarButton[] {
  if (!Array.isArray(value)) return []
  const buttons: ConfirmBarButton[] = []
  for (const item of value as readonly unknown[]) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = readText(record.id)
    const label = readText(record.label)
    if (id === undefined || label === undefined) continue
    buttons.push({ id, label, tone: readTone(record.tone) })
  }
  return buttons
}

/**
 * Render one confirmation bar.
 * @param props - the block's identity, its properties, the action sink, how far its last gesture got, and this row's translate.
 * @returns the prompt, the button row, and — in every state but `idle` — the line saying where the press went.
 */
export function ConfirmBar({ nodeId, props, onAction, state, t }: ComponentRendererProps) {
  const title = readText(props.title)
  const message = readText(props.message)
  const buttons = readButtons(props.buttons)
  const pressable = PRESSABLE.includes(state)
  return (
    <section className={css.bar} data-component-block="el.confirm-bar" data-component-node={nodeId}>
      {title !== undefined && <h3 className={css.title}>{title}</h3>}
      {message !== undefined && <p className={css.message}>{message}</p>}
      <div className={css.actions} role="group" aria-label={t('confirmBar.actions')}>
        {buttons.map(button => (
          <button
            key={button.id}
            type="button"
            className={TONE_CLASS[button.tone]}
            data-component-action={button.id}
            data-component-tone={button.tone}
            disabled={!pressable}
            onClick={() => { onAction(PRESS_ACTION_ID, { [PRESSED_BUTTON_FIELD]: button.id }) }}
          >
            {button.label}
          </button>
        ))}
      </div>
      {state !== 'idle' && (
        <p className={css.state} data-component-sent data-component-state={state}>{t(STATE_LINE[state])}</p>
      )}
    </section>
  )
}
