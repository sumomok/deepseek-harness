/**
 * Where the component entry the content column is drawing lives, read off the
 * console's own document.
 *
 * A component entry is not a frame: its blocks are drawn by the column, in the
 * console's document, inside the kind seat the column keeps mounted. So the
 * element a call is confined to is found rather than held, and it is found by
 * the two markers the column already writes: the selected switcher button
 * carries the entry's `<kind> <entryId>` key, and the wrapper of the kind in
 * front holds the entry's own root element.
 *
 * Both markers are read together on purpose. The column draws one entry of one
 * kind at a time, and the pair is what says which entry that is: the seat
 * wrapper alone survives a switch of entries, and the switcher key alone
 * survives a switch to another kind. A call that acts therefore refuses when
 * the entry it names is not the one in front, rather than acting on whatever
 * took its place.
 *
 * The kind key is spelled here, like the page seat spells its own slot key,
 * because the column's key domain is open and this module is the one place that
 * says which kind it serves.
 * @module @deepseek-ai/dsh-experimental-component-surface/client/entry-container
 */

/** The kind of content column entry this package draws: the key `show_component` places its blocks under. */
export const COMPONENT_KIND = 'component'

/** The selected entry's switcher button, which carries that entry's `<kind> <entryId>` key. */
const SELECTED_TAB = '[data-content-surface-entry][data-content-surface-selected]'

/** The wrapper the column mounts one kind's seat in, marked active for the kind in front. */
const ACTIVE_SEAT = `[data-content-surface-seat="${COMPONENT_KIND}"][data-content-surface-active]`

/** The element a component seat draws one entry in. */
const ENTRY_ROOT = '[data-component-surface]'

/** One component entry the column is drawing, and the element its blocks are drawn in. */
export interface DrawnEntry {
  /** The entry's id within its kind. */
  readonly entryId: string
  /** The title the column shows for it, as its switcher button reads. */
  readonly title: string
  /** The element the entry's blocks are drawn in; nothing outside it is acted on. */
  readonly container: Element
}

/**
 * The component entry the column is drawing now.
 *
 * A kind seat keeps its wrapper while another kind is in front, and a wrapper
 * with no entry drawn in it is not an entry this package can act on, so the
 * wrapper has to be the active one and to hold the entry's root. The switcher
 * key is read with the same question in mind: the column selects one entry at a
 * time, and a selected entry of another kind means no component entry is in
 * front.
 * @param root - the document the console's content column is drawn in.
 * @returns the drawn entry and its container, or undefined when no component entry is in front.
 */
export function drawnEntry(root: ParentNode): DrawnEntry | undefined {
  const tab = root.querySelector(SELECTED_TAB)
  const key = tab?.getAttribute('data-content-surface-entry')
  if (key === undefined || key === null) return undefined
  // `<kind> <entryId>`: the kind is a token, so the first space ends it and
  // everything after it is the id, spaces and all.
  const at = key.indexOf(' ')
  if (at === -1 || key.slice(0, at) !== COMPONENT_KIND) return undefined
  const container = root.querySelector(`${ACTIVE_SEAT} ${ENTRY_ROOT}`)
  if (container === null) return undefined
  return { entryId: key.slice(at + 1), title: (tab?.textContent ?? '').trim(), container }
}
