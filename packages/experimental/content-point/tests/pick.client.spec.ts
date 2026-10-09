// @vitest-environment jsdom
/**
 * One point and what it files: a place point-anchor describes becomes its
 * description without the DataPage row; a place it refuses as a component it
 * does not describe, inside a seat of the content column, becomes the whole
 * block around the click — the component view's block, else the seat — named
 * by structure alone; every other refusal stays one, and a cancelled pick files
 * nothing.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { ANCHOR_FORMAT, DESCRIBE_FORMAT } from '@haoran/dsh-point-anchor'
import type { PointDescription } from '@haoran/dsh-point-anchor'
import type { PickOutcome } from '@haoran/dsh-point-anchor/page'
import { blockAt, BLOCK_REASONS, point, pointOutcome, withoutRow } from '../src/client/pick.ts'
import type { BlockNames } from '../src/client/pick.ts'
import { clickTrusted, mountConsole, probe } from './console-fixture.client.ts'

const NAMES: BlockNames = {
  component: component => (component === undefined ? '组件' : `名:${component}`),
  seat: seat => `座:${seat}`,
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

afterEach(() => {
  document.body.innerHTML = ''
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

  it('keeps why a place has no anchor', () => {
    const unanchored = { ...withoutRow(CELL), anchor: undefined, unanchored: 'no-column' as const }
    const outcome = pointOutcome({ kind: 'picked', point: unanchored, element: document.body, warnings: [] }, undefined, NAMES)
    expect(outcome.kind === 'reference' && outcome.data).toMatchObject({ unanchored: 'no-column' })
  })

  it('is refused as too large when no form of it fits the bound', () => {
    const huge = { ...withoutRow(CELL), shown: { page: '页'.repeat(9000) } }
    expect(pointOutcome({ kind: 'picked', point: huge, element: document.body, warnings: [] }, undefined, NAMES)).toEqual({ kind: 'refused', reason: 'too-large' })
  })
})

describe('a place point-anchor refuses', () => {
  it.each([...BLOCK_REASONS])('as %s inside a block of the component view becomes that block', (reason) => {
    mountConsole(document)
    const outcome = pointOutcome({ kind: 'refused', reason }, probe(document, 'card-title'), NAMES)
    expect(outcome).toEqual({
      kind: 'reference',
      label: '名:toy.info-card',
      data: { v: 1, kind: 'block', seat: 'component', component: 'toy.info-card', node: 'card', shown: { page: '图层配置', target: '名:toy.info-card' } },
    })
    expect(JSON.stringify(outcome)).not.toContain('张三的道路')
  })

  it('inside a seat but outside every block becomes the seat', () => {
    mountConsole(document)
    expect(blockAt(probe(document, 'seat-notice'), NAMES)).toEqual({ v: 1, kind: 'block', seat: 'component', shown: { page: '图层配置', target: '座:component' } })
    expect(blockAt(probe(document, 'office'), NAMES)).toEqual({ v: 1, kind: 'block', seat: 'office', shown: { page: '图层配置', target: '座:office' } })
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
    const refused = (reason: Extract<PickOutcome, { kind: 'refused' }>['reason'], at?: Element) => pointOutcome({ kind: 'refused', reason }, at, NAMES)
    expect(refused('unsupported-component', probe(document, 'send'))).toEqual({ kind: 'refused', reason: 'unsupported-component' })
    expect(refused('popup', probe(document, 'metric'))).toEqual({ kind: 'refused', reason: 'popup' })
    expect(refused('unsupported-component')).toEqual({ kind: 'refused', reason: 'unsupported-component' })
  })
})

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

  it('on a sidebar entry files its description', async () => {
    mountConsole(document)
    const pending = point(document, { names: NAMES, words: {} })
    clickTrusted(probe(document, 'nav'))
    const outcome = await pending
    expect(outcome.kind === 'reference' && outcome.data).toMatchObject({ anchor: { kind: 'nav', nav: 'view', id: 'space-layer-rate' } })
  })

  it('ends as cancelled when its signal is aborted, and stops listening', async () => {
    mountConsole(document)
    const controller = new AbortController()
    const pending = point(document, { names: NAMES, signal: controller.signal })
    controller.abort()
    expect(await pending).toEqual({ kind: 'cancelled' })
  })

  it('reads no click on a document without a window', async () => {
    const bare = document.implementation.createHTMLDocument('')
    mountConsole(bare)
    expect(await point(bare, { names: NAMES, signal: AbortSignal.abort() })).toEqual({ kind: 'cancelled' })
  })
})
