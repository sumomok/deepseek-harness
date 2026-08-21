// @vitest-environment jsdom
/**
 * The plugin halves against a real slot tree: one register() call occupies
 * 'root' and declares all five child slots, ctx.layout is provided by the same
 * effect so the shipped registrants that inject it find their seats declared,
 * the theme projection follows the theme service, and fiber teardown removes
 * every contribution (HMR safety). The node half and the invariant companion
 * ride along.
 */
import { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as themeApply, inject as themeInject, type ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import * as ShellInvariant from '../src/invariant.ts'
import { DARK_PALETTE_ATTRIBUTE } from '../src/client/theme-projection.ts'
import { en, NS, zh } from '../src/client/locales.ts'

/** Boot the services this shell injects, then return the tree it registers into. */
async function bench() {
  const ctx = new Context()
  const slotsFiber = ctx.plugin(SlotRegistry)
  ctx.provide('locale', new LocaleRuntime(ctx))
  // ui-theme registers an Appearance settings row and binds a durable scope;
  // model this bench as a remote, memory-only browser.
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await ctx.plugin({ inject: themeInject, apply: themeApply }).await()
  await slotsFiber.await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry }
}

beforeEach(() => {
  document.body.removeAttribute(DARK_PALETTE_ATTRIBUTE)
  document.documentElement.removeAttribute('style')
})

describe('server-layout browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'theme', 'locale'])
  })

  it('provides ctx.layout and declares all five child slots from one root registration', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()

    expect(ctx.get('layout')).toBeDefined()
    expect(slots.entries('root')).toHaveLength(1)
    // The four shipped keys keep their kinds and scopes, so ui-sidebar and
    // ui-conversation register into this shell without a change.
    expect(slots.spec('sidebar')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.spec('conversation')).toEqual({ kind: 'single', scope: 'session-maybe' })
    expect(slots.spec('details')).toEqual({ kind: 'single', scope: 'session' })
    expect(slots.spec('shell.overlay')).toEqual({ kind: 'list', scope: 'root' })
    // Plus this shell's own center column, root-scoped so no session
    // transition can remount whatever DOM its occupant holds.
    expect(slots.spec('content')).toEqual({ kind: 'single', scope: 'root' })
  })

  it('arms ctx.layout from the entry inject hook and returns no business face', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()

    const actions = { toggleSidebar: vi.fn(), openDetails: vi.fn(), closeDetails: vi.fn() }
    const injected = (slots.entries('root')[0]!.inject as (actions: never) => object)(actions as never)
    expect(injected).toEqual({})

    ctx.layout.openDetails()
    expect(actions.openDetails).toHaveBeenCalledOnce()
  })

  it('registers both dictionaries under its own namespace', async () => {
    const { ctx } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const translate = ctx.locale.bind(NS)
    ctx.locale.setLocale('zh')
    expect(translate('content.title')).toBe(zh['content.title'])
    ctx.locale.setLocale('en')
    expect(translate('content.title')).toBe(en['content.title'])

    await fiber.dispose()
    expect(translate('content.title')).not.toBe(en['content.title'])
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('projects the initial theme, follows theme/change, and retracts on dispose', async () => {
    const { ctx } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    // jsdom has no matchMedia, so `system` resolves to the light palette.
    expect(document.documentElement.style.colorScheme).toBe('light')

    const theme = ctx.get('theme') as ThemeRuntime
    theme.setTheme('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.hasAttribute(DARK_PALETTE_ATTRIBUTE)).toBe(true)

    await fiber.dispose()
    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.body.hasAttribute(DARK_PALETTE_ATTRIBUTE)).toBe(false)

    // The listener left with the fiber: later changes no longer reach the document.
    theme.setTheme('light')
    theme.setTheme('dark')
    expect(document.documentElement.style.colorScheme).toBe('')
  })

  it('teardown withdraws the service, the root entry, and every child declaration (HMR safety)', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()

    expect(ctx.get('layout')).toBeUndefined()
    expect(slots.entries('root')).toHaveLength(0)
    expect(slots.spec('sidebar')).toBeUndefined()
    expect(slots.spec('content')).toBeUndefined()
    // The built-in root declaration survives entry teardown (runtime-owned).
    expect(slots.spec('root')).toEqual({ kind: 'single', scope: 'root' })
  })
})

describe('server-layout node half', () => {
  it('contributes no host behavior', () => {
    expect(nodeApply).not.toThrow()
  })
})

describe('server-layout invariant companion', () => {
  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(ShellInvariant)
    await fiber.await()
    expect(ShellInvariant.name).toBe('experimental-server-layout-invariant')
    expect(ShellInvariant.inject).toEqual(['invariants'])
    // Emitting an unrelated event proves the companion installed no audit.
    expect(() => { (ctx.emit as (event: string) => void)('slots/changed') }).not.toThrow()
    await fiber.dispose()
  })
})
