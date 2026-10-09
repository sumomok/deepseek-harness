// @vitest-environment jsdom
/**
 * One point and what it files: a place point-anchor describes becomes its
 * description without a DataPage row or an original-system page's record text;
 * a place it refuses as a component it does not describe, as nothing named on
 * an original-system page, or as a frame this page may not read, inside a seat
 * of the content column, becomes the whole block around the click — the
 * component view's block, the original-system page, else the seat — named by
 * structure alone; every other refusal stays one, and a cancelled pick files
 * nothing. A trusted click on the 「指一下」 button cancels a pick, and every
 * listener a point adds is gone once it ends.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANCHOR_FORMAT, DESCRIBE_FORMAT } from '@haoran/dsh-point-anchor'
import type { DescribeRefusal, PointDescription } from '@haoran/dsh-point-anchor'
import { describeElement } from '@haoran/dsh-point-anchor/page'
import type { PickOutcome } from '@haoran/dsh-point-anchor/page'
import { blockAt, BLOCK_REASONS, FRAME_BLOCK_REASONS, point, pointOutcome } from '../src/client/pick.ts'
import type { PointNames, PointOutcome } from '../src/client/pick.ts'
import { withPointNotices } from '../src/notice.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { clickTrusted, corpusPage, mountConsole, probe, showFramePage } from './console-fixture.client.ts'

const NAMES: PointNames = {
  component: component => (component === undefined ? '组件' : `名:${component}`),
  seat: seat => `座:${seat}`,
  role: role => `R:${role}`,
  cellControl: (column, role) => `${column}列的${role}`,
  tableItem: role => `表里的${role}`,
}

/** A DataPage cell with the row point-anchor writes for a reference. */
const CELL: PointDescription = {
  v: DESCRIBE_FORMAT,
  anchorFormat: ANCHOR_FORMAT,
  what: { kind: 'data-page', region: 'table', part: 'cell' },
  anchor: { kind: 'data-page', model: 'SpaceLayer', region: 'table', part: 'cell', column: 'zh_label' },
  shown: { page: '图层配置', target: '名称' },
  row: { zh_label: '燃气管线', belong_map_topic: '公用专题' },
  rowOmitted: 3,
}

/** Every record value the corpus's row-values page draws: names, titles, states, numbers, phone and address. */
const RECORD_VALUES = [
  '张三的道路工程', '启用', '张三', '李四', '钱七', '王五', '早班', '13800000000', '北京', 'VIP', '五十七', '73', '千克', '东风站', 'SP-001', 'SP-003',
]

/**
 * A refused pick.
 * @param reason - the refusal.
 * @returns the outcome.
 */
const refused = (reason: DescribeRefusal): PickOutcome => ({ kind: 'refused', reason })

/** The windows {@link watchListeners} replaced the listener methods of, with the methods it replaced. */
const overridden: { view: Window; add: Window['addEventListener']; remove: Window['removeEventListener'] }[] = []

afterEach(() => {
  for (const { view, add, remove } of overridden.splice(0)) Object.assign(view, { addEventListener: add, removeEventListener: remove })
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('a place point-anchor describes', () => {
  it('is filed without its row and the count of columns left out of it', () => {
    const outcome = pointOutcome({ kind: 'picked', point: CELL, element: document.body, warnings: [] }, undefined, NAMES)
    expect(outcome).toEqual({
      kind: 'reference',
      label: '「名称」这一格',
      data: { v: 1, anchorFormat: 1, what: CELL.what, anchor: CELL.anchor, shown: CELL.shown },
    })
    expect(JSON.stringify(outcome)).not.toContain('燃气管线')
  })

  it('is labelled in the words given', () => {
    const outcome = pointOutcome({ kind: 'picked', point: CELL, element: document.body, warnings: [] }, undefined, NAMES, { cell: column => `"${column}" cell` })
    expect(outcome.kind === 'reference' && outcome.label).toBe('"名称" cell')
  })

  it('keeps why a place has no anchor', () => {
    const unanchored: PointDescription = { v: CELL.v, anchorFormat: CELL.anchorFormat, what: CELL.what, unanchored: 'no-column', shown: CELL.shown }
    const outcome = pointOutcome({ kind: 'picked', point: unanchored, element: document.body, warnings: [] }, undefined, NAMES)
    expect(outcome.kind === 'reference' && outcome.data).toMatchObject({ unanchored: 'no-column' })
  })

  it('is held to 8192 bytes of data, dropping an anchor whose key line would not fit', () => {
    const mark = Array.from({ length: 1800 }, (_, index) => `c${String(index)}`).join(' ')
    const long: PointDescription = {
      v: DESCRIBE_FORMAT,
      anchorFormat: ANCHOR_FORMAT,
      what: { kind: 'frame', role: 'button' },
      anchor: { kind: 'frame', page: 'orders', role: 'button', mark, in: 'main' },
      shown: { page: '订单' },
    }
    const outcome = pointOutcome({ kind: 'picked', point: long, element: document.body, warnings: [] }, undefined, NAMES)
    const data = outcome.kind === 'reference' ? outcome.data : {}
    expect(new TextEncoder().encode(JSON.stringify(data)).byteLength).toBeLessThanOrEqual(8192)
    expect(data).toMatchObject({ unanchored: 'too-large' })
  })

  it('is refused as too large when no form of it fits the bound', () => {
    const bare: PointDescription = {
      v: CELL.v, anchorFormat: CELL.anchorFormat, what: CELL.what,
      anchor: { kind: 'data-page', model: 'SpaceLayer', region: 'table', part: 'cell', column: 'zh_label' },
      shown: { page: '页'.repeat(9000) },
    }
    expect(pointOutcome({ kind: 'picked', point: bare, element: document.body, warnings: [] }, undefined, NAMES)).toEqual({ kind: 'refused', reason: 'too-large' })
  })
})

describe('an original-system page\'s table, described for a reference', () => {
  it('files no record value in any label, payload or model text, and names a control in a cell by its column', () => {
    mountConsole(document)
    const inner = showFramePage(document, corpusPage('row-values'))
    const env = { isVisible: (el: Element) => el.closest('[data-hidden]') === null, isClickable: (el: Element) => el.closest('[data-pointer]') !== null }
    const filed: Extract<PointOutcome, { kind: 'reference' }>[] = []
    for (const target of inner.querySelectorAll('[data-probe]')) {
      const described = describeElement(target, { ...env, purpose: 'reference' })
      if (!described.ok) continue
      const outcome = pointOutcome({ kind: 'picked', point: described.point, element: target, warnings: [] }, undefined, NAMES)
      if (outcome.kind === 'reference') filed.push(outcome)
    }
    expect(filed.length).toBeGreaterThan(30)
    const button = filed.find(outcome => outcome.label === '名称列的R:button')
    expect(button?.data).toEqual({
      v: 1, anchorFormat: 1, what: { kind: 'frame', role: 'button' },
      anchor: { kind: 'frame', page: 'orders', column: '名称', role: 'button', in: 'main' },
      shown: { page: '订单', target: '名称' },
    })
    // The whole chain: the prompt carrying the references and the notice the host appends after it, as the log records both.
    const logged: unknown[] = []
    for (let at = 0; at < filed.length; at += 16) {
      const references = filed.slice(at, at + 16).map(outcome => ({ source: 'content-point', label: outcome.label, data: outcome.data }))
      const message = createUserMessage({ content: [{ type: 'text', text: '这些是什么' }], source: { kind: 'user', references } as never })
      logged.push(...withPointNotices([message]))
    }
    expect(logged.length).toBe(2 * Math.ceil(filed.length / 16))
    // Message ids are random and may hold any digits; everything else in the log is checked.
    const log = JSON.stringify(logged, (key, value: unknown) => (key === 'id' || key === 'message' ? undefined : value))
    for (const value of RECORD_VALUES) expect(log, value).not.toContain(value)
    expect(log).toContain('「名称」列里的按钮')
  })
})

describe('a place point-anchor refuses', () => {
  it.each([...BLOCK_REASONS])('as %s inside a block of the component view becomes that block', (reason) => {
    mountConsole(document)
    const outcome = pointOutcome(refused(reason), { element: probe(document, 'card-title') }, NAMES)
    expect(outcome).toEqual({
      kind: 'reference',
      label: '名:toy.info-card',
      data: { v: 1, kind: 'block', seat: 'component', component: 'toy.info-card', node: 'card', shown: { page: '图层配置', target: '名:toy.info-card' } },
    })
    expect(JSON.stringify(outcome)).not.toContain('张三的道路')
  })

  it.each([...FRAME_BLOCK_REASONS])('as %s on an original-system page becomes the whole page, by its page id', (reason) => {
    mountConsole(document)
    const inner = showFramePage(document, '<p data-probe="inner">张三</p>')
    const outcome = pointOutcome(refused(reason), { element: inner.querySelector('[data-probe="inner"]') as Element }, NAMES)
    expect(outcome).toEqual({
      kind: 'reference',
      label: '座:page',
      data: { v: 1, kind: 'block', seat: 'page', page: 'orders', shown: { page: '订单', target: '座:page' } },
    })
  })

  it('on a cross-origin frame\'s shield becomes the page under the pointer', () => {
    mountConsole(document)
    showFramePage(document, '')
    const shield = document.createElement('div')
    document.body.append(shield)
    const under = vi.fn((x: number, y: number) => (x === 40 && y === 50 ? [shield, probe(document, 'frame')] : []))
    Object.defineProperty(document, 'elementsFromPoint', { value: under, configurable: true })
    expect(pointOutcome(refused('unreadable-frame'), { element: shield, x: 40, y: 50 }, NAMES)).toMatchObject({ kind: 'reference', data: { seat: 'page', page: 'orders' } })
    expect(pointOutcome(refused('unreadable-frame'), { element: shield, x: 1, y: 1 }, NAMES)).toEqual({ kind: 'refused', reason: 'unreadable-frame' })
    expect(pointOutcome(refused('unreadable-frame'), { element: shield }, NAMES)).toEqual({ kind: 'refused', reason: 'unreadable-frame' })
    Reflect.deleteProperty(document, 'elementsFromPoint')
  })

  it('on a shield in a document that places nothing stays refused', () => {
    mountConsole(document)
    const shield = document.createElement('div')
    document.body.append(shield)
    expect(pointOutcome(refused('unreadable-frame'), { element: shield, x: 1, y: 1 }, NAMES)).toEqual({ kind: 'refused', reason: 'unreadable-frame' })
  })

  it('inside a seat but outside every block becomes the seat', () => {
    mountConsole(document)
    expect(blockAt(probe(document, 'seat-notice'), NAMES)).toEqual({ v: 1, kind: 'block', seat: 'component', shown: { page: '图层配置', target: '座:component' } })
    expect(blockAt(probe(document, 'office'), NAMES)).toEqual({ v: 1, kind: 'block', seat: 'office', shown: { page: '图层配置', target: '座:office' } })
  })

  it('inside the page seat with no frame takes the selected page entry\'s id, and none for another kind of entry', () => {
    mountConsole(document)
    showFramePage(document, '')
    const seat = document.querySelector('[data-content-surface-seat="page"]') as Element
    seat.innerHTML = '<p data-probe="loose">x</p>'
    expect(blockAt(probe(document, 'loose'), NAMES)).toMatchObject({ seat: 'page', page: 'orders' })
    document.querySelector('[data-content-surface-entry="page orders"]')?.setAttribute('data-content-surface-entry', 'component orders')
    expect(blockAt(probe(document, 'loose'), NAMES)).not.toHaveProperty('page')
  })

  it('takes an element around the seat that carries a node id for no block of it', () => {
    mountConsole(document)
    const seat = document.querySelector('[data-content-surface-seat="office"]') as Element
    seat.innerHTML = '<p data-probe="inner">x</p>'
    seat.parentElement?.setAttribute('data-component-node', 'outer')
    expect(blockAt(probe(document, 'inner'), NAMES)).toMatchObject({ seat: 'office' })
    expect(blockAt(probe(document, 'inner'), NAMES)).not.toHaveProperty('node')
  })

  it('shows no page when no switcher entry is selected', () => {
    mountConsole(document)
    document.querySelector('[data-content-surface-selected]')?.removeAttribute('data-content-surface-selected')
    expect(blockAt(probe(document, 'metric'), NAMES)).toEqual({ v: 1, kind: 'block', seat: 'component', component: 'el.metric', node: 'rate', shown: { target: '名:el.metric' } })
  })

  it('stays refused outside every seat, for any other reason, and with no click seen', () => {
    mountConsole(document)
    expect(pointOutcome(refused('unsupported-component'), { element: probe(document, 'send') }, NAMES)).toEqual({ kind: 'refused', reason: 'unsupported-component' })
    expect(pointOutcome(refused('popup'), { element: probe(document, 'metric') }, NAMES)).toEqual({ kind: 'refused', reason: 'popup' })
    expect(pointOutcome(refused('unsupported-component'), undefined, NAMES)).toEqual({ kind: 'refused', reason: 'unsupported-component' })
  })
})

/**
 * Record every click listener added to and removed from a window with the
 * capture flag `true`, the form the point adds its own in.
 * @param view - the window.
 * @returns the listeners added and those removed.
 */
function watchListeners(view: Window): { added: unknown[]; removed: unknown[] } {
  const added: unknown[] = []
  const removed: unknown[] = []
  const add = view.addEventListener.bind(view)
  const remove = view.removeEventListener.bind(view)
  const original = { view, add, remove }
  const adding = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void => {
    if (type === 'click' && options === true) added.push(listener)
    add(type, listener, options)
  }
  const removing = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void => {
    if (type === 'click' && options === true) removed.push(listener)
    remove(type, listener, options)
  }
  // afterEach puts the window's own methods back.
  Object.assign(view, { addEventListener: adding, removeEventListener: removing })
  overridden.push(original)
  return { added, removed }
}

describe('a pick', () => {
  it('that is cancelled files nothing', () => {
    expect(pointOutcome({ kind: 'cancelled' }, undefined, NAMES)).toEqual({ kind: 'cancelled' })
  })

  it('on a block of the component view files the block, the click it was taken on read by the point\'s own listener', async () => {
    mountConsole(document)
    const pending = point(document, { names: NAMES, refusalWords: { 'unsupported-component': '指这一整块' } })
    clickTrusted(probe(document, 'chart'))
    expect(await pending).toEqual({
      kind: 'reference',
      label: '名:custom.chart',
      data: { v: 1, kind: 'block', seat: 'component', component: 'custom.chart', node: 'chart', shown: { page: '图层配置', target: '名:custom.chart' } },
    })
  })

  it('names the block of the trusted click, not of a page script\'s click after it', async () => {
    mountConsole(document)
    const pending = point(document, { names: NAMES })
    clickTrusted(probe(document, 'chart'))
    probe(document, 'card-title').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const outcome = await pending
    expect(outcome.kind === 'reference' && outcome.data).toMatchObject({ component: 'custom.chart', node: 'chart' })
  })

  it('on a sidebar entry files its description', async () => {
    mountConsole(document)
    const pending = point(document, { names: NAMES, words: {} })
    clickTrusted(probe(document, 'nav'))
    const outcome = await pending
    expect(outcome.kind === 'reference' && outcome.data).toMatchObject({ anchor: { kind: 'nav', nav: 'view', id: 'space-layer-rate' } })
  })

  it('in an original-system page\'s table files a place the reader names no column for as a reference without an anchor', async () => {
    mountConsole(document)
    const inner = showFramePage(document, corpusPage('row-values'))
    const pending = point(document, { names: NAMES })
    clickTrusted(inner.querySelector('[data-probe="desc-phone"]') as Element)
    const outcome = await pending
    expect(outcome).toEqual({
      kind: 'reference',
      label: '表里的R:link',
      data: { v: 1, anchorFormat: 1, what: { kind: 'frame', role: 'link' }, unanchored: 'no-column', shown: { page: '订单' } },
    })
  })

  it('in an original-system page\'s table files a control by its column, the click heard in the frame', async () => {
    mountConsole(document)
    const inner = showFramePage(document, corpusPage('row-values'))
    const pending = point(document, { names: NAMES })
    clickTrusted(inner.querySelector('[data-probe="title-button"]') as Element)
    const outcome = await pending
    expect(outcome.kind === 'reference' && outcome.label).toBe('名称列的R:button')
    expect(JSON.stringify(outcome)).not.toContain('张三的道路工程')
  })

  it('ends as cancelled on a trusted click on the 「指一下」 button', async () => {
    mountConsole(document)
    const pending = point(document, { names: NAMES })
    clickTrusted(probe(document, 'point'))
    expect(await pending).toEqual({ kind: 'cancelled' })
  })

  it('ends as cancelled when its signal is aborted, before or during the pick', async () => {
    mountConsole(document)
    const controller = new AbortController()
    const pending = point(document, { names: NAMES, signal: controller.signal })
    controller.abort()
    expect(await pending).toEqual({ kind: 'cancelled' })
    expect(await point(document, { names: NAMES, signal: AbortSignal.abort() })).toEqual({ kind: 'cancelled' })
  })

  it.each([
    ['picked', 'nav'],
    ['refused', 'send'],
    ['cancelled', 'point'],
  ])('removes every click listener it added, from the console and each frame window, once it has %s', async (_ending, name) => {
    mountConsole(document)
    const inner = showFramePage(document, '<p>x</p>')
    const outer = watchListeners(window)
    const framed = watchListeners(inner.defaultView as Window)
    const pending = point(document, { names: NAMES })
    expect(outer.added).toHaveLength(1)
    expect(framed.added).toHaveLength(1)
    clickTrusted(probe(document, name))
    await pending
    expect(outer.removed).toEqual(outer.added)
    expect(framed.removed).toEqual(framed.added)
  })

  it('listens on no window of a document without one, nor in a frame it cannot reach', async () => {
    const bare = document.implementation.createHTMLDocument('')
    mountConsole(bare)
    bare.body.append(bare.createElement('iframe'))
    expect(await point(bare, { names: NAMES, signal: AbortSignal.abort() })).toEqual({ kind: 'cancelled' })
  })
})
