/**
 * vue2-echarts-content-poc plugin halves: the browser entry's content-column
 * registration against the real SlotRegistry (waiting for the shell's
 * declaration, and removed by fiber teardown — HMR safety), the inert node
 * entry, and the invariant companion's ownership reservation.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { ChartPanel } from '@deepseek-ai/dsh-experimental-vue2-echarts-poc/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import * as ContentPocInvariant from '../src/invariant.ts'

/** The component currently occupying the content column, if any. */
function contentOccupant(ctx: Context): unknown {
  return ctx.slots.entries('content').at(0)?.component
}

/** Declare the shell's `content` seat on a real slot tree. */
function declareShell(ctx: Context): void {
  ctx.slots.register({
    name: 'root',
    children: { content: { kind: 'single', scope: 'root' } },
  } as never, () => null)
}

describe('vue2-echarts-content-poc browser half', () => {
  it('declares the one service it binds', () => {
    expect(inject).toEqual(['slots'])
  })

  it('waits for the shell to declare the column before claiming it', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(contentOccupant(ctx)).toBeUndefined()

    declareShell(ctx)
    await Promise.resolve()
    expect(contentOccupant(ctx)).toBe(ChartPanel)
  })

  it('registers the chart panel, and fiber teardown removes it (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    declareShell(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(contentOccupant(ctx)).toBe(ChartPanel)

    await fiber.dispose()
    expect(contentOccupant(ctx)).toBeUndefined()
  })
})

describe('vue2-echarts-content-poc node half', () => {
  it('contributes no host behavior', () => {
    // The node half exists only so the plugin appears in the Loader tree.
    expect(applyNode).not.toThrow()
  })
})

describe('vue2-echarts-content-poc invariant companion', () => {
  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(ContentPocInvariant)
    await fiber.await()
    expect(ContentPocInvariant.name).toBe('experimental-vue2-echarts-content-poc-invariant')
    expect(ContentPocInvariant.inject).toEqual(['invariants'])
    // Emitting an unrelated event proves the companion installed no audit.
    expect(() => { (ctx.emit as (event: string) => void)('slots/changed') }).not.toThrow()
    await fiber.dispose()
  })
})
