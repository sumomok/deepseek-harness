// @vitest-environment jsdom
/**
 * The show-component browser half against the real SlotRegistry: the wait for
 * the content column's declaration, the kind key it claims, the component row's
 * namespace it translates through, and removal on fiber teardown (HMR safety).
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { NS } from '@deepseek-ai/dsh-experimental-component-kit/client'
import { apply, inject } from '../src/client/index.ts'
import { ComponentSurface } from '../src/client/ComponentSurface.tsx'

/** Declare the content column and its kind slot, the way `content-column` does. */
function declareColumn(ctx: Context): void {
  ctx.slots.register({
    name: 'root',
    children: { content: { kind: 'single', scope: 'root' } },
  } as never, () => null)
  ctx.slots.register({
    name: 'content',
    children: { 'content.surface.kind': { kind: 'keyed', scope: 'root' } },
  } as never, () => null)
}

/** Boot the browser half over a real slot tree that declares the column. */
async function bench(): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']> }> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  declareColumn(ctx)
  // The locale plugin binds a settings scope, which reads the connection handle
  // and the forwarded-event port.
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber }
}

describe('show-component browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('waits for the content column to declare its kind slot before claiming a key', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', { register: () => () => {}, bind: () => () => '' } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('content.surface.kind')).toHaveLength(0)

    declareColumn(ctx)
    await Promise.resolve()
    expect(ctx.slots.entries('content.surface.kind')).toHaveLength(1)
  })

  it('claims the component key against the component row\'s namespace, and teardown removes it (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    const [entry] = ctx.slots.entries('content.surface.kind')
    expect(entry?.component).toBe(ComponentSurface)
    expect(entry?.options.key).toBe('component')
    // The seat has no dictionary of its own: it reads the component row's.
    expect(entry?.locale).toBe(NS)

    await fiber.dispose()
    expect(ctx.slots.entries('content.surface.kind')).toHaveLength(0)
  })
})
