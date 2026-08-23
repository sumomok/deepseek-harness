/**
 * show-chart browser half against the real SlotRegistry: the settings read that
 * has to precede the registration, the keyed tool-view claim and the capture
 * switch it injects, the wait for the tool package's declaration, removal on
 * fiber teardown (HMR safety), the dictionaries, and the invariant companion's
 * ownership reservation.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { ShowChartRow } from '../src/client/ShowChartRow.tsx'
import * as ShowChartInvariant from '../src/invariant.ts'
import { SHOW_CHART_SETTINGS_ROUTE } from '../src/route.ts'
import { en, NS, zh } from '../src/client/locales.ts'

/** Answer the node half's settings route with one document. */
function serveSettings(body: unknown, ok = true): void {
  vi.stubGlobal('fetch', vi.fn((input: string) => {
    if (input !== SHOW_CHART_SETTINGS_ROUTE) throw new Error(`unexpected fetch: ${input}`)
    return Promise.resolve({ ok, status: ok ? 200 : 503, json: () => Promise.resolve(body) })
  }))
}

/** Declare the keyed tool-view slot the way `dsh-client-ui-tool` does. */
function declareToolViews(ctx: Context): void {
  ctx.slots.register({
    name: 'root',
    children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } },
  } as never, () => null)
}

/** The entry claiming one tool-view key, if any. */
function claim(ctx: Context, key: string): ReturnType<Context['slots']['entries']>[number] | undefined {
  return ctx.slots.entries('tool.call.toolview').find(entry => entry.options.key === key)
}

/** The component claiming one tool-view key, if any. */
function claimant(ctx: Context, key: string): unknown {
  return claim(ctx, key)?.component
}

/** Boot the browser half over a real slot tree that declares the tool-view slot. */
async function bench(): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']> }> {
  serveSettings({ screenshot: false })
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  declareToolViews(ctx)
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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('show-chart browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('waits for the tool package to declare the view slot before claiming its key', async () => {
    serveSettings({ screenshot: false })
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', { register: () => () => {}, bind: () => () => '' } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('tool.call.toolview')).toHaveLength(0)

    declareToolViews(ctx)
    await Promise.resolve()
    expect(claimant(ctx, 'show_chart')).toBe(ShowChartRow)
  })

  it('claims only its own tool name, leaving every other row untouched', async () => {
    const { ctx } = await bench()
    expect(claimant(ctx, 'show_chart')).toBe(ShowChartRow)
    expect(claimant(ctx, 'bash')).toBeUndefined()
  })

  it('injects the capture switch its node half serves', async () => {
    serveSettings({ screenshot: true })
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    declareToolViews(ctx)
    ctx.provide('locale', { register: () => () => {}, bind: () => () => '' } as never)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entry = claim(ctx, 'show_chart')
    expect((entry?.inject as (() => { screenshot: boolean }) | undefined)?.()).toEqual({ screenshot: true })
  })

  it('fails the row rather than guessing when the settings document is unusable', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    declareToolViews(ctx)
    ctx.provide('locale', { register: () => () => {}, bind: () => () => '' } as never)
    for (const [body, ok, message] of [
      [{ screenshot: false }, false, /answered 503/],
      [{}, true, /unusable screenshot switch: undefined/],
      [{ screenshot: 'yes' }, true, /unusable screenshot switch: "yes"/],
    ] as const) {
      serveSettings(body, ok)
      // The plugin body itself, not a fiber: a rejecting apply is what fails
      // the row, and the fiber only reports it.
      await expect(apply(ctx)).rejects.toThrow(message)
    }
    expect(ctx.slots.entries('tool.call.toolview')).toHaveLength(0)
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    const { ctx, fiber } = await bench()
    const translate = ctx.locale.bind(NS)
    expect(translate('row.title')).toBe(zh['row.title'])
    ctx.locale.setLocale('en')
    expect(translate('row.title')).toBe(en['row.title'])

    await fiber.dispose()
    // Withdrawn dictionaries leave the key unresolved rather than translated.
    expect(translate('row.title')).not.toBe(en['row.title'])
    expect(claimant(ctx, 'show_chart')).toBeUndefined()
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('show-chart invariant companion', () => {
  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(ShowChartInvariant)
    await fiber.await()
    expect(ShowChartInvariant.name).toBe('experimental-vue2-echarts-tool-poc-invariant')
    expect(ShowChartInvariant.inject).toEqual(['invariants'])
    // Emitting an unrelated event proves the companion installed no audit.
    expect(() => { (ctx.emit as (event: string) => void)('slots/changed') }).not.toThrow()
    await fiber.dispose()
  })
})
