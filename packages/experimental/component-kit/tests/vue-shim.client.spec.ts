// @vitest-environment jsdom
/**
 * The row's Vue 2.7 runtime: that the shim hands back the very object the
 * supplying row exports rather than a second copy, and that nothing puts a Vue
 * on the page for element-ui to find.
 *
 * The direct import is also what keeps the shim inside both the coverage lane
 * and the unused-file check: everything else that imports it is `.tsx`.
 */
import { describe, expect, it } from 'vitest'
import { Vue as SuppliedVue } from '@deepseek-ai/dsh-experimental-vue2-echarts-poc/client'
import Vue from '../src/client/vue-shim.ts'

describe('component-kit Vue runtime', () => {
  it('re-exports the runtime the supplying row owns rather than a copy of its own', () => {
    expect(Vue).toBe(SuppliedVue)
  })

  it('carries a working Vue 2 runtime, not just a constructor identity', () => {
    const vm = new Vue({ render: create => create('p', 'shim') })
    vm.$mount(document.createElement('div'))
    expect(vm.$el.textContent).toBe('shim')
    vm.$destroy()
  })

  it('puts no Vue on the page', () => {
    // element-ui's UMD build installs itself onto `window.Vue` when it finds
    // one, which would register its components on a runtime this row does not
    // own — reactivity then fails with no error and no warning.
    expect((globalThis as Record<string, unknown>).Vue).toBeUndefined()
  })
})
