/**
 * `el.filter-bar` — a row of query conditions the user edits and sends back.
 *
 * The component is `TuQueryCondAdv`, compiled outside this repository and
 * vendored as `@sumomok/toy-surface-kit`. It is the editor those libraries
 * already use for the condition list their own backends take, so what a user
 * builds here comes out in the vocabulary the rest of that system speaks:
 * `{ key, op, value }`, one entry per condition.
 *
 * Two things about it shape this renderer.
 *
 * **It answers through a method, not an event.** The component emits nothing at
 * all; `getData()` on its instance is the only way to read what the user built.
 * That is what {@link useVueComponent}'s `instanceRef` exists for, and it is
 * also why the button that sends the conditions is drawn here in React rather
 * than being one of the component's own: the component's buttons add and remove
 * condition rows, and none of them means "I am done". What it sends is every
 * complete condition and, where the block asked for the AND/OR choice, the mode
 * the user picked between them; a press holding no complete condition sends
 * nothing at all.
 *
 * A filter bar publishes nothing for the blocks beside it, so `onOutput` goes
 * unread here: no component in this row takes a condition list as a property,
 * and the catalog that would name the output declares none. What an edit does
 * reach is the agent, as the `change` gesture and its count.
 *
 * **It reads the attribute list once.** `metaConfig` is copied into the
 * component's own data when it is created and never watched, so a later call
 * carrying different attributes would leave the user choosing from the previous
 * ones. The Vue root is therefore remounted whenever the block's narrowed
 * properties change, which is exactly when the call behind the block changed —
 * and a remount is what the user would expect from a new call anyway.
 *
 * `metaConfig` is always passed, even when the block declares none: without it
 * the component fetches the attribute list itself, and the vendored build
 * answers that fetch by throwing. An empty attribute list is a filter bar with
 * nothing to filter on; a fetch is a red line.
 *
 * element-ui must already be installed on the shared runtime — the row's client
 * plugin does that when it starts, and a test drawing this block on its own
 * calls `installElementUI()` first.
 */
import { useEffect, useMemo, useRef } from 'react'
import { TuQueryCondAdv, type TuQueryCondAdvInstance } from '@sumomok/toy-surface-kit'
import { ActionStateLine, PRESSABLE } from './action-state.tsx'
import { readBoolean, readList, readNumber, readRecord, readText } from './props.ts'
import { VueBridge } from './vue2-bridge.tsx'
import css from './TuQueryCondAdvRenderer.module.css'
import type { ComponentActionHandler, ComponentRendererProps } from './renderer.ts'
import type { VueInstance } from './vue-shim.ts'

/** The catalog id a block names to get this component. */
const COMPONENT_ID = 'el.filter-bar'

/** Action id the conditions are sent under. */
const SUBMIT_ACTION_ID = 'submit'

/** Action id an edit to the conditions is reported under. */
const CHANGE_ACTION_ID = 'change'

/**
 * One attribute the user may build a condition on, as the component wants it.
 *
 * The block declares the attribute's user-facing text as `alias`, which is what
 * the rest of that system calls it; the component reads `attributeCnName`, so
 * the name is translated here rather than sent.
 *
 * `dataType` chooses the value control — a text box, a date picker, or a number
 * input — but the component only consults it for an attribute whose `ifChange`
 * is `'0'`, the value meaning "a plain field rather than a translated or
 * enumerated one". That is the only kind a block may declare, because the other
 * kinds draw controls that fetch their own options and the vendored build
 * replaced those with a disabled stand-in. So the flag is written dead beside
 * every declared `dataType`, and an attribute that declares none gets the
 * component's own default of a text box.
 */
type FilterAttribute = {
  /** The attribute's name in the data, and the `key` of a condition built on it. */
  readonly attributeEnName: string
  /** The name the user reads in the attribute list. */
  readonly attributeCnName?: string
  /** What kind of value it holds, which decides the control it is typed into. */
  readonly dataType?: string
  /** Written dead beside {@link dataType}: the one attribute kind whose control needs no backend. */
  readonly ifChange?: '0'
}

/** One match strategy the user may pick. */
type FilterEqEnum = {
  /** The `op` a condition built with it carries. */
  readonly value: string
  /** The name the user reads in the strategy list. */
  readonly label: string
}

/**
 * How wide the four columns are and whether the AND/OR choice is offered.
 *
 * Every field, always: the component reads all three without a guard, so a
 * half-declared layout would draw a row of columns with no width at all.
 */
type FilterStyle = {
  /** Gap between the columns. */
  readonly gutter: number
  /** The four columns' widths, in twenty-fourths of the row. */
  readonly spanList: readonly number[]
  /** Whether the user may choose between AND and OR. */
  readonly showMatchMode: boolean
}

/**
 * Widths of the condition row's four columns, in twenty-fourths.
 *
 * Fixed here rather than declared by a block: the four columns hold an
 * attribute list, a strategy list, one value control and the add/remove
 * buttons, and what they need is the component's own even split. A block
 * declaring its own widths would be choosing a layout for a row whose contents
 * it does not decide.
 */
const COLUMN_SPANS: readonly number[] = [6, 6, 6, 6]

/** Gap between those columns when a block declares none, as the component's own default. */
const DEFAULT_GUTTER = 50

/** What `TuQueryCondAdv` receives, as this renderer builds it. */
type TuQueryCondAdvVueProps = {
  /** What is being filtered, in the vocabulary the data uses. */
  readonly relatedMeta: string
  /** The attributes and nothing else, so the component never fetches. */
  readonly metaConfig: { readonly attributes: readonly FilterAttribute[] }
  /** The match strategies; the component's own when absent. */
  readonly attrEqEnums?: readonly FilterEqEnum[]
  /** The layout, always complete. */
  readonly confStyle: FilterStyle
}

/** One condition, as the user built it and as it is reported. */
interface FilterCondition {
  /** The attribute, by its name in the data. */
  readonly key: string
  /** The match strategy. */
  readonly op: string
  /** What the user typed or picked, as its own text. */
  readonly value: string
}

/**
 * What the change watcher reads at the moment it fires.
 *
 * The watcher is bound to the mounted instance and outlives every React commit
 * that does not remount it, so what it reports through is read out of a ref the
 * renderer refreshes on every commit rather than closed over.
 */
interface FilterEventContext {
  /** Where a gesture goes. */
  readonly onAction: ComponentActionHandler
}

/**
 * Read one attribute.
 * @param value - one item of the `metaConfig.attributes` property.
 * @returns the attribute, or `undefined` when it names nothing in the data.
 */
function readAttribute(value: unknown): FilterAttribute | undefined {
  const record = readRecord(value)
  if (record === undefined) return undefined
  const attributeEnName = readText(record['attributeEnName'])
  if (attributeEnName === undefined) return undefined
  const attributeCnName = readText(record['alias'])
  const dataType = readText(record['dataType'])
  return {
    attributeEnName,
    ...(attributeCnName === undefined ? {} : { attributeCnName }),
    ...(dataType === undefined ? {} : { dataType, ifChange: '0' } as const),
  }
}

/**
 * Read one match strategy.
 * @param value - one item of the `attrEqEnums` property.
 * @returns the strategy, or `undefined` when it carries no `op` or no name.
 */
function readEqEnum(value: unknown): FilterEqEnum | undefined {
  const record = readRecord(value)
  if (record === undefined) return undefined
  const enumValue = readText(record['value'])
  const label = readText(record['label'])
  if (enumValue === undefined || label === undefined) return undefined
  return { value: enumValue, label }
}

/**
 * Read the layout, filling in what the block left out.
 *
 * The AND/OR choice is off unless the block asks for it. It is a control whose
 * value only reaches the agent through the submitted action, so a block that
 * did not ask for it gets a bar whose every control is one the answer carries.
 * @param value - the `confStyle` property value.
 * @returns the whole layout, every field of it.
 */
function readStyle(value: unknown): FilterStyle {
  const record = readRecord(value)
  return {
    gutter: readNumber(record?.['gutter']) ?? DEFAULT_GUTTER,
    spanList: COLUMN_SPANS,
    showMatchMode: readBoolean(record?.['showMatchMode']) ?? false,
  }
}

/**
 * Read one condition the component answered with.
 *
 * The attribute and the strategy are the ones the user picked out of the two
 * lists this renderer supplied, and `getData()` answers only for a condition
 * that has both, so they are read as the strings they are. The value is the one
 * thing the user wrote themselves, and it is reported as data rather than as
 * anything the interface says: what a filter bar is for is the user narrowing
 * what the agent looks at, and the words they narrowed it with are the answer.
 * A value that would not survive being written into the action document is
 * dropped with its condition.
 * @param value - one entry of `getData().conditions`.
 * @returns the condition, or `undefined` when its value is not one the action document can carry.
 */
function readCondition(value: unknown): FilterCondition | undefined {
  const { key, op, value: raw } = value as { readonly key: string; readonly op: string; readonly value: unknown }
  return typeof raw === 'string' ? { key, op, value: raw } : undefined
}

/**
 * Narrow a block's properties to what `TuQueryCondAdv` declares.
 * @param props - the block's already-validated properties.
 * @returns the component's prop record, always carrying an attribute list so the component never fetches one.
 */
function readTuQueryCondAdv(props: ComponentRendererProps['props']): TuQueryCondAdvVueProps {
  const eqEnums = readList(props['attrEqEnums'], readEqEnum)
  return {
    relatedMeta: readText(props['relatedMeta']) ?? '',
    metaConfig: { attributes: readList(readRecord(props['metaConfig'])?.['attributes'], readAttribute) },
    confStyle: readStyle(props['confStyle']),
    ...(eqEnums.length === 0 ? {} : { attrEqEnums: eqEnums }),
  }
}

/**
 * Render one filter bar.
 * @param rendererProps - the block's identity, its properties, the action sink, how far its last gesture got, and this row's translate.
 * @returns the condition editor, the button that sends what it holds, and the line saying where the last gesture went.
 */
export function TuQueryCondAdvRenderer({ nodeId, props, onAction, state, t }: ComponentRendererProps) {
  const vueProps = useMemo(() => readTuQueryCondAdv(props), [props])
  const instanceRef = useRef<VueInstance | null>(null)
  const context = useRef<FilterEventContext>({ onAction })
  useEffect(() => {
    context.current = { onAction }
  })
  // The attribute list is read into the component's own data when it is
  // created, so a call carrying a different one is a different component.
  const mountKey = useMemo(() => JSON.stringify(vueProps), [vueProps])
  useEffect(() => {
    const instance = instanceRef.current as TuQueryCondAdvInstance
    return instance.$watch('queryConditions', () => {
      // What the agent is told an edit was is that something changed, and how
      // many conditions stand after it; the conditions themselves are the
      // submit's to carry.
      context.current.onAction(CHANGE_ACTION_ID, { count: instance.getData().conditions.length })
    }, { deep: true })
  }, [mountKey])
  const pressable = PRESSABLE.includes(state)
  return (
    <section className={css.bar} data-component-block={COMPONENT_ID} data-component-node={nodeId}>
      <VueBridge key={mountKey} component={TuQueryCondAdv} props={vueProps} instanceRef={instanceRef} />
      <div className={css.actions}>
        <button
          type="button"
          className={css.submit}
          data-component-action={SUBMIT_ACTION_ID}
          disabled={!pressable}
          onClick={() => {
            const instance = instanceRef.current as TuQueryCondAdvInstance
            const data = instance.getData()
            const conditions = readList(data.conditions, readCondition)
            // The bar starts holding one empty condition row, so a press before
            // the user has built anything is a press with nothing to answer
            // with. Sending it would earn the block the sentence saying the
            // gesture was not recorded, for a filter nobody submitted.
            if (conditions.length === 0) return
            onAction(SUBMIT_ACTION_ID, {
              conditions,
              ...(vueProps.confStyle.showMatchMode ? { matchMode: data.matchMode } : {}),
            })
          }}
        >
          {t('filterBar.submit')}
        </button>
      </div>
      <ActionStateLine state={state} t={t} />
    </section>
  )
}
