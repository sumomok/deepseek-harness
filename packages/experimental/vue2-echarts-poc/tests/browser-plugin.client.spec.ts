/**
 * vue2-echarts-poc plugin halves: the browser entry's dictionary registration
 * against the real locale plugin (with fiber teardown proving removal — HMR
 * safety), the browser entry's Vue 2.7 re-exports, and the inert node entry.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  getCurrentInstance as getCurrentInstanceFromVue,
  inject as injectFromVue,
  isReactive,
  markRaw as markRawFromVue,
  reactive,
} from 'vue'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, getCurrentInstance, inject, markRaw, Vue, vueInject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
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
  ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  // These specs assert the shipped Chinese copy. There is no jsdom `window` in
  // this lane, so browser-language detection never runs and the locale comes
  // from FALLBACK_LOCALE (en): state the asserted locale explicitly.
  ctx.locale.setLocale('zh')
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber }
}

describe('vue2-echarts-poc browser half', () => {
  it('declares the one service it binds and registers no slot', () => {
    expect(inject).toEqual(['locale'])
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    const { ctx, fiber } = await bench()
    const translate = ctx.locale.bind(NS)
    expect(translate('panel.title')).toBe(zh['panel.title'])
    ctx.locale.setLocale('en')
    expect(translate('panel.title')).toBe(en['panel.title'])

    // Withdrawn dictionaries leave the key unresolved rather than translated.
    await fiber.dispose()
    expect(translate('panel.title')).not.toBe(en['panel.title'])
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('vue2-echarts-poc browser Vue re-exports', () => {
  it('re-exports the functions of the Vue runtime the bundle carries', () => {
    expect(getCurrentInstance).toBe(getCurrentInstanceFromVue)
    expect(markRaw).toBe(markRawFromVue)
    expect(vueInject).toBe(injectFromVue)
  })

  it('gives a component setup its instance and keeps a raw object out of reactive state', () => {
    const seen: { instance?: ReturnType<typeof getCurrentInstance>; plain?: object; raw?: object } = {}
    // Vue 2.7 runs `setup` while it constructs the instance, so this DOM-free
    // lane observes it without mounting.
    const vm = new Vue({
      setup() {
        seen.instance = getCurrentInstance()
        const state = reactive({ plain: { id: 1 }, raw: markRaw({ id: 2 }) })
        seen.plain = state.plain
        seen.raw = state.raw
      },
    })
    expect(seen.instance?.proxy).toBe(vm)
    expect(isReactive(seen.plain)).toBe(true)
    expect(isReactive(seen.raw)).toBe(false)
    vm.$destroy()
  })
})

describe('vue2-echarts-poc node half', () => {
  it('contributes no host behavior', () => {
    // The node half exists only so the plugin appears in the Loader tree.
    expect(applyNode).not.toThrow()
  })
})
