// @vitest-environment jsdom
/**
 * component-kit plugin halves: the browser entry's dictionary registration
 * against the real locale plugin (with fiber teardown proving removal — HMR
 * safety), the renderer table it publishes, and the inert node entry.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, COMPONENT_RENDERERS, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import { ConfirmBar } from '../src/client/ConfirmBar.tsx'
import { CrudRenderer } from '../src/client/CrudRenderer.tsx'
import { COMPONENT_KIT_SETTINGS_ROUTE } from '../src/route.ts'
import { TableDetailRenderer } from '../src/client/TableDetailRenderer.tsx'
import { TcProcessBallRenderer } from '../src/client/TcProcessBallRenderer.tsx'
import { TuQueryCondAdvRenderer } from '../src/client/TuQueryCondAdvRenderer.tsx'
import { TcFormDetailRenderer } from '../src/client/TcFormDetailRenderer.tsx'
import { en, NS, zh } from '../src/client/locales.ts'

/** Every read of the settings route the browser half made, across the file: the read is memoized for the page's life. */
const settingsReads: string[] = []

// Stubbed once for the file rather than per case, because the browser half
// reads its settings once for the page's life and the first bench is what
// starts that read.
vi.stubGlobal('fetch', vi.fn((input: URL) => {
  settingsReads.push(input.pathname)
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ bizBasePath: '/' }) })
}))

/** Boot the browser half over a real locale registry, with the node half's settings route answered. */
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
      'toy.crud': CrudRenderer,
      'toy.record': TcFormDetailRenderer,
      'toy.table': TableDetailRenderer,
    })
  })

  it('starts the one read of the node half\'s settings when it starts, once for the page', async () => {
    await bench()
    await bench()
    expect(settingsReads).toEqual([COMPONENT_KIT_SETTINGS_ROUTE])
  })
})

describe('component-kit node half', () => {
  it('claims no service and serves nothing without a webserver', () => {
    // The node half's one contribution is a settings route, and it waits for
    // the webserver rather than requiring it; the route itself is exercised in
    // `host-settings.client.spec.ts`.
    const ctx = new Context()
    expect(() => { applyNode(ctx, {}) }).not.toThrow()
    expect(ctx.get('webServer')).toBeUndefined()
  })
})
