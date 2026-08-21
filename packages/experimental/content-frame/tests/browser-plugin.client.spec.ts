/**
 * content-frame browser half against the real SlotRegistry: the content-column
 * registration and the URL it injects, the wait for the shell's declaration,
 * removal on fiber teardown (HMR safety), the dictionaries, and the invariant
 * companion's ownership reservation.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { ContentFrame } from '../src/client/ContentFrame.tsx'
import * as ContentFrameInvariant from '../src/invariant.ts'
import { CONTENT_APP_SRC } from '../src/route.ts'
import { en, NS, zh } from '../src/client/locales.ts'

/** Declare the content column the way the service-line shell does. */
function declareShell(ctx: Context): void {
  ctx.slots.register({
    name: 'root',
    children: { content: { kind: 'single', scope: 'session-maybe' } },
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

describe('content-frame browser half', () => {
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

  it('registers the iframe with the same-origin route, and fiber teardown removes it (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    const [entry] = ctx.slots.entries('content')
    expect(entry?.component).toBe(ContentFrame)
    // The URL is settled in the apply world: the component receives it as data.
    expect(entry?.inject?.()).toEqual({ src: CONTENT_APP_SRC })
    expect(CONTENT_APP_SRC.startsWith('/')).toBe(true)

    await fiber.dispose()
    expect(ctx.slots.entries('content')).toHaveLength(0)
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    const { ctx, fiber } = await bench()
    const translate = ctx.locale.bind(NS)
    expect(translate('frame.title')).toBe(zh['frame.title'])
    ctx.locale.setLocale('en')
    expect(translate('frame.title')).toBe(en['frame.title'])

    // Withdrawn dictionaries leave the key unresolved rather than translated.
    await fiber.dispose()
    expect(translate('frame.title')).not.toBe(en['frame.title'])
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('content-frame invariant companion', () => {
  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(ContentFrameInvariant)
    await fiber.await()
    expect(ContentFrameInvariant.name).toBe('experimental-content-frame-invariant')
    expect(ContentFrameInvariant.inject).toEqual(['invariants'])
    // Emitting an unrelated event proves the companion installed no audit.
    expect(() => { (ctx.emit as (event: string) => void)('slots/changed') }).not.toThrow()
    await fiber.dispose()
  })
})
