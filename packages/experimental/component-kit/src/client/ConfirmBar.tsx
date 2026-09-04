/**
 * `el.confirm-bar` — a short prompt over a row of buttons.
 *
 * The block puts one decision in front of the user and says which button was
 * pressed. It decides nothing itself: no button carries a meaning this file
 * knows, so a "delete" button here removes nothing and a "confirm" button
 * confirms nothing until the placement package does something with the report.
 *
 * Every string it draws — the prompt, the explanation, each button's label —
 * comes from the block's properties, so the whole visible text is the caller's
 * and this file localizes only the button row's accessible name.
 */
import type { ComponentRendererProps } from './renderer.ts'
import css from './ConfirmBar.module.css'

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
 * @param props - the block's identity, its properties, the action sink, and this row's translate.
 * @returns the prompt and the button row.
 */
export function ConfirmBar({ nodeId, props, onAction, t }: ComponentRendererProps) {
  const title = readText(props.title)
  const message = readText(props.message)
  const buttons = readButtons(props.buttons)
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
            onClick={() => { onAction(button.id, nodeId) }}
          >
            {button.label}
          </button>
        ))}
      </div>
    </section>
  )
}
