/**
 * Where the component entry the content column is drawing lives, read off the
 * console's own document.
 *
 * A component entry is drawn by the column in the console's document, inside
 * the kind seat the column keeps mounted, so the element a call is confined to
 * is found by two markers the column writes: the selected switcher button
 * carries the entry's `<kind> <entryId>` key, and the active seat wrapper holds
 * the entry's root element. Both are required: the wrapper alone survives a
 * switch of entries, and the switcher key alone survives a switch of kinds.
 * @module @deepseek-ai/dsh-experimental-component-surface/client/entry-container
 */

/** The kind of content column entry this package draws: the key `show_component` places its blocks under. */
export const COMPONENT_KIND = 'component'

/** The selected entry's switcher button, which carries that entry's `<kind> <entryId>` key. */
const SELECTED_TAB = '[data-content-surface-selected]'

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
 * The component entry the column is drawing now: the selected switcher key
 * must name a component entry, and the active seat must hold an entry root.
 * @param root - the document the console's content column is drawn in.
 * @returns the drawn entry and its container, or undefined when no component entry is in front.
 */
export function drawnEntry(root: ParentNode): DrawnEntry | undefined {
  const tab = root.querySelector(SELECTED_TAB)
  if (tab === null) return undefined
  const key = tab.getAttribute('data-content-surface-entry')
  if (key === null) return undefined
  // `<kind> <entryId>`: the kind is a token, so the first space ends it and
  // everything after it is the id, spaces and all.
  const at = key.indexOf(' ')
  if (at === -1 || key.slice(0, at) !== COMPONENT_KIND) return undefined
  const container = root.querySelector(`${ACTIVE_SEAT} ${ENTRY_ROOT}`)
  if (container === null) return undefined
  return { entryId: key.slice(at + 1), title: tab.textContent.trim(), container }
}
