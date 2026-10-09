/**
 * `toy.form-page` — the add and modify form of one table, drawn beside that
 * table's data page in a written-down view.
 *
 * The component is the vendored `@sumomok/toy-crud-kit`'s `FormPage`: the
 * deployment's own form, without the dialog it opens in on the data page. What
 * it edits is its `request`, which the view binds to the data page's `editing`
 * output, so a press of the data page's add button or a row's modify button
 * opens it, and the data page withdrawing that output empties it. Until then
 * the form draws nothing and requests nothing, and this block draws the line
 * saying where the form comes from. The form judges every request itself: it
 * reads and writes only its own `relatedMeta`, refuses a request naming
 * another table, checks the table's page-level access before it opens, and
 * checks the table, the mode, the row and the abilities once more before it
 * writes.
 *
 * Like the data page it requests through the kit's request layer with the
 * visitor's own credential, so it waits on the same base path and is mounted
 * in a contained box the same way (`crud-box.ts`). It takes the host's verdict
 * on this visitor, `abilities`, exactly as the data page does — fetched by
 * table from the node half and spread last — so an ability the verdict turns
 * off removes the form's save button for that mode. Nothing of the block reads
 * a cookie, browser storage or the address bar; the credential is the request
 * layer's own.
 *
 * It reports one gesture, a saved record, as `added` or `modified` by the
 * form's mode, carrying the fields that name it. The form trims that record
 * itself before it hands it over — to the columns the table's data page last
 * reported, less every attribute any of the table's schemes masks — and this
 * renderer holds what is left to what a report carries. A table no data page
 * has reported the columns of reports the save with no field. Refreshing the
 * data page and the card beside it after a save is the kit's own notice by
 * table, not anything this block publishes.
 *
 * element-ui must already be installed on the shared runtime — the row's client
 * plugin does that when it starts, and a test drawing this block on its own
 * calls `installElementUI()` first.
 */
import { useEffect, useMemo, useRef } from 'react'
import { FormPage, type FormPageSavedPayload } from '@sumomok/toy-crud-kit'
import { readFormPage, readFormSaved, type FormPageVueProps } from './data-page-read.ts'
import { useBasePathState, useContainedComponent } from './crud-box.ts'
import { useAbilities } from './use-abilities.ts'
import { keepMarked, markFormPage } from './marks.ts'
import type { DataPageAbilityTable } from '../route.ts'
import type { VueEventHandlers } from './vue2-bridge.tsx'
import css from './crud-part.module.css'
import type { ComponentKitKey } from './locales.ts'
import type { ComponentActionHandler, ComponentRendererProps } from './renderer.ts'

/** The catalog id a block names to get this component. */
const COMPONENT_ID = 'toy.form-page'

/** Action id a saved new record is reported under. */
const ADDED_ACTION_ID = 'added'

/** Action id a saved edit is reported under. */
const MODIFIED_ACTION_ID = 'modified'

/** What `FormPage` is mounted with: the block's properties, then the host's verdict on this visitor. */
type FormPageMountProps = FormPageVueProps & {
  /** What this visitor may do on this table; only ever removes a save button. */
  readonly abilities: DataPageAbilityTable
}

/** The action a save reports, by the mode of the request the form is open on. */
const SAVE_ACTION: Readonly<Record<string, string>> = {
  add: ADDED_ACTION_ID,
  modify: MODIFIED_ACTION_ID,
}

/**
 * The action saving this form reports right now.
 * @param vueProps - the form's properties, as the block is drawing it.
 * @returns the mode's action, or `undefined` for a form no request opened.
 */
function saveAction(vueProps: FormPageMountProps): string | undefined {
  const mode = vueProps.request?.['mode']
  return typeof mode === 'string' ? SAVE_ACTION[mode] : undefined
}

/** What one drawn form needs. */
interface FormPageBlockProps {
  /** The block's properties and the host's verdict, as `FormPage` takes them. */
  readonly vueProps: FormPageMountProps
  /** Where a gesture goes. */
  readonly onAction: ComponentActionHandler
}

/** The form itself, drawn once the base path its requests go under is in force. */
function FormPageBlock({ vueProps, onAction }: FormPageBlockProps) {
  const report = useRef(onAction)
  useEffect(() => { report.current = onAction })
  const on = useMemo<VueEventHandlers>(() => ({
    'form-saved': (payload: FormPageSavedPayload) => {
      const saved = readFormSaved(payload)
      if (saved !== undefined) report.current(payload.mode === 'add' ? ADDED_ACTION_ID : MODIFIED_ACTION_ID, saved)
    },
  }), [])
  const { box, host } = useContainedComponent({ component: FormPage, props: vueProps, on })
  // The form and its save button are drawn by Vue inside this box, and the
  // request the form is open on is what decides which action a save reports,
  // so the mark pass reads the current properties through a ref the way every
  // other effect that outlives its commit does.
  const marking = useRef({ props: vueProps })
  useEffect(() => { marking.current = { props: vueProps } })
  useEffect(() => keepMarked(box.current as HTMLDivElement, (root) => {
    const save = saveAction(marking.current.props)
    markFormPage(root, save === undefined ? {} : { save })
  }), [])
  return (
    <div ref={box} className={vueProps.request === undefined ? css.idleBox : css.box}>
      <div ref={host} className={css.host} />
    </div>
  )
}

/** Why a block is drawing a line instead of its form. */
type FormPageStall = 'preparing' | 'address' | 'table'

/** The line each stall draws. */
const STALL_LINE: Readonly<Record<FormPageStall, ComponentKitKey>> = {
  preparing: 'formPage.preparing',
  address: 'formPage.unavailable',
  table: 'formPage.noTable',
}

/**
 * Render one form page block.
 * @param rendererProps - the block's identity, its properties, the action sink, and this row's translate. The form
 * publishes nothing and answers no question, so the output sink and the action state go unread.
 * @returns the form inside its contained box, under the line saying where it comes from while it has nothing to edit,
 * or the line saying why it is not drawn yet.
 */
export function FormPageRenderer({ nodeId, props, onAction, t }: ComponentRendererProps) {
  const basePath = useBasePathState()
  // Keyed on the block's property record, which the placement package replaces
  // exactly when the request bound into it changes.
  const vueProps = useMemo(() => readFormPage(props), [props])
  const abilities = useAbilities(vueProps?.relatedMeta)
  const formProps = useMemo(
    () => (vueProps === undefined ? undefined : { ...vueProps, abilities }),
    [vueProps, abilities],
  )
  if (formProps === undefined || basePath !== 'ready') {
    const stalled: FormPageStall = formProps === undefined ? 'table' : basePath === 'failed' ? 'address' : 'preparing'
    return (
      <section className={css.section} data-component-block={COMPONENT_ID} data-component-node={nodeId}>
        <p className={css.notice} data-form-page-stalled={stalled}>{t(STALL_LINE[stalled])}</p>
      </section>
    )
  }
  return (
    <section className={css.section} data-component-block={COMPONENT_ID} data-component-node={nodeId}>
      {formProps.request === undefined && <p className={css.notice} data-form-page-idle="">{t('formPage.idle')}</p>}
      <FormPageBlock vueProps={formProps} onAction={onAction} />
    </section>
  )
}
