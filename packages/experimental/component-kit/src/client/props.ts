/**
 * The readings every renderer in this row performs on a block's properties.
 *
 * A block's properties reach a renderer as `Record<string, unknown>`, because
 * the renderer table is one type for every component: the placement package
 * already checked them against the catalog schema that admitted the component,
 * and each renderer then narrows what it declared. These are the narrowings
 * more than one component needs, kept here so the same reading is written once
 * and every component that declares a boolean means the same thing by it.
 *
 * None of them is a defense against the caller. What they are for is the type:
 * a value the static interface calls `unknown` has to be read as something
 * before a Vue component's prop record can be built out of it.
 * @module @deepseek-ai/dsh-experimental-component-kit/src/client/props
 */

/** A value a Vue component draws as its own text. */
export type ScalarValue = string | number | boolean

/**
 * Read one text property, where blank names nothing.
 * @param value - the property value.
 * @returns the text, or `undefined` when the block carries none.
 */
export function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read one declared boolean.
 * @param value - the property value.
 * @returns the boolean, or `undefined` when the block declares none.
 */
export function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Read one finite number.
 * @param value - the property value.
 * @returns the number, or `undefined` when the block carries no number a component can use.
 */
export function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Read one record of further properties.
 * @param value - the property value.
 * @returns the record, or `undefined` when the value is not one.
 */
export function readRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Readonly<Record<string, unknown>>
}

/**
 * Read one list, item by item, keeping the items a reader could make sense of.
 *
 * An item the reader answers `undefined` for is dropped rather than refused:
 * both call sites are drawing something, and there is nobody left to tell.
 * @param value - the property value.
 * @param read - how one item is read.
 * @returns the items that survived, in order; empty when the value is not a list.
 */
export function readList<T>(value: unknown, read: (item: unknown) => T | undefined): readonly T[] {
  if (!Array.isArray(value)) return []
  const items: T[] = []
  for (const item of value as readonly unknown[]) {
    const next = read(item)
    if (next !== undefined) items.push(next)
  }
  return items
}
