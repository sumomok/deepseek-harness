// @vitest-environment jsdom
/**
 * The browser half wired into a real slot tree: the banner lands in the
 * frame-wide `shell.overlay` seat and draws through the production renderer
 * in the visitor's language; `connection/reset` and, where configured, the
 * page returning to the foreground start the build check; the connection
 * notices follow the connection service where configured; the check runs in a
 * context that offers no slot or locale service; and fiber disposal removes
 * the banner and leaves nothing that can still reload (HMR safety). The plugin
 * body itself reads its settings from the page global.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { Config } from '../src/index.ts'
import { createBannerStore } from '../src/client/banner-state.ts'
import { RELOADED_FOR_STORAGE_KEY } from '../src/client/check.ts'
import { apply, inject } from '../src/client/index.ts'
import { installPageRefresh } from '../src/client/install.ts'
import { LOSS_NOTICE_DELAY_MS } from '../src/client/notice.ts'
import { bootGraph, DOCUMENT_URL, FakePage, servedIndex, settle } from './fake-browser.client.ts'

usePinnedBrowserLanguages('zh-CN')

const DEFAULTS = { checkOnVisible: true, reloadDelayMs: 0, disconnectNotice: true, stuckAfterSeconds: 60 } satisfies Config
/** A build other than the one the fake page booted with. */
const NEWER = servedIndex([{ id: 'a', rev: '2' }])

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  vi.unstubAllGlobals()
})

/** The connection service face this plugin reads: its state. */
function connectionService() {
  const state = createSnapshotStore<ConnectionState | undefined>(undefined)
  return { state, service: { state } }
}

/** A slot tree with the overlay seat declared, the locale runtime, and a connection. */
async function bench(settings: Partial<Config> = {}) {
  const runtime = await SlotTestRuntime.create()
  disposers.push(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  const connection = connectionService()
  runtime.ctx.provide('connection', connection.service as never)
  await runtime.declare({ 'shell.overlay': { kind: 'list', scope: 'root' } })
  const page = new FakePage()
  const banners = createBannerStore()
  const logs: string[] = []
  const handle = await runtime.mount({
    inject,
    apply: (ctx: Context) => {
      installPageRefresh(ctx, { browser: page, settings: { ...DEFAULTS, ...settings }, banners, log: (message) => { logs.push(message) } })
    },
  })
  return { runtime, page, banners, logs, handle, connection }
}

describe('the banner', () => {
  it('registers into the frame-wide overlay seat and draws the current notice', async () => {
    const { runtime, banners } = await bench()
    expect(runtime.slots.entries('shell.overlay').map(entry => entry.options.id)).toEqual(['page-refresh.banner'])
    const view = runtime.renderSlot('shell.overlay', {})
    expect(view.container.textContent).toBe('')
    await vi.waitFor(() => {
      banners.update((draft) => { draft.refresh = 'update' })
      expect(view.container.textContent).toContain('页面有新版本，请刷新后继续使用')
    })
  })

  it('reloads the page from the banner\'s button', async () => {
    const { runtime, banners, page } = await bench()
    const view = runtime.renderSlot('shell.overlay', {})
    banners.update((draft) => { draft.connection = 'stuck' })
    const button = await view.view.findByRole('button', { name: '刷新页面' })
    button.click()
    expect(page.reloads).toBe(1)
  })
})

describe('the build check', () => {
  it('runs on every established connection and reloads once for a different build', async () => {
    const { runtime, page } = await bench()
    runtime.ctx.emit('connection/reset')
    await settle()
    // The fragment is the page's own; the request carries the document URL.
    expect(page.lastRequest().url).toBe(DOCUMENT_URL)
    page.lastRequest().answer({ body: NEWER })
    await settle()
    expect(page.reloads).toBe(1)
    expect(page.session.has(RELOADED_FOR_STORAGE_KEY)).toBe(true)
  })

  it('offers the reload in the banner when this tab already reloaded for the served build', async () => {
    const first = await bench()
    first.runtime.ctx.emit('connection/reset')
    await settle()
    first.page.lastRequest().answer({ body: NEWER })
    await settle()
    const reloadedFor = first.page.session.get(RELOADED_FOR_STORAGE_KEY)
    // The page after that reload, which the server still serves a build it cannot boot onto.
    const second = await bench()
    second.page.session.set(RELOADED_FOR_STORAGE_KEY, reloadedFor!)
    second.runtime.ctx.emit('connection/reset')
    await settle()
    second.page.lastRequest().answer({ body: NEWER })
    await settle()
    expect(second.page.reloads).toBe(0)
    expect(second.banners.getSnapshot().refresh).toBe('update')
  })

  it('runs when the page returns to the foreground only where configured', async () => {
    const on = await bench()
    on.page.showPage()
    await settle()
    expect(on.page.requests).toHaveLength(1)
    const off = await bench({ checkOnVisible: false })
    expect(off.page.foreground.size).toBe(0)
  })

  it('checks nothing in a page that booted without a readable boot graph', async () => {
    const runtime = await SlotTestRuntime.create()
    disposers.push(() => runtime.dispose())
    runtime.ctx.provide('connection', connectionService().service as never)
    const page = new FakePage()
    page.boot = undefined
    const logs: string[] = []
    await runtime.mount({
      inject,
      apply: (ctx: Context) => {
        installPageRefresh(ctx, {
          browser: page, settings: DEFAULTS, banners: createBannerStore(), log: (message) => { logs.push(message) },
        })
      },
    })
    runtime.ctx.emit('connection/reset')
    page.showPage()
    await settle()
    expect(page.requests).toHaveLength(0)
    expect(logs).toEqual(['page-refresh: the page booted without a readable boot graph, so no build is checked'])
  })

  it('runs in a context that offers no slot or locale service, so a page that failed to draw still reloads', async () => {
    const ctx = new Context()
    disposers.push(async () => { await ctx.fiber.dispose() })
    ctx.provide('connection', connectionService().service as never)
    const page = new FakePage()
    await ctx.plugin({
      inject,
      apply: (pluginCtx: Context) => {
        installPageRefresh(pluginCtx, { browser: page, settings: DEFAULTS, banners: createBannerStore(), log: () => {} })
      },
    }).await()
    ctx.emit('connection/reset')
    await settle()
    page.lastRequest().answer({ body: NEWER })
    await settle()
    expect(page.reloads).toBe(1)
  })
})

describe('the connection notices', () => {
  it('follow the connection service where configured', async () => {
    const { page, banners, connection } = await bench()
    connection.state.set('connected')
    connection.state.set('disconnected')
    page.advance(LOSS_NOTICE_DELAY_MS)
    expect(banners.getSnapshot().connection).toBe('lost')
  })

  it('stay silent where the deployment turned them off', async () => {
    const { page, banners, connection } = await bench({ disconnectNotice: false })
    connection.state.set('connected')
    connection.state.set('disconnected')
    page.advance(LOSS_NOTICE_DELAY_MS)
    expect(banners.getSnapshot().connection).toBeNull()
    expect(page.pendingTimers()).toBe(0)
  })
})

describe('fiber disposal (HMR safety)', () => {
  it('removes the banner and leaves nothing that can still reload or listen', async () => {
    const { runtime, page, handle, connection } = await bench({ reloadDelayMs: 0 })
    runtime.ctx.emit('connection/reset')
    await settle()
    const request = page.lastRequest()
    await handle.dispose()
    expect(runtime.slots.entries('shell.overlay')).toHaveLength(0)
    expect(request.signal.aborted).toBe(true)
    request.answer({ body: NEWER })
    runtime.ctx.emit('connection/reset')
    page.showPage()
    connection.state.set('connected')
    connection.state.set('disconnected')
    await settle()
    expect({ reloads: page.reloads, requests: page.requests.length, foreground: page.foreground.size })
      .toEqual({ reloads: 0, requests: 1, foreground: 0 })
    expect(page.pendingTimers()).toBe(0)
  })
})

describe('the plugin body', () => {
  it('waits for the connection service alone', () => {
    expect(inject).toEqual(['connection'])
  })

  it('reads the settings the served index carries and starts on the page\'s own globals', async () => {
    vi.stubGlobal('__DSH_PAGE_REFRESH_CONFIG__', DEFAULTS)
    vi.stubGlobal('__DSH_BOOT__', bootGraph([{ id: 'a', rev: '1' }]))
    const fetch = vi.fn(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetch)
    const runtime = await SlotTestRuntime.create()
    disposers.push(() => runtime.dispose())
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.ctx.provide('connection', connectionService().service as never)
    await runtime.mount({ inject, apply })
    expect(runtime.slots.entries('shell.overlay')).toHaveLength(0)
    await runtime.declare({ 'shell.overlay': { kind: 'list', scope: 'root' } })
    expect(runtime.slots.entries('shell.overlay')).toHaveLength(1)
    runtime.ctx.emit('connection/reset')
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]).toEqual([
      window.location.href.replace(/#.*$/u, ''),
      expect.objectContaining({ cache: 'no-store', redirect: 'manual', credentials: 'same-origin' }),
    ])
  })

  it('records why it checks nothing in a page without a readable boot graph', async () => {
    vi.stubGlobal('__DSH_PAGE_REFRESH_CONFIG__', DEFAULTS)
    vi.stubGlobal('__DSH_BOOT__', undefined)
    const ctx = new Context()
    disposers.push(async () => { await ctx.fiber.dispose() })
    ctx.provide('connection', connectionService().service as never)
    const debug = vi.spyOn(ctx.logger, 'debug')
    await ctx.plugin({ inject, apply }).await()
    expect(debug).toHaveBeenCalledWith('page-refresh: the page booted without a readable boot graph, so no build is checked')
  })

  it('fails the row when the served index carries no settings', async () => {
    const ctx = new Context()
    disposers.push(async () => { await ctx.fiber.dispose() })
    ctx.provide('connection', connectionService().service as never)
    await expect(ctx.plugin({ inject, apply }).await())
      .rejects.toThrow('page-refresh: the page carries no usable __DSH_PAGE_REFRESH_CONFIG__: undefined')
  })
})
