// @vitest-environment jsdom
/**
 * component-kit plugin halves: the browser entry's dictionary registration
 * against the real locale plugin (with fiber teardown proving removal — HMR
 * safety) and the components it contributes to a placement row's browser
 * registry.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { ComponentRendererRegistry } from '@deepseek-ai/dsh-experimental-component-surface/client'
import { COMPONENT_KIT_ENTRIES } from '@deepseek-ai/dsh-experimental-component-surface'
import { apply, componentKitRenderers, inject } from '../src/client/index.ts'
import { ConfirmBar } from '../src/client/ConfirmBar.tsx'
import { DataPageRenderer } from '../src/client/DataPageRenderer.tsx'
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
  // The placement row's browser registry: this row contributes into it and does
  // not own it, so the bench stands in for that row and nothing else of it.
  await ctx.plugin(ComponentRendererRegistry).await()
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

  it('pairs every definition it registers with the renderer that draws it', () => {
    expect(componentKitRenderers().map(one => [one.entry.id, one.render])).toEqual([
      ['el.confirm-bar', ConfirmBar],
      ['toy.record', TcFormDetailRenderer],
      ['toy.table', TableDetailRenderer],
      ['el.filter-bar', TuQueryCondAdvRenderer],
      ['el.metric', TcProcessBallRenderer],
      ['toy.data-page', DataPageRenderer],
    ])
  })

  it('refuses to contribute a definition nothing in the table draws', () => {
    expect(() => componentKitRenderers({ 'el.confirm-bar': ConfirmBar }))
      .toThrow('component-kit: no renderer draws toy.record')
  })

  it('registers its components into the placement row\'s registry and releases them with the fiber', async () => {
    const { ctx, fiber } = await bench()
    expect(ctx.componentRenderers.catalog.entries.map(entry => entry.id))
      .toEqual(COMPONENT_KIT_ENTRIES.map(entry => entry.id))
    expect(ctx.componentRenderers.rendererFor('el.confirm-bar')?.render).toBe(ConfirmBar)

    await fiber.dispose()
    expect(ctx.componentRenderers.catalog.entries).toEqual([])
    expect(ctx.componentRenderers.rendererFor('el.confirm-bar')).toBeUndefined()
  })

  it('hands its renderers a translate reading its own dictionary', async () => {
    const { ctx } = await bench()
    const registered = ctx.componentRenderers.rendererFor('el.confirm-bar')
    expect(registered?.t('confirmBar.actions')).toBe(zh['confirmBar.actions'])
    ctx.locale.setLocale('en')
    expect(registered?.t('confirmBar.actions')).toBe(en['confirmBar.actions'])
  })

  it('starts the one read of the node half\'s settings when it starts, once for the page', async () => {
    await bench()
    await bench()
    expect(settingsReads).toEqual([COMPONENT_KIT_SETTINGS_ROUTE])
  })
})
