// @vitest-environment jsdom
/**
 * The row's one installation of element-ui: that it lands on the Vue runtime
 * this package shares rather than a copy of its own, that it carries the two
 * values written dead here, and that a second call changes nothing.
 */
import { describe, expect, it, vi } from 'vitest'
import { Vue as SuppliedVue } from '@deepseek-ai/dsh-experimental-vue2-echarts-poc/client'
import Vue from '../src/client/vue-shim.ts'
import { installElementUI } from '../src/client/element-ui.ts'

/** element-ui stamps its installation options onto the runtime's prototype. */
interface ElementDefaults {
  /** Default control size for every component it registered. */
  readonly size: string
  /** Base z-index its poppers count up from. */
  readonly zIndex: number
}

describe('installElementUI', () => {
  it('configures element-ui on the shared runtime, under the harness approval modal', () => {
    installElementUI()
    // Own property of the shared prototype, not of a second Vue: a popper
    // opened by a block must sit under the harness chrome (1100) and under the
    // approval modal (1000), which element-ui's own default of 2000 does not.
    const shared = SuppliedVue.prototype as Record<string, unknown>
    expect(Object.hasOwn(shared, '$ELEMENT')).toBe(true)
    expect(shared.$ELEMENT as ElementDefaults).toEqual({ size: 'small', zIndex: 300 })
  })

  it('registers element-ui components on that runtime', () => {
    installElementUI()
    const vm = new Vue({ render: create => create('el-button', 'ok') })
    vm.$mount(document.createElement('div'))
    expect(vm.$el.className).toContain('el-button')
    vm.$destroy()
  })

  it('does not install a second time', () => {
    installElementUI()
    // A second installation would overwrite `$ELEMENT` and reset the popper
    // z-index counter underneath the poppers the first one already opened.
    const use = vi.spyOn(Vue, 'use')
    installElementUI()
    expect(use).not.toHaveBeenCalled()
    use.mockRestore()
  })

  it('leaves no Vue on the page for element-ui to find', () => {
    installElementUI()
    expect((globalThis as Record<string, unknown>).Vue).toBeUndefined()
  })
})
