/**
 * `ctx.componentViews`: the index the sidebar is built from, and the two ways a
 * view gets into it.
 *
 * The deployment's own views and a contributed source's are judged by one pass,
 * and what these cases pin is what only this registry decides: that a
 * contributed view the catalog refuses is dropped rather than failing the
 * console, that the first claim on an id wins, and that both an id collision and
 * a refusal reach a log an operator can read.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context, Logger } from '@deepseek-ai/cordis'
import { ComponentCatalogRegistry } from '../src/catalog.ts'
import { ComponentViewRegistry, type ComponentViewSource } from '../src/component-views.ts'
import { COMPONENT_KIT_ENTRIES } from '../src/component-call.ts'
import type { ContributedView } from '../src/views.ts'
import { KIT_SOURCE } from './kit-catalog.client.ts'

const contexts: Context[] = []
let errorLog: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  errorLog = []
})

/** One drawable view: a record block with one row. */
function record(id: string, title: string, display: unknown = 'A-1'): ContributedView {
  return { id, title, spec: { nodes: [{ id: 'facts', component: 'toy.record', props: { dataList: [{ label: '编号', display }] } }] } }
}

/** A registry over a catalog the caller fills, with the row's error lines captured. */
function bench(views: ContributedView[] = []): Context {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.logger.exporter({
    export: (message) => {
      if (message.type === 'error') errorLog.push(Logger.format({ export() {} }, message))
    },
  })
  new ComponentCatalogRegistry(ctx, { withheld: [] })
  new ComponentViewRegistry(ctx, { views })
  return ctx
}

/** Register the component row's six components, which is what makes any view judgeable. */
function fillCatalog(ctx: Context): () => void {
  return ctx.componentCatalog.register({ entries: COMPONENT_KIT_ENTRIES, source: KIT_SOURCE })
}

/** One source, as a package contributing views hands it over. */
function source(owner: string, views: ContributedView[]): ComponentViewSource {
  return { owner, views }
}

describe('the view index', () => {
  it('holds nothing while no component is registered, whatever is offered', () => {
    const ctx = bench([record('overview', '概览')])
    ctx.componentViews.register(source('@acme/pack-views', [record('layers', '图层')]))
    expect([...ctx.componentViews.index.keys()]).toEqual([])
  })

  it('offers the deployment\'s own views first, then each source in registration order', () => {
    const ctx = bench([record('overview', '概览')])
    fillCatalog(ctx)
    ctx.componentViews.register(source('@acme/pack-views', [record('layers', '图层'), record('alerts', '告警')]))
    ctx.componentViews.register(source('@acme/more-views', [record('sites', '站点')]))
    expect([...ctx.componentViews.index.keys()]).toEqual(['overview', 'layers', 'alerts', 'sites'])
    expect(ctx.componentViews.index.get('layers')).toEqual({
      id: 'layers',
      title: '图层',
      spec: { nodes: [{ id: 'facts', component: 'toy.record', props: { dataList: [{ label: '编号', display: 'A-1' }] } }] },
    })
  })

  it('substitutes a contributed view\'s params before judging it', () => {
    const ctx = bench()
    fillCatalog(ctx)
    ctx.componentViews.register(source('@acme/pack-views', [{
      id: 'layers',
      title: '图层',
      spec: { nodes: [{ id: 'facts', component: 'toy.record', props: { dataList: [{ label: '表', display: { $param: 'meta' } }] } }] },
      params: { meta: 'sys_layer' },
    }]))
    expect(ctx.componentViews.index.get('layers')?.spec.nodes[0]?.props['dataList'])
      .toEqual([{ label: '表', display: 'sys_layer' }])
  })

  it('drops a contributed view whose params it cannot settle, naming the value', () => {
    const ctx = bench()
    fillCatalog(ctx)
    ctx.componentViews.register(source('@acme/pack-views', [{
      id: 'layers',
      title: '图层',
      spec: { nodes: [{ id: 'facts', component: 'toy.record', props: { dataList: [{ label: '表', display: { $param: 'meta' } }] } }] },
      params: {},
    }]))
    expect([...ctx.componentViews.index.keys()]).toEqual([])
    expect(errorLog.join('\n')).toContain('spec.nodes[0].props.dataList[0].display — names the parameter "meta"')
  })

  it('drops a contributed view the catalog refuses, and says so at error level', () => {
    // A view a source offers is somebody else's file: failing the console over
    // it would let an installed file take the deployment down, and take the
    // component contribution that completed the catalog down with it.
    const ctx = bench()
    fillCatalog(ctx)
    ctx.componentViews.register(source('@acme/pack-views', [
      { id: 'chart', title: '图表', spec: { nodes: [{ id: 'x', component: 'toy.chart', props: {} }] } },
      record('layers', '图层'),
    ]))
    expect([...ctx.componentViews.index.keys()]).toEqual(['layers'])
    expect(errorLog.join('\n')).toContain('@acme/pack-views\'s view "chart" cannot be drawn: spec.nodes[0].component — names no component')
  })

  it('refuses a contributed view whose id the deployment already offers, naming both', () => {
    const ctx = bench([record('overview', '概览')])
    fillCatalog(ctx)
    ctx.componentViews.register(source('@acme/pack-views', [record('overview', '别的概览')]))
    expect(ctx.componentViews.index.get('overview')?.title).toBe('概览')
    expect(errorLog.join('\n')).toContain('@acme/pack-views offers the view "overview", which cordis.yml already offers')
  })

  it('refuses the later of two sources claiming one id, naming the one that holds it', () => {
    const ctx = bench()
    fillCatalog(ctx)
    // Three sources, so the search for the holder passes one that does not hold
    // the id before it reaches the one that does.
    ctx.componentViews.register(source('@acme/other-views', [record('sites', '站点')]))
    ctx.componentViews.register(source('@acme/pack-views', [record('layers', '图层')]))
    ctx.componentViews.register(source('@acme/more-views', [record('layers', '另一个图层')]))
    expect(ctx.componentViews.index.get('layers')?.title).toBe('图层')
    expect(errorLog.join('\n')).toContain('@acme/more-views offers the view "layers", which @acme/pack-views already offers')
  })

  it('says a report once, and again only when it changes', () => {
    const ctx = bench()
    fillCatalog(ctx)
    ctx.componentViews.register(source('@acme/pack-views', [
      { id: 'chart', title: '图表', spec: { nodes: [{ id: 'x', component: 'toy.chart', props: {} }] } },
    ]))
    const first = errorLog.length
    ctx.componentViews.register(source('@acme/more-views', [record('layers', '图层')]))
    expect(errorLog.length).toBe(first)
  })

  it('withdraws a source\'s views with the fiber that registered them', async () => {
    const ctx = bench()
    fillCatalog(ctx)
    const fiber = ctx.plugin({
      inject: ['componentViews'],
      apply: (child: Context) => { child.componentViews.register(source('@acme/pack-views', [record('layers', '图层')])) },
    })
    await fiber.await()
    expect([...ctx.componentViews.index.keys()]).toEqual(['layers'])
    await fiber.dispose()
    expect([...ctx.componentViews.index.keys()]).toEqual([])
  })

  it('stops telling a watcher that gives its own subscription up', () => {
    const ctx = bench()
    let changes = 0
    const stop = ctx.componentViews.onChange(() => { changes += 1 })
    fillCatalog(ctx)
    expect(changes).toBe(1)
    stop()
    ctx.componentViews.register(source('@acme/pack-views', [record('layers', '图层')]))
    expect(changes).toBe(1)
  })

  it('tells a watcher whenever the index moves, and stops when its fiber goes', async () => {
    const ctx = bench()
    let changes = 0
    const fiber = ctx.plugin({
      inject: ['componentViews'],
      apply: (child: Context) => { child.componentViews.onChange(() => { changes += 1 }) },
    })
    await fiber.await()
    fillCatalog(ctx)
    const withdraw = ctx.componentViews.register(source('@acme/pack-views', [record('layers', '图层')]))
    expect(changes).toBeGreaterThanOrEqual(2)
    const seen = changes
    await fiber.dispose()
    withdraw()
    expect(changes).toBe(seen)
  })

  it('names the ids the deployment\'s own configuration claims', () => {
    const ctx = bench([record('overview', '概览'), record('alerts', '告警')])
    expect(ctx.componentViews.configuredIds).toEqual(['overview', 'alerts'])
  })

  it('judges one view against the catalog as it stands, without registering it', () => {
    const ctx = bench()
    const judgedEmpty = ctx.componentViews.judge(record('layers', '图层'))
    expect(judgedEmpty.ok).toBe(false)
    fillCatalog(ctx)
    const judged = ctx.componentViews.judge(record('layers', '图层'))
    expect(judged.ok).toBe(true)
    expect([...ctx.componentViews.index.keys()]).toEqual([])
  })

  it('fails the row when the deployment\'s own view is one the tool would refuse', () => {
    const ctx = bench([{ id: 'chart', title: '图表', spec: { nodes: [{ id: 'x', component: 'toy.chart', props: {} }] } }])
    // The refusal travels back to the contribution that completed the catalog,
    // which is what withdraws it; the line an operator reads is logged here.
    expect(() => fillCatalog(ctx)).toThrow('component-surface: views[0] "chart" — spec.nodes[0].component — names no component')
    expect(errorLog.join('\n')).toContain('this deployment comes up with no components, no views and no show_component tool')
  })
})
