// @vitest-environment jsdom
/**
 * component-kit plugin halves: the browser entry's dictionary registration
 * against the real locale plugin (with fiber teardown proving removal — HMR
 * safety), the renderer table it publishes, the inert node entry, and the
 * invariant companion's ownership reservation.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, COMPONENT_RENDERERS, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import { ConfirmBar } from '../src/client/ConfirmBar.tsx'
import { TableDetailRenderer } from '../src/client/TableDetailRenderer.tsx'
import { TcProcessBallRenderer } from '../src/client/TcProcessBallRenderer.tsx'
import { TuQueryCondAdvRenderer } from '../src/client/TuQueryCondAdvRenderer.tsx'
import { TcFormDetailRenderer } from '../src/client/TcFormDetailRenderer.tsx'
import * as ComponentKitInvariant from '../src/invariant.ts'
import { en, NS, zh } from '../src/client/locales.ts'

/** Boot the browser half over a real locale registry. */
async function bench(): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']> }> {
  const ctx = new Context()
  // The locale plugin installs the `t` seat on the slot registry, so the
  // registry has to exist before its fiber resolves.
  await ctx.plugin(SlotRegistry).await()
  // The locale plugin binds a settings scope, which reads the connection handle
  // and the forwarded-event port.
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  // These specs assert the shipped Chinese copy; state the asserted locale
  // rather than resting on the environment's detected one.
  ctx.locale.setLocale('zh')
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber }
}

describe('component-kit browser half', () => {
  it('declares the one service it binds and registers no slot', () => {
    expect(inject).toEqual(['locale'])
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    const { ctx, fiber } = await bench()
    const translate = ctx.locale.bind(NS)
    expect(translate('confirmBar.actions')).toBe(zh['confirmBar.actions'])
    ctx.locale.setLocale('en')
    expect(translate('confirmBar.actions')).toBe(en['confirmBar.actions'])

    // Withdrawn dictionaries leave the key unresolved rather than translated.
    await fiber.dispose()
    expect(translate('confirmBar.actions')).not.toBe(en['confirmBar.actions'])
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('publishes every component under the catalog id a block names', () => {
    expect(COMPONENT_RENDERERS).toEqual({
      'el.confirm-bar': ConfirmBar,
      'el.filter-bar': TuQueryCondAdvRenderer,
      'el.metric': TcProcessBallRenderer,
      'toy.record': TcFormDetailRenderer,
      'toy.table': TableDetailRenderer,
    })
  })
})

describe('component-kit node half', () => {
  it('contributes no host behavior', () => {
    // The node half exists only so the plugin appears in the Loader tree.
    expect(applyNode).not.toThrow()
  })
})

describe('component-kit invariant companion', () => {
  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(ComponentKitInvariant)
    await fiber.await()
    expect(ComponentKitInvariant.name).toBe('experimental-component-kit-invariant')
    expect(ComponentKitInvariant.inject).toEqual(['invariants'])
    // Emitting an unrelated event proves the companion installed no audit.
    expect(() => { (ctx.emit as (event: string) => void)('slots/changed') }).not.toThrow()
    await fiber.dispose()
  })
})
