/**
 * `toy.record` — a read-only record: label/value pairs laid out in columns.
 *
 * The component itself is `TcFormDetail`, compiled outside this repository and
 * vendored as `@sumomok/toy-surface-kit`. It is the smallest thing that tree
 * carries — plain data in, nothing emitted, nothing fetched — which is what
 * makes it the block that proves the whole Vue path: the vendored tarball, the
 * shared Vue runtime, element-ui, and the bridge.
 *
 * Everything the block says is the caller's text. This renderer owns no copy of
 * its own, so it takes no translate; it narrows the block's properties to what
 * the component declares and hands them over.
 *
 * A record reports nothing. `onAction` and the action state a placement package
 * passes are unread here, and the block draws the same in every one of them.
 *
 * element-ui must already be installed on the shared runtime — the row's client
 * plugin does that when it starts, and a test drawing this block on its own
 * calls `installElementUI()` first. Without it the labels' tooltips render as
 * unknown elements and the row's own styling is missing.
 */
import { useMemo } from 'react'
import { TcFormDetail } from '@sumomok/toy-surface-kit'
import { useVueComponent } from './vue2-bridge.tsx'
import type { ComponentRendererProps } from './renderer.ts'

/** The catalog id a block names to get this component. */
const COMPONENT_ID = 'toy.record'

/** One row: a label and the already-formatted value beside it. */
type RecordRow = {
  /** The attribute's name, as the row's own heading. */
  readonly label: string
  /** The value as text, empty included: the component draws the label and nothing beside it. */
  readonly display: string
}

/** What `TcFormDetail` receives, as this renderer builds it. */
type TcFormDetailVueProps = {
  /** The rows, in order. */
  readonly dataList: readonly RecordRow[]
  /** CSS width of the label column, as `TcFormDetail` wants it; the component's own default applies when absent. */
  readonly labelWidth?: string
  /** How many rows sit side by side; the component's own default applies when absent. */
  readonly columnNum?: number
}

/**
 * Read one text property that names something, where blank names nothing.
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
 * Read one row's value as text.
 *
 * The catalog admits only text, numbers, and booleans in a property position,
 * and the component draws whatever it is given as a text node, so a number and
 * a boolean become their own text here rather than reaching Vue as a type the
 * component's `v-if` reads differently (`0` and `false` are values a record
 * must still show).
 *
 * An empty string is a value, not an absent one: the row is kept and the
 * component's own `v-if` draws the label with nothing beside it, which is what
 * an attribute the record has but does not fill looks like. Only a value that
 * is not text at all leaves the row without one.
 * @param value - the row's `display` value.
 * @returns the text, or `undefined` when the value is not text the component can draw.
 */
function readDisplay(value: unknown): string | undefined {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return typeof value === 'string' ? value : undefined
}

/**
 * Read how many rows sit side by side.
 * @param value - the `columnNum` property value.
 * @returns the count, or `undefined` when the block declares none the component can use.
 */
function readColumnNum(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * Read the width of the label column.
 *
 * The catalog declares this a number of pixels, because a length is the one
 * thing a model can be asked for without also being able to write a CSS value
 * of its own choosing into the component's style. `TcFormDetail` wants the CSS
 * length, so the unit is added here rather than sent.
 * @param value - the `labelWidth` property value.
 * @returns the CSS length, or `undefined` when the block declares no width the component can use.
 */
function readLabelWidth(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? `${value}px` : undefined
}

/**
 * Read the rows.
 * @param value - the `dataList` property value.
 * @returns every row carrying a label and a value the component can draw, in order.
 */
function readRows(value: unknown): readonly RecordRow[] {
  if (!Array.isArray(value)) return []
  const rows: RecordRow[] = []
  for (const item of value as readonly unknown[]) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const label = readText(record.label)
    const display = readDisplay(record.display)
    if (label === undefined || display === undefined) continue
    rows.push({ label, display })
  }
  return rows
}

/**
 * Narrow a block's properties to what `TcFormDetail` declares.
 * @param props - the block's already-validated properties.
 * @returns the component's prop record, with an absent optional left absent so the component's own default applies.
 */
function readTcFormDetail(props: ComponentRendererProps['props']): TcFormDetailVueProps {
  const labelWidth = readLabelWidth(props.labelWidth)
  const columnNum = readColumnNum(props.columnNum)
  return {
    dataList: readRows(props.dataList),
    ...(labelWidth === undefined ? {} : { labelWidth }),
    ...(columnNum === undefined ? {} : { columnNum }),
  }
}

/**
 * Render one record block.
 * @param rendererProps - the block's identity and its properties. A record
 * reports nothing, so the action sink, the action state, and the translate go
 * unread.
 * @returns the host element the Vue component is mounted into.
 */
export function TcFormDetailRenderer({ nodeId, props }: ComponentRendererProps) {
  // Keyed on the block's property record: the placement package hands over the
  // same object until the call behind the block changes, so the Vue root is
  // handed the same prop record on every unrelated React commit and re-renders
  // for none of them.
  const vueProps = useMemo(() => readTcFormDetail(props), [props])
  // The block's own element is the Vue host, so the record sits directly under
  // the attributes a placement package and a snapshot identify the block by.
  const host = useVueComponent<HTMLDivElement>({ component: TcFormDetail, props: vueProps })
  return <div ref={host} data-component-block={COMPONENT_ID} data-component-node={nodeId} />
}
