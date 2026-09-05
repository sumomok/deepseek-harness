// @vitest-environment jsdom
/**
 * content-frame browser half against the real SlotRegistry: the settings read
 * that has to precede the registration, the `page` kind registration and the
 * values and callback it injects, the empty `conversation.chat.commandview`
 * registrations for both browser-driven commands and their hiding stylesheet,
 * the `content_read` row that exists only where the deployment configured page
 * access, the wait for the column's/conversation's declarations, removal on
 * fiber teardown (HMR safety), the dictionaries, and the invariant companion's
 * ownership reservation.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { ContentFrame } from '../src/client/ContentFrame.tsx'
import { ContentReadRow } from '../src/client/access/ContentReadRow.tsx'
import { HiddenCommandRow } from '../src/client/HiddenCommandRow.tsx'
import * as ContentFrameInvariant from '../src/invariant.ts'
import { CONTENT_SETTINGS_ROUTE } from '../src/route.ts'
import { en, NS, zh } from '../src/client/locales.ts'

const HIDE_STYLE_ID = 'dsh-content-frame-hide-empty-command-row'

/** The page-access half of the settings document the bench serves. */
const ACCESS = {
  outlineChars: 12000, claimTimeoutMs: 3000, readTimeoutMs: 15000, settleQuietMs: 250,
  actTimeoutMs: 60000, maxSteps: 20, settleMaxMs: 3000,
}

/** The settings document the bench serves. */
const SETTINGS = { cacheSize: 5, navigationPollMs: 1000, pageAccess: ACCESS }

/**
 * Answer the node half's settings route with one document. The browser half
 * resolves the route against the page's deployment base, so the bench routes on
 * the resolved path rather than on the route constant.
 * @param body - the settings document to answer with.
 * @param ok - whether the route answers 200.
 * @returns the URLs the browser half asked for, in order.
 */
function serveSettings(body: unknown, ok = true): URL[] {
  const asked: URL[] = []
  vi.stubGlobal('fetch', vi.fn((input: URL) => {
    asked.push(input)
    if (!input.pathname.endsWith(CONTENT_SETTINGS_ROUTE)) throw new Error(`unexpected fetch: ${input.href}`)
    return Promise.resolve({ ok, status: ok ? 200 : 503, json: () => Promise.resolve(body) })
  }))
  return asked
}

/** Declare the content column's kind slot, the chat view's per-command slot, and the tool-view slot, the way their owners do. */
function declareColumn(ctx: Context): void {
  ctx.slots.register({
    name: 'root',
    children: {
      'content.surface.kind': { kind: 'keyed', scope: 'root' },
      'conversation.chat.commandview': { kind: 'keyed', scope: 'session' },
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    },
  } as never, () => null)
}

/** Boot the browser half over a real slot tree that declares the content column. */
async function bench(settings: unknown = SETTINGS): Promise<{
  ctx: Context
  fiber: ReturnType<Context['plugin']>
  execute: ReturnType<typeof vi.fn>
}> {
  serveSettings(settings)
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  declareColumn(ctx)
  // The locale plugin binds a settings scope, which reads the connection handle
  // and the forwarded-event port.
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  const execute = vi.fn(() => Promise.resolve({ ok: true, value: undefined }))
  ctx.provide('remote', { commands: { execute }, $on: () => () => {} } as never)
  ctx.provide('remote.commands', { execute } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  // These specs assert the shipped Chinese copy. This lane runs under jsdom
  // (the hiding stylesheet below needs a `document`), whose default
  // `navigator.language` would itself detect to 'en' — state the asserted
  // locale explicitly rather than resting on that coincidence.
  ctx.locale.setLocale('zh')
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, execute }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('content-frame browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.commands'])
  })

  it('waits for the column/conversation to declare their slots before claiming either key', async () => {
    serveSettings({ cacheSize: 3, navigationPollMs: 1000, pageAccess: ACCESS })
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', { register: () => () => {}, bind: () => () => '' } as never)
    ctx.provide('remote', { commands: { execute: vi.fn() } } as never)
    ctx.provide('remote.commands', { execute: vi.fn() } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('content.surface.kind')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.chat.commandview')).toHaveLength(0)

    declareColumn(ctx)
    await Promise.resolve()
    expect(ctx.slots.entries('content.surface.kind')).toHaveLength(1)
    expect(ctx.slots.entries('conversation.chat.commandview')).toHaveLength(2)
  })

  it('registers the page key with the served cache bound, and fiber teardown removes it (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    const [entry] = ctx.slots.entries('content.surface.kind')
    expect(entry?.component).toBe(ContentFrame)
    expect(entry?.options.key).toBe('page')
    // The bounds are settled in the apply world: the component receives them
    // as data, alongside the one callback it cannot settle for itself.
    const face = entry?.inject?.() as { cacheSize: number; navigationPollMs: number; pageAccess: unknown; onNavigated: unknown }
    expect({ cacheSize: face.cacheSize, navigationPollMs: face.navigationPollMs, pageAccess: face.pageAccess })
      .toEqual(SETTINGS)
    expect(typeof face.onNavigated).toBe('function')

    await fiber.dispose()
    expect(ctx.slots.entries('content.surface.kind')).toHaveLength(0)
  })

  it('injects a navigation reporter that executes content-navigated against the named session', async () => {
    const { ctx, execute } = await bench()
    const [entry] = ctx.slots.entries('content.surface.kind')
    const face = entry?.inject?.() as { onNavigated: (s: string, p: string, u: string, t: string) => void }
    face.onNavigated('session-a', 'home', '/content-app/#/device', 'Fleet devices')
    await Promise.resolve()
    expect(execute).toHaveBeenCalledWith(
      'session-a',
      '/content-navigated user home /content-app/#/device Fleet devices',
      [],
    )
  })

  it(
    'registers an empty conversation.chat.commandview entry for each browser-driven command, and fiber teardown removes both (HMR safety)',
    async () => {
      const { ctx, fiber } = await bench()
      const entries = ctx.slots.entries('conversation.chat.commandview')
      expect(entries.map(entry => entry.options.key)).toEqual(['show-content-page', 'content-navigated'])
      expect(entries.every(entry => entry.component === HiddenCommandRow)).toBe(true)
      expect((entries[0]?.component as typeof HiddenCommandRow)()).toBeNull()

      await fiber.dispose()
      expect(ctx.slots.entries('conversation.chat.commandview')).toHaveLength(0)
    },
  )

  it('injects the hiding stylesheet, and fiber teardown removes it (HMR safety)', async () => {
    document.getElementById(HIDE_STYLE_ID)?.remove()
    const { fiber } = await bench()
    const style = document.getElementById(HIDE_STYLE_ID)
    expect(style).not.toBeNull()
    expect(style?.textContent).toContain('[data-chat-flow-kind="command"]')
    expect(style?.textContent).toContain('[data-slot="conversation.chat.commandview"]:empty')

    await fiber.dispose()
    expect(document.getElementById(HIDE_STYLE_ID)).toBeNull()
  })

  it('claims the content_read row only where the deployment configured page access', async () => {
    const { ctx, fiber } = await bench()
    const [entry] = ctx.slots.entries('tool.call.toolview')
    expect(entry?.component).toBe(ContentReadRow)
    expect(entry?.options.key).toBe('content_read')

    await fiber.dispose()
    expect(ctx.slots.entries('tool.call.toolview')).toHaveLength(0)

    // The same row, the same pages, and no read anywhere: the model is never
    // offered the tool, so a row for its calls would draw nothing.
    const closed = await bench({ cacheSize: 5, navigationPollMs: 1000 })
    expect(closed.ctx.slots.entries('tool.call.toolview')).toHaveLength(0)
    expect(closed.ctx.slots.entries('content.surface.kind')).toHaveLength(1)
    const face = closed.ctx.slots.entries('content.surface.kind')[0]?.inject?.() as Record<string, unknown>
    expect(Object.keys(face).sort()).toEqual(['cacheSize', 'navigationPollMs', 'onNavigated'])
    await closed.fiber.dispose()
  })

  it('fails the row rather than guessing when the settings route is unusable', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', { register: () => () => {}, bind: () => () => '' } as never)
    ctx.provide('remote', { commands: { execute: vi.fn() } } as never)
    ctx.provide('remote.commands', { execute: vi.fn() } as never)
    for (const [body, ok, message] of [
      [{ cacheSize: 3 }, false, /answered 503/],
      [{}, true, /unusable cacheSize: undefined/],
      [{ cacheSize: 0 }, true, /unusable cacheSize: 0/],
      [{ cacheSize: 1.5 }, true, /unusable cacheSize: 1.5/],
      [{ cacheSize: 3 }, true, /unusable navigationPollMs: undefined/],
      [{ cacheSize: 3, navigationPollMs: 0 }, true, /unusable navigationPollMs: 0/],
      [{ cacheSize: 3, navigationPollMs: 1000, pageAccess: null }, true, /unusable pageAccess: null/],
      [{ cacheSize: 3, navigationPollMs: 1000, pageAccess: {} }, true, /unusable pageAccess/],
      [{ cacheSize: 3, navigationPollMs: 1000, pageAccess: { ...ACCESS, outlineChars: 0 } }, true, /unusable pageAccess/],
      [{ cacheSize: 3, navigationPollMs: 1000, pageAccess: { ...ACCESS, readTimeoutMs: '15s' } }, true, /unusable pageAccess/],
      [{ cacheSize: 3, navigationPollMs: 1000, pageAccess: { ...ACCESS, settleQuietMs: undefined } }, true, /unusable pageAccess/],
    ] as const) {
      serveSettings(body, ok)
      // The plugin body itself, not a fiber: a rejecting apply is what fails
      // the row, and the fiber only reports it.
      await expect(apply(ctx)).rejects.toThrow(message)
    }
    expect(ctx.slots.entries('content.surface.kind')).toHaveLength(0)
  })

  it('reads the settings route through the deployment prefix the page is served under', async () => {
    vi.stubGlobal('__DSH_BASE__', '/console/')
    const asked = serveSettings(SETTINGS)
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    declareColumn(ctx)
    ctx.provide('locale', { register: () => () => {}, bind: () => () => '' } as never)
    await apply(ctx)
    // The node half registers the route root-absolute and a reverse proxy
    // strips the prefix again; the browser is the half that has to put it back.
    expect(asked.map(url => url.pathname)).toEqual(['/console/content-frame/settings'])
    expect(asked[0]?.origin).toBe(location.origin)
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
    await fiber.dispose()
  })
})
