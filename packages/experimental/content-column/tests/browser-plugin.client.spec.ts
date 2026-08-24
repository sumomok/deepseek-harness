/**
 * The content surface's browser half against the real SlotRegistry: the column
 * registration and the kind slot it declares, the wait for the shell's
 * declaration, removal on fiber teardown (HMR safety), the dictionaries, the
 * behaviorless node half, and the invariant companion's ownership reservation.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import { ContentSurface } from '../src/client/ContentSurface.tsx'
import { en, NS, zh } from '../src/client/locales.ts'
import * as ContentColumnInvariant from '../src/invariant.ts'

/** Declare the content column the way the service-line shell does. */
function declareShell(ctx: Context): void {
  ctx.slots.register({
    name: 'root',
    children: { content: { kind: 'single', scope: 'root' } },
  } as never, () => null)
}

/** Boot the browser half over a real slot tree that declares the content column. */
async function bench(): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']> }> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  declareShell(ctx)
  // The locale plugin binds a settings scope, which reads the connection handle
  // and the forwarded-event port.
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  // These specs assert the shipped Chinese copy. There is no jsdom `window` in
  // this lane, so browser-language detection never runs and the locale comes
  // from FALLBACK_LOCALE (en): state the asserted locale explicitly.
  ctx.locale.setLocale('zh')
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber }
}

describe('content-column browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('waits for the shell to declare the content column before claiming it', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', { register: () => () => {}, bind: () => () => '' } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('content')).toHaveLength(0)

    declareShell(ctx)
    await Promise.resolve()
    expect(ctx.slots.entries('content')).toHaveLength(1)
  })

  it('claims the column, opens the kind slot, and fiber teardown removes both (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    const [entry] = ctx.slots.entries('content')
    expect(entry?.component).toBe(ContentSurface)
    expect(entry?.children).toEqual({ 'content.surface.kind': { kind: 'keyed', scope: 'root' } })

    await fiber.dispose()
    expect(ctx.slots.entries('content')).toHaveLength(0)
    // The kind slot is the column's declaration, so it collapses with it: a
    // renderer registered against it has nowhere to be.
    expect(() => {
      ctx.slots.register({ name: 'content.surface.kind', key: 'page' } as never, () => null)
    }).toThrow()
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    const { ctx, fiber } = await bench()
    const translate = ctx.locale.bind(NS)
    expect(translate('switcher.label')).toBe(zh['switcher.label'])
    ctx.locale.setLocale('en')
    expect(translate('switcher.label')).toBe(en['switcher.label'])

    // Withdrawn dictionaries leave the key unresolved rather than translated.
    await fiber.dispose()
    expect(translate('switcher.label')).not.toBe(en['switcher.label'])
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('content-column node half', () => {
  it('contributes no host behavior', () => {
    expect(nodeApply).not.toThrow()
  })
})

describe('content-column invariant companion', () => {
  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(ContentColumnInvariant)
    await fiber.await()
    expect(ContentColumnInvariant.name).toBe('experimental-content-column-invariant')
    expect(ContentColumnInvariant.inject).toEqual(['invariants'])
    // Emitting an unrelated event proves the companion installed no audit.
    expect(() => { (ctx.emit as (event: string) => void)('slots/changed') }).not.toThrow()
    await fiber.dispose()
  })
})
