/**
 * What the specs drawing a vendored crud kit component reach for around it:
 * the component instance under a drawn block, and the console's content column
 * an entry is drawn into.
 */
import type { VueInstance } from '../../src/client/vue-shim.ts'

/**
 * The vendored component of one name under a drawn block.
 * @param container - the drawn block.
 * @param name - the component's own name, `ToyDataPage`, `ToyFormPage` or `ToyInfoCard`.
 * @returns the instance.
 */
export function instanceOf(container: HTMLElement, name: string): VueInstance {
  const box = container.querySelector('[data-toy-crud-box]') as HTMLElement
  const rootEl = box.firstElementChild?.firstElementChild as HTMLElement & { __vue__?: VueInstance }
  let instance = rootEl.__vue__ as VueInstance
  while (instance.$options.name !== name) instance = instance.$children[0] as VueInstance
  return instance
}

/**
 * Draw the console's content column with one component entry in front, the way
 * the act tool finds an entry.
 * @returns the entry's own container, which every step is confined to.
 */
export function entrySeat(): HTMLElement {
  document.body.innerHTML = `
    <nav data-content-surface-switcher>
      <button data-content-surface-entry="component demo" data-content-surface-selected>Demo</button>
    </nav>
    <div data-content-surface-seat="component" data-content-surface-active></div>
  `
  const seat = document.querySelector('[data-content-surface-seat="component"][data-content-surface-active]') as HTMLElement
  const entry = document.createElement('div')
  entry.setAttribute('data-component-surface', '')
  seat.appendChild(entry)
  return entry
}
