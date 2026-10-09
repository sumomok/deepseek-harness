/**
 * A console document as the content column and the sidebar draw it, the parts
 * a point reads: the switcher with its selected entry, the component seat with
 * the blocks of a view, the page seat with a content-frame page, and the
 * sidebar's navigation entries.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * One page of point-anchor's naming corpus, as the vendored package installs it.
 * @param name - the page's file name without `.html`.
 * @returns its HTML.
 */
export function corpusPage(name: string): string {
  const root = dirname(createRequire(import.meta.url).resolve('@haoran/dsh-point-anchor/package.json'))
  return readFileSync(join(root, 'fixtures', 'naming', `${name}.html`), 'utf8')
}

/** What {@link mountConsole} draws in the component seat: the blocks of one view, as the component rows draw them. */
export const VIEW_BLOCKS = `
  <section data-component-block="el.metric" data-component-node="rate"><div data-probe="metric">完成率 72%</div></section>
  <section data-component-block="toy.info-card" data-component-node="card"><h3 data-probe="card-title">张三的道路</h3></section>
  <section data-component-block="custom.chart" data-component-node="chart"><canvas data-probe="chart"></canvas></section>
  <p data-probe="seat-notice">没有块的说明</p>`

/**
 * Draw the console: the sidebar, the switcher with a component view selected,
 * and the seats.
 * @param doc - the document.
 */
export function mountConsole(doc: Document): void {
  doc.body.innerHTML = `
    <aside data-server-sidebar>
      <section data-server-sidebar-section="nav"><ul>
        <li><button type="button" data-server-sidebar-nav-kind="view" data-server-sidebar-nav-entry="space-layer-rate" data-probe="nav">图层完成率</button></li>
      </ul></section>
    </aside>
    <div data-content-surface>
      <nav data-content-surface-switcher>
        <div><button type="button" data-content-surface-entry="component layers" data-content-surface-selected><span>图层配置</span></button></div>
      </nav>
      <div>
        <div data-content-surface-seat="page"><div data-content-column></div></div>
        <div data-content-surface-seat="component" data-content-surface-active><div data-component-surface>${VIEW_BLOCKS}</div></div>
        <div data-content-surface-seat="office"><p data-probe="office">文档</p></div>
      </div>
    </div>
    <div class="chat"><button type="button" data-probe="send">发送</button><button type="button" data-content-point-button data-probe="point">指一下</button></div>`
}

/**
 * Show an original-system page: the switcher's `page orders` entry selected,
 * the page seat active, and its content-frame iframe holding a body.
 * @param doc - the console document, as {@link mountConsole} drew it.
 * @param body - the page's body.
 * @returns the frame's document.
 */
export function showFramePage(doc: Document, body: string): Document {
  doc.querySelector('[data-content-surface-selected]')?.removeAttribute('data-content-surface-selected')
  doc.querySelector('[data-content-surface-active]')?.removeAttribute('data-content-surface-active')
  const switcher = doc.querySelector('[data-content-surface-switcher] > div') as Element
  switcher.insertAdjacentHTML('beforeend', '<button type="button" data-content-surface-entry="page orders" data-content-surface-selected><span>订单</span></button>')
  const seat = doc.querySelector('[data-content-surface-seat="page"]') as Element
  seat.setAttribute('data-content-surface-active', '')
  seat.innerHTML = '<iframe data-content-frame data-content-frame-id="page orders" data-content-active data-probe="frame"></iframe>'
  const inner = (seat.querySelector('iframe') as HTMLIFrameElement).contentDocument as Document
  inner.body.innerHTML = body
  return inner
}

/**
 * One probe of the console.
 * @param doc - the document.
 * @param name - the probe's `data-probe`.
 * @returns the element.
 */
export function probe(doc: Document, name: string): Element {
  const el = doc.querySelector(`[data-probe="${name}"]`)
  if (el === null) throw new Error(`console fixture: no probe ${name}`)
  return el
}

/**
 * The implementation object jsdom keeps behind one of its wrappers, under the
 * wrapper's symbol described `impl`.
 * @param wrapper - an event or an event target.
 * @returns the implementation object.
 */
function implOf(wrapper: object): Record<string, unknown> {
  const symbol = Object.getOwnPropertySymbols(wrapper).find(candidate => candidate.description === 'impl')
  const impl: unknown = symbol === undefined ? undefined : Reflect.get(wrapper, symbol)
  if (typeof impl !== 'object' || impl === null) throw new Error('console fixture: this jsdom keeps no implementation behind its wrappers')
  return impl as Record<string, unknown>
}

/**
 * Click an element as a real press does: trusted. The picker takes a pick only
 * on a trusted click and `dispatchEvent` marks every event untrusted, so this
 * sets the event's flag and runs jsdom's own dispatch.
 * @param target - the element.
 */
export function clickTrusted(target: Element, at: Pick<MouseEventInit, 'clientX' | 'clientY'> = {}): void {
  const view = target.ownerDocument.defaultView as Window & typeof globalThis
  const event = new view.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, ...at })
  const eventImpl = implOf(event)
  const dispatch = implOf(target)['_dispatch']
  if (typeof dispatch !== 'function') throw new Error('console fixture: this jsdom dispatches no other way')
  eventImpl['isTrusted'] = true
  Reflect.apply(dispatch, implOf(target), [eventImpl])
}
