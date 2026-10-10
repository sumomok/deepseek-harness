// @vitest-environment jsdom
/**
 * The row's one installation of element-ui: that it lands on the Vue runtime
 * this package shares rather than a copy of its own, that it carries the two
 * values written dead here, that the select and the autocomplete it registers
 * keep their lists inside the block — and so inside the component entry —
 * rather than on the document body, and that a second call changes nothing.
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

  it('draws a select\'s dropdown inside the select, not on the document body', async () => {
    installElementUI()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const vm = new Vue({
      render: create => create('el-select', [
        create('el-option', { props: { value: 'hot', label: '核心' } }),
        create('el-option', { props: { value: 'edge', label: '接入' } }),
      ]),
    })
    vm.$mount(host)
    try {
      const select = vm.$el as HTMLElement
      select.querySelector('input.el-input__inner')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      // One turn for the open's own re-render and one for the popper it draws.
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      const dropdown = select.querySelector('.el-select-dropdown')
      // Where the list is drawn is what the acting tool's confine is about: an
      // option on `document.body` is outside the block that owns the select.
      expect(dropdown).not.toBeNull()
      expect(select.contains(dropdown)).toBe(true)
      expect((dropdown as Element).parentElement === document.body).toBe(false)
      expect(select.querySelectorAll('.el-select-dropdown__item').length).toBe(2)
    } finally {
      vm.$destroy()
      vm.$el.remove()
    }
  })

  it('draws an autocomplete\'s suggestions inside the autocomplete, not on the document body', async () => {
    installElementUI()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const vm = new Vue({
      render: create => create('el-autocomplete', {
        props: { fetchSuggestions: (_query: string, done: (suggestions: { value: string }[]) => void) => { done([{ value: '接入' }]) } },
      }),
    })
    vm.$mount(host)
    try {
      const autocomplete = vm.$el as HTMLElement
      const input = autocomplete.querySelector('input.el-input__inner') as HTMLInputElement
      // element-ui shows the panel while the field has focus and the block has
      // answered: focus, then the typed query the debounce waits out.
      input.dispatchEvent(new FocusEvent('focus'))
      input.value = '接入'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => { setTimeout(resolve, 350) })
      const panel = autocomplete.querySelector('.el-autocomplete-suggestion')
      // Where the panel is drawn is what the acting tool's confine is about: a
      // suggestion on `document.body` is outside the block that owns the field.
      expect(panel).not.toBeNull()
      expect(autocomplete.contains(panel)).toBe(true)
      expect((panel as Element).parentElement === document.body).toBe(false)
      expect(autocomplete.querySelectorAll('.el-autocomplete-suggestion__list li').length).toBe(1)
    } finally {
      vm.$destroy()
      vm.$el.remove()
    }
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
