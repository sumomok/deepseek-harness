/**
 * `toy.info-card` — one record's card, drawn beside a data page in a
 * written-down view.
 *
 * The component is the vendored `@sumomok/toy-crud-kit`'s `InfoCard`: the same
 * card the data page draws at its side, without a close button. What it shows
 * is its `record`, which the view binds to the data page's `opened` output, so
 * a name or a relation link the user clicks on the page fills it, and the page
 * withdrawing that output — it closed its card, was cleared, turned a page, or
 * deleted the record — empties it. Until then the card draws nothing and
 * requests nothing, and this block draws the line saying where the card comes
 * from. The card judges no page-level access, exactly as the page's own card
 * does not when a relation link opens a related table's record.
 *
 * Like the data page it requests through the kit's request layer with the
 * visitor's own credential, so it waits on the same base path and is mounted
 * in a contained box the same way (`crud-box.ts`). Nothing of the block reads a
 * cookie, browser storage or the address bar; the credential is the request
 * layer's own.
 *
 * The card reports what it shows: `card-open` with the record's name — its id
 * where the page named it nothing — and its table, whenever it is handed
 * another record, and `card-close` when it stops showing one. Which record is
 * another one is the card's own judgement, by table and id, so a new object
 * for the same record reports nothing. A block the column drops and draws again
 * is handed the same record and raises the same `card-open` once more; that one
 * is not reported again for the same placing call, which is what keeps a tab
 * switch from telling the agent the card opened twice. Where the view places
 * this block, the data page's own card is switched off, so the page reports no
 * card of its own and a card is reported once.
 *
 * element-ui must already be installed on the shared runtime — the row's client
 * plugin does that when it starts, and a test drawing this block on its own
 * calls `installElementUI()` first.
 */
import { useEffect, useMemo, useRef } from 'react'
import { InfoCard, type InfoCardRecord } from '@sumomok/toy-crud-kit'
import { readCardOpen, readInfoCard, type InfoCardVueProps } from './data-page-read.ts'
import { useBasePathState, useContainedComponent } from './crud-box.ts'
import type { VueEventHandlers } from './vue2-bridge.tsx'
import css from './crud-part.module.css'
import type { ComponentActionHandler, ComponentRendererProps } from './renderer.ts'

/** The catalog id a block names to get this component. */
const COMPONENT_ID = 'toy.info-card'

/** Action id a card showing a record is reported under. */
const CARD_OPEN_ACTION_ID = 'card-open'

/** Action id a card that no longer shows a record is reported under. */
const CARD_CLOSE_ACTION_ID = 'card-close'

/**
 * The last report each property record's card made, serialized.
 *
 * Keyed by the block's property record, which the placement package holds
 * steady while the record bound into it is the same one and replaces when it
 * changes — so a redraw over the same record finds the report it made, and a
 * record opened again after another finds none.
 */
const REPORTED = new WeakMap<Readonly<Record<string, unknown>>, string>()

/** What one drawn card needs. */
interface InfoCardBlockProps {
  /** The block's property record, which its reports are remembered by. */
  readonly props: Readonly<Record<string, unknown>>
  /** The block's properties, as `InfoCard` takes them. */
  readonly vueProps: InfoCardVueProps
  /** Where a gesture goes. */
  readonly onAction: ComponentActionHandler
}

/** The card itself, drawn once the base path its requests go under is in force. */
function InfoCardBlock({ props, vueProps, onAction }: InfoCardBlockProps) {
  const context = useRef({ props, onAction })
  useEffect(() => { context.current = { props, onAction } })
  const on = useMemo<VueEventHandlers>(() => {
    const reportOnce = (actionId: string, payload: Readonly<Record<string, unknown>>): void => {
      const current = context.current
      const signature = JSON.stringify([actionId, payload])
      if (REPORTED.get(current.props) === signature) return
      REPORTED.set(current.props, signature)
      current.onAction(actionId, payload)
    }
    return {
      'info-card-open': (payload: InfoCardRecord) => {
        const report = readCardOpen(payload)
        if (report !== undefined) reportOnce(CARD_OPEN_ACTION_ID, report)
      },
      'info-card-close': () => { reportOnce(CARD_CLOSE_ACTION_ID, {}) },
    }
  }, [])
  const { box, host } = useContainedComponent({ component: InfoCard, props: vueProps, on })
  return (
    <div ref={box} className={vueProps.record === undefined ? css.idleBox : css.box}>
      <div ref={host} className={css.host} />
    </div>
  )
}

/**
 * Render one info card block.
 * @param rendererProps - the block's identity, its properties, the action sink, and this row's translate. The card
 * publishes nothing and answers no question, so the output sink and the action state go unread.
 * @returns the card inside its contained box, under the line saying where it comes from while it shows nothing, or
 * the line saying why it is not drawn yet.
 */
export function InfoCardRenderer({ nodeId, props, onAction, t }: ComponentRendererProps) {
  const basePath = useBasePathState()
  // Keyed on the block's property record, which the placement package replaces
  // exactly when the record bound into it changes.
  const vueProps = useMemo(() => readInfoCard(props), [props])
  return (
    <section className={css.section} data-component-block={COMPONENT_ID} data-component-node={nodeId}>
      {basePath !== 'ready'
        ? (
          <p className={css.notice} data-info-card-stalled={basePath}>
            {t(basePath === 'failed' ? 'infoCard.unavailable' : 'infoCard.preparing')}
          </p>
        )
        : (
          <>
            {vueProps.record === undefined && <p className={css.notice} data-info-card-idle="">{t('infoCard.idle')}</p>}
            <InfoCardBlock props={props} vueProps={vueProps} onAction={onAction} />
          </>
        )}
    </section>
  )
}
