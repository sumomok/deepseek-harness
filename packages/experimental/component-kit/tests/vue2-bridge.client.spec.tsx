// @vitest-environment jsdom
/**
 * The bridge on its own, against throwaway Vue components: what the host holds
 * after mount, that a React commit patches the live tree instead of rebuilding
 * it, that a commit carrying the same props and the same listener map reaches
 * Vue as nothing at all, that Vue's observer never reaches the record React
 * handed over, that a component's events arrive as ordinary calls, that hiding
 * the block closes the poppers element-ui put outside the host, and that
 * unmount tears the Vue instance down and hands the host back empty.
 *
 * The popper probes carry element-ui's component names and the instance
 * property each one closes on, rather than element-ui's own components: what is
 * pinned here is the sweep — which names it recognizes and how deep it walks —
 * and a real `el-select` would answer that question with a Popper layout jsdom
 * cannot do.
 */
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { defineComponent, h, ref } from '@deepseek-ai/dsh-experimental-vue2-echarts-poc/client'
import Vue, { type VueInstance } from '../src/client/vue-shim.ts'
import { VueBridge } from '../src/client/vue2-bridge.tsx'

afterEach(cleanup)

/** Throwaway component: a label from React, a counter Vue owns, and an event out. */
const Probe = defineComponent({
  name: 'BridgeProbe',
  props: {
    label: { type: String, required: true },
    rows: { type: Array, default: () => [] },
  },
  setup(props, { emit }) {
    const count = ref(0)
    return () => h('button', {
      attrs: { type: 'button', 'data-testid': 'probe' },
      on: {
        click: () => {
          count.value += 1
          emit('bump', count.value)
        },
      },
    }, `${props.label} ${String(count.value)}`)
  },
})

/** Stands in for `el-tooltip`: a popper element-ui appends outside the host. */
const TooltipProbe = defineComponent({
  name: 'ElTooltip',
  data: () => ({ showPopper: true }),
  render: () => h('span', { attrs: { 'data-testid': 'tooltip' } }, 'tooltip'),
})

/** A child with no popper of its own, which the sweep must leave alone. */
const PlainProbe = defineComponent({
  name: 'PlainChild',
  data: () => ({ showPopper: true }),
  render: () => h('span', { attrs: { 'data-testid': 'plain' } }, 'plain'),
})

/** A component that declares no name at all, which the sweep must also survive. */
const AnonymousProbe = defineComponent({
  data: () => ({ showPopper: true }),
  render: () => h('span', { attrs: { 'data-testid': 'anonymous' } }, 'anonymous'),
})

/** Stands in for `el-date-picker`: a popper the filter bar's date attributes open. */
const DatePickerProbe = defineComponent({
  name: 'ElDatePicker',
  data: () => ({ pickerVisible: true }),
  render: () => h('span', { attrs: { 'data-testid': 'picker' } }, 'picker'),
})

/** Stands in for `el-select`: a focusable control whose dropdown escapes the host. */
const SelectProbe = defineComponent({
  name: 'ElSelect',
  data: () => ({ visible: true }),
  render: create => create('span', [
    create('input', { attrs: { 'data-testid': 'select-input' } }),
    create(TooltipProbe),
    create(DatePickerProbe),
    create(PlainProbe),
    create(AnonymousProbe),
  ]),
})

/** Root probe holding the popper tree, so the sweep has to walk past one level. */
const PopperProbe = defineComponent({
  name: 'PopperProbe',
  render: create => create('div', [create(SelectProbe)]),
})

/** The instances the sweep reaches, by declared component name — unnamed ones under `''`. */
function instancesByName(host: Element | null): Map<string, Record<string, unknown>> {
  const root = (host?.firstElementChild as { __vue__?: Record<string, unknown> } | null)?.__vue__
  const found = new Map<string, Record<string, unknown>>()
  const walk = (instance: Record<string, unknown>): void => {
    const options = instance.$options as { name?: string }
    found.set(options.name ?? '', instance)
    for (const child of instance.$children as Record<string, unknown>[]) walk(child)
  }
  if (root !== undefined) walk(root)
  return found
}

const probe = (): HTMLElement => screen.getByTestId('probe')

/**
 * Count the renders every instance of the shared runtime performs.
 *
 * `_update` is the one call a Vue 2 instance makes per render, root and child
 * alike, so a count taken across a React commit says whether that commit
 * reached Vue at all — which no assertion over the rendered DOM can, since a
 * root that re-rendered for nothing draws exactly what it drew before.
 * @returns the spy, which the caller restores.
 */
function countRenders() {
  return vi.spyOn(Vue.prototype as unknown as { _update: (...args: never[]) => void }, '_update')
}

describe('VueBridge', () => {
  it('mounts the Vue tree inside the host it renders', () => {
    const { container } = render(<VueBridge component={Probe} props={{ label: 'first' }} />)
    const host = container.firstElementChild
    expect(host?.tagName).toBe('SPAN')
    // $mount replaced the placeholder, so the host holds the component's root.
    expect(host?.childElementCount).toBe(1)
    expect(probe().textContent).toBe('first 0')
  })

  it('patches the live tree on a React commit instead of rebuilding it', async () => {
    const { rerender } = render(<VueBridge component={Probe} props={{ label: 'first' }} />)
    fireEvent.click(probe())
    await Promise.resolve()
    const mounted = probe()
    expect(mounted.textContent).toBe('first 1')

    rerender(<VueBridge component={Probe} props={{ label: 'second' }} />)
    await Promise.resolve()
    // Same element, new label, and the Vue-internal counter still at 1: the
    // reactive record was reassigned, not the root rebuilt.
    expect(probe()).toBe(mounted)
    expect(mounted.textContent).toBe('second 1')
  })

  it('leaves the Vue root alone on a React commit that changed neither the props nor the listeners', async () => {
    const props = { label: 'first' }
    const on = { bump: (): void => {} }
    const { rerender } = render(<VueBridge component={Probe} props={props} on={on} />)
    await Promise.resolve()

    const renders = countRenders()
    rerender(<VueBridge component={Probe} props={props} on={on} />)
    await Promise.resolve()
    // The bridge copies the listener map rather than freezing it, so a fresh
    // copy handed to Vue on every commit would re-render the whole tree below
    // this root for every unrelated commit the placement package makes.
    expect(renders).not.toHaveBeenCalled()
    renders.mockRestore()
  })

  it('adopts a listener map the caller replaced', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const props = { label: 'first' }
    const { rerender } = render(<VueBridge component={Probe} props={props} on={{ bump: first }} />)
    rerender(<VueBridge component={Probe} props={props} on={{ bump: second }} />)
    await Promise.resolve()
    fireEvent.click(probe())
    await Promise.resolve()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith(1)
  })

  it('delivers the component events the caller listens for', async () => {
    const onBump = vi.fn()
    render(<VueBridge component={Probe} props={{ label: 'first' }} on={{ bump: onBump }} />)
    fireEvent.click(probe())
    await Promise.resolve()
    expect(onBump).toHaveBeenCalledWith(1)
  })

  it('leaves the caller\'s data unobserved, however deep it goes', () => {
    const rows = [{ label: 'first' }]
    const props = { label: 'first', rows }
    const bump = (): void => {}
    const handlers = { bump }
    render(<VueBridge component={Probe} props={props} on={handlers} />)
    // Vue's observer stamps `__ob__` on every object it walks and swaps an
    // observed array's prototype for a patched one; a frozen value is not
    // extensible, so the walk never starts.
    expect(Object.hasOwn(props, '__ob__')).toBe(false)
    expect(Object.hasOwn(rows, '__ob__')).toBe(false)
    expect(Object.getPrototypeOf(rows)).toBe(Array.prototype)
    expect(Object.hasOwn(rows[0] as object, '__ob__')).toBe(false)
    // The listener map cannot be frozen — Vue rewrites the object it is given,
    // installing an invoker over each handler — so the bridge hands it a copy,
    // and both the observation and the rewrite land there instead.
    expect(Object.hasOwn(handlers, '__ob__')).toBe(false)
    expect(handlers.bump).toBe(bump)
  })

  it('closes the poppers a hidden block opened outside its host', async () => {
    const { container, rerender } = render(<VueBridge component={PopperProbe} props={{}} />)
    const instances = instancesByName(container.firstElementChild)
    expect(instances.get('ElSelect')?.visible).toBe(true)
    expect(instances.get('ElTooltip')?.showPopper).toBe(true)
    expect(instances.get('ElDatePicker')?.pickerVisible).toBe(true)

    rerender(<VueBridge component={PopperProbe} props={{}} visible={false} />)
    await Promise.resolve()
    expect(instances.get('ElSelect')?.visible).toBe(false)
    // Two levels down from the root: the sweep walks the whole tree.
    expect(instances.get('ElTooltip')?.showPopper).toBe(false)
    expect(instances.get('ElDatePicker')?.pickerVisible).toBe(false)
    // A component the table does not name keeps whatever state it had, whether
    // it declared a name of its own or none.
    expect(instances.get('PlainChild')?.showPopper).toBe(true)
    expect(instances.get('')?.showPopper).toBe(true)
  })

  it('drops the focus a hidden block still held', () => {
    const { rerender } = render(<VueBridge component={PopperProbe} props={{}} />)
    const input = screen.getByTestId('select-input')
    input.focus()
    expect(document.activeElement).toBe(input)

    rerender(<VueBridge component={PopperProbe} props={{}} visible={false} />)
    // A focused select input reopens its dropdown on the next keystroke.
    expect(document.activeElement).not.toBe(input)
  })

  it('leaves focus outside its own host alone', () => {
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    const { rerender } = render(<VueBridge component={PopperProbe} props={{}} />)
    outside.focus()

    rerender(<VueBridge component={PopperProbe} props={{}} visible={false} />)
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('closes nothing while the block is on screen', async () => {
    const { container, rerender } = render(<VueBridge component={PopperProbe} props={{}} />)
    const instances = instancesByName(container.firstElementChild)
    rerender(<VueBridge component={PopperProbe} props={{}} visible />)
    await Promise.resolve()
    expect(instances.get('ElSelect')?.visible).toBe(true)
  })

  it('publishes the mounted component, not the root it owns, and takes it back on unmount', () => {
    const instanceRef = createRef<VueInstance | null>() as { current: VueInstance | null }
    const { unmount } = render(
      <VueBridge component={Probe} props={{ label: 'first' }} instanceRef={instanceRef} />,
    )
    // The root is this bridge's own scaffolding; what a renderer calls a method
    // on is the component it asked for.
    expect(instanceRef.current?.$options.name).toBe('BridgeProbe')
    unmount()
    expect(instanceRef.current).toBeNull()
  })

  it('tears the Vue instance down on unmount, not just its DOM', () => {
    const destroyed = vi.fn()
    const Perishable = defineComponent({
      name: 'Perishable',
      beforeDestroy: destroyed,
      render: () => h('span', 'perishable'),
    })
    const { unmount } = render(<VueBridge component={Perishable} props={{}} />)
    unmount()
    // Removing the mounted element would empty the host on its own; only
    // $destroy stops the root's watchers and runs the tree's own teardown.
    expect(destroyed).toHaveBeenCalledOnce()
  })

  it('empties its host on unmount', () => {
    const { container, unmount } = render(<VueBridge component={Probe} props={{ label: 'first' }} />)
    const host = container.firstElementChild
    expect(host?.childElementCount).toBe(1)
    unmount()
    // $destroy leaves the DOM alone, so the bridge removes the mounted element.
    expect(host?.childElementCount).toBe(0)
  })
})
