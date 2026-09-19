/**
 * The catalog registry: what a component plugin contributes, what happens when
 * two of them claim one id, and what the row does with a catalog that moves.
 *
 * The consequences are what matter rather than the table itself: a model is
 * offered the tool only where something can be placed with it, the description
 * it reads lists exactly the registered components, and a call naming one that
 * is not registered is refused with the ones that are.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ComponentCatalogRegistry, trackCatalog, type ComponentSource } from '../src/catalog.ts'
import {
  CONFIRM_BAR_ID,
  COMPONENT_KIT_ENTRIES,
  DATA_PAGE_ID,
  describeCatalog,
  LAYOUT_SPEC_DEPTH,
  METRIC_ID,
  readCatalog,
  SHOW_COMPONENT_TOOL_NAME,
  type ComponentCatalog,
  type ComponentCatalogEntry,
} from '../src/component-call.ts'
import * as ShowComponent from '../src/index.ts'
import { validateComponentCall } from '../src/validate.ts'
import { KIT_SOURCE } from './kit-catalog.client.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** A second contributing package, for the cases about two of them. */
const OTHER_SOURCE: ComponentSource = { package: '@acme/dsh-components', version: '2.1.0' }

/** The two of the six these cases contribute when they contribute fewer than all. */
const TWO: readonly ComponentCatalogEntry[] = COMPONENT_KIT_ENTRIES
  .filter(entry => entry.id === CONFIRM_BAR_ID || entry.id === METRIC_ID)

/** One entry of the six, for the cases about a second package claiming a claimed id. */
const ONE: readonly ComponentCatalogEntry[] = COMPONENT_KIT_ENTRIES.filter(entry => entry.id === CONFIRM_BAR_ID)

/** A registry on its own context. */
async function registry(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(ComponentCatalogRegistry).await()
  return ctx
}

/** The composed row over a tool runtime, with the catalog left empty for the caller to fill. */
async function row(config: ShowComponent.Config = {}): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ShowComponent, config)
  return ctx
}

/** The `show_component` schema this composition offers, or `undefined` while it offers none. */
function offered(ctx: Context): { name: string; description: string } | undefined {
  return ctx.tools.schemas().find(schema => schema.name === SHOW_COMPONENT_TOOL_NAME)
}

describe('the component catalog registry', () => {
  it('starts empty, so a deployment composing no component plugin offers no component', async () => {
    const ctx = await registry()
    expect(ctx.componentCatalog.catalog.entries).toEqual([])
    expect(ctx.componentCatalog.components).toEqual([])
    // The layout tree is the floor an empty catalog is still measured against.
    expect(ctx.componentCatalog.catalog.maxSpecDepth).toBe(LAYOUT_SPEC_DEPTH)
  })

  it('carries each registered component with the package that contributed it', async () => {
    const ctx = await registry()
    ctx.componentCatalog.register({ entries: TWO, source: KIT_SOURCE })
    expect(ctx.componentCatalog.components).toEqual([
      { entry: TWO[0], source: KIT_SOURCE },
      { entry: TWO[1], source: KIT_SOURCE },
    ])
  })

  it('offers the components of two packages together, in registration order', async () => {
    const ctx = await registry()
    ctx.componentCatalog.register({ entries: ONE, source: KIT_SOURCE })
    ctx.componentCatalog.register({
      entries: COMPONENT_KIT_ENTRIES.filter(entry => entry.id === METRIC_ID),
      source: OTHER_SOURCE,
    })
    expect(ctx.componentCatalog.catalog.entries.map(entry => entry.id)).toEqual([CONFIRM_BAR_ID, METRIC_ID])
  })

  it('takes a contribution back out when its disposer runs', async () => {
    const ctx = await registry()
    const dispose = ctx.componentCatalog.register({ entries: TWO, source: KIT_SOURCE })
    dispose()
    expect(ctx.componentCatalog.catalog.entries).toEqual([])
  })

  it('takes a contribution back out when the registering fiber goes (HMR safety)', async () => {
    const ctx = await registry()
    const fiber = ctx.plugin({
      inject: ['componentCatalog'],
      apply: (child: Context) => { child.componentCatalog.register({ entries: TWO, source: KIT_SOURCE }) },
    })
    await fiber.await()
    expect(ctx.componentCatalog.catalog.entries).toHaveLength(TWO.length)

    await fiber.dispose()
    expect(ctx.componentCatalog.catalog.entries).toEqual([])
  })

  it('refuses an id another package already registered, naming both packages', async () => {
    const ctx = await registry()
    ctx.componentCatalog.register({ entries: ONE, source: KIT_SOURCE })
    expect(() => ctx.componentCatalog.register({ entries: ONE, source: OTHER_SOURCE }))
      .toThrow('component-surface: @acme/dsh-components@2.1.0 registers component "el.confirm-bar", '
        + 'which @deepseek-ai/dsh-experimental-component-kit@0.0.0-test already registered')
  })

  it('refuses an id a contribution repeats within itself, and registers none of it', async () => {
    const ctx = await registry()
    expect(() => ctx.componentCatalog.register({ entries: [...ONE, ...ONE], source: OTHER_SOURCE }))
      .toThrow('component-surface: @acme/dsh-components@2.1.0 registers component "el.confirm-bar" twice in one contribution')
    expect(ctx.componentCatalog.catalog.entries).toEqual([])
  })

  it('tells watchers in registration order, and only about changes', async () => {
    const ctx = await registry()
    const seen: string[] = []
    ctx.componentCatalog.onChange(catalog => seen.push(`first:${catalog.entries.length}`))
    ctx.componentCatalog.onChange(catalog => seen.push(`second:${catalog.entries.length}`))
    // Nothing yet: a watcher hears about changes, and reads the catalog it
    // starts from itself.
    expect(seen).toEqual([])

    const dispose = ctx.componentCatalog.register({ entries: TWO, source: KIT_SOURCE })
    dispose()
    expect(seen).toEqual(['first:2', 'second:2', 'first:0', 'second:0'])
  })

  it('stops telling a watcher its disposer took out', async () => {
    const ctx = await registry()
    const seen: number[] = []
    const stop = ctx.componentCatalog.onChange(catalog => seen.push(catalog.entries.length))
    stop()
    ctx.componentCatalog.register({ entries: TWO, source: KIT_SOURCE })
    expect(seen).toEqual([])
  })

  it('stops telling a watcher whose fiber went (HMR safety)', async () => {
    const ctx = await registry()
    const seen: number[] = []
    const fiber = ctx.plugin({
      inject: ['componentCatalog'],
      apply: (child: Context) => {
        child.componentCatalog.onChange(catalog => seen.push(catalog.entries.length))
      },
    })
    await fiber.await()
    await fiber.dispose()
    ctx.componentCatalog.register({ entries: TWO, source: KIT_SOURCE })
    expect(seen).toEqual([])
  })

  it('rebuilds a tracked registration on every change, and releases it with the fiber', async () => {
    const ctx = await registry()
    const seen: number[] = []
    const released: number[] = []
    const fiber = ctx.plugin({
      inject: ['componentCatalog'],
      apply: (child: Context) => {
        trackCatalog(child, (catalog: ComponentCatalog) => {
          seen.push(catalog.entries.length)
          return () => released.push(catalog.entries.length)
        }, 'test: tracked registration')
      },
    })
    await fiber.await()
    const dispose = ctx.componentCatalog.register({ entries: TWO, source: KIT_SOURCE })
    dispose()
    await fiber.dispose()
    expect(seen).toEqual([0, TWO.length, 0])
    expect(released).toEqual([0, TWO.length, 0])
  })

  it('takes a contribution back out again when a reader refuses the catalog it makes', async () => {
    const ctx = await registry()
    const fiber = ctx.plugin({
      inject: ['componentCatalog'],
      apply: (child: Context) => {
        trackCatalog(child, (catalog: ComponentCatalog) => {
          if (catalog.entries.length > 0) throw new Error('this reader refuses it')
          return undefined
        }, 'test: a reader that refuses')
      },
    })
    await fiber.await()
    expect(() => ctx.componentCatalog.register({ entries: TWO, source: KIT_SOURCE })).toThrow('this reader refuses it')
    // The contributing row is told, and the deployment keeps the catalog it had
    // rather than half a contribution nothing has judged.
    expect(ctx.componentCatalog.catalog.entries).toEqual([])
    expect(ctx.componentCatalog.components).toEqual([])
  })

  it('answers what this deployment offers, which is the registration minus what it withholds', async () => {
    // Registering a component is the contributing plugin's act and offering it
    // is the deployment's: a row installed with the data page withheld
    // registers it, judges a call against it, and answers every reader outside
    // this package that it is not there.
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(ComponentCatalogRegistry, { withheld: [DATA_PAGE_ID] }).await()
    ctx.componentCatalog.register({ entries: COMPONENT_KIT_ENTRIES, source: KIT_SOURCE })
    expect(ctx.componentCatalog.components.map(one => one.entry.id)).toContain(DATA_PAGE_ID)
    expect(ctx.componentCatalog.offered.map(one => one.entry.id)).not.toContain(DATA_PAGE_ID)
    expect(ctx.componentCatalog.offered.map(one => one.entry.id))
      .toEqual(COMPONENT_KIT_ENTRIES.map(entry => entry.id).filter(id => id !== DATA_PAGE_ID))
  })

  it('offers every registered component where the deployment withholds none', async () => {
    const ctx = await registry()
    ctx.componentCatalog.register({ entries: TWO, source: KIT_SOURCE })
    expect(ctx.componentCatalog.offered).toEqual(ctx.componentCatalog.components)
  })
})

describe('the tool the registry decides', () => {
  it('is not offered at all while nothing is registered', async () => {
    const ctx = await row()
    expect(offered(ctx)).toBeUndefined()
  })

  it('is offered as soon as a component plugin registers, listing exactly what it registered', async () => {
    const ctx = await row()
    ctx.componentCatalog.register({ entries: TWO, source: KIT_SOURCE })
    expect(offered(ctx)?.description).toContain(describeCatalog(TWO))
    expect(offered(ctx)?.description).not.toContain(COMPONENT_KIT_ENTRIES[2]?.id)
  })

  it('re-describes itself when a second package adds a component', async () => {
    const ctx = await row()
    ctx.componentCatalog.register({ entries: ONE, source: KIT_SOURCE })
    expect(offered(ctx)?.description).not.toContain(METRIC_ID)

    ctx.componentCatalog.register({
      entries: COMPONENT_KIT_ENTRIES.filter(entry => entry.id === METRIC_ID),
      source: OTHER_SOURCE,
    })
    expect(offered(ctx)?.description).toContain(METRIC_ID)
  })

  it('is withdrawn again when the last component plugin goes', async () => {
    const ctx = await row()
    const dispose = ctx.componentCatalog.register({ entries: TWO, source: KIT_SOURCE })
    expect(offered(ctx)).toBeDefined()

    dispose()
    expect(offered(ctx)).toBeUndefined()
  })

  it('is not offered where the only registered component is one this deployment does not offer', async () => {
    const ctx = await row()
    ctx.componentCatalog.register({
      entries: COMPONENT_KIT_ENTRIES.filter(entry => entry.id === DATA_PAGE_ID),
      source: KIT_SOURCE,
    })
    // `crud` is off, so the data page is left out of the offer — and nothing
    // else is registered, so there is no component left to place.
    expect(offered(ctx)).toBeUndefined()
  })
})

describe('what a call is judged against', () => {
  it('names the registered components in the refusal, and nothing else', () => {
    const catalog = readCatalog(TWO)
    const result = validateComponentCall(catalog, {
      id: 'budget',
      title: '预算',
      spec: { nodes: [{ id: 'x', component: DATA_PAGE_ID, props: {} }] },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.text).toContain(`Available components:\n${describeCatalog(TWO)}`)
    expect(result.failure.text).not.toContain('数据表')
  })

  it('accepts a component the moment it is registered and refuses it again once it is gone', async () => {
    const ctx = await registry()
    const call = {
      id: 'budget',
      title: '预算',
      spec: { nodes: [{ id: 'x', component: CONFIRM_BAR_ID, props: { buttons: [{ id: 'ok', label: '确认' }] } }] },
    }
    expect(validateComponentCall(ctx.componentCatalog.catalog, call).ok).toBe(false)

    const dispose = ctx.componentCatalog.register({ entries: ONE, source: KIT_SOURCE })
    expect(validateComponentCall(ctx.componentCatalog.catalog, call).ok).toBe(true)

    dispose()
    expect(validateComponentCall(ctx.componentCatalog.catalog, call).ok).toBe(false)
  })
})
