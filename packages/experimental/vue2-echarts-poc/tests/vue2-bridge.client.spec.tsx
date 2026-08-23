// @vitest-environment jsdom
/**
 * The Vue 2.7 bridge on its own, against a throwaway Vue component: what the
 * host contains after mount, that a React commit patches the live tree instead
 * of rebuilding it (same element, surviving Vue state), that callbacks cross as
 * ordinary props, and that unmount hands the host back empty.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { defineComponent, h, ref, type PropType } from 'vue'
import { Vue2Bridge } from '../src/client/vue2-bridge.tsx'

afterEach(cleanup)

/** Probe props: one string React owns and one callback it listens on. */
interface ProbeProps {
  label: string
  onBump: (count: number) => void
}

/** Throwaway Vue 2.7 component: a label from React and a counter Vue owns. */
const Probe = defineComponent({
  name: 'BridgeProbe',
  props: {
    label: { type: String, required: true },
    // Dropping the assertion leaves the prop typed as bare `Function`.
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion
    onBump: { type: Function as PropType<ProbeProps['onBump']>, required: true },
  },
  setup(props) {
    const count = ref(0)
    return () => h('button', {
      attrs: { type: 'button', 'data-testid': 'probe' },
      on: {
        click: () => {
          count.value += 1
          props.onBump(count.value)
        },
      },
    }, `${props.label} ${count.value}`)
  },
})

const probe = () => screen.getByTestId('probe')

describe('Vue2Bridge', () => {
  it('mounts the Vue tree inside the host it renders', () => {
    const { container } = render(
      <Vue2Bridge<ProbeProps> component={Probe} props={{ label: 'first', onBump: () => {} }} />,
    )
    const host = container.firstElementChild
    expect(host?.tagName).toBe('SPAN')
    // $mount replaced the placeholder, so the host holds the component's root.
    expect(host?.childElementCount).toBe(1)
    expect(probe().textContent).toBe('first 0')
  })

  it('patches the live tree on a React commit instead of rebuilding it', async () => {
    const { rerender } = render(
      <Vue2Bridge<ProbeProps> component={Probe} props={{ label: 'first', onBump: () => {} }} />,
    )
    fireEvent.click(probe())
    await Promise.resolve()
    const mounted = probe()
    expect(mounted.textContent).toBe('first 1')

    rerender(<Vue2Bridge<ProbeProps> component={Probe} props={{ label: 'second', onBump: () => {} }} />)
    await Promise.resolve()
    // Same element, new label, and the Vue-internal counter still at 1: the
    // root was reassigned, not rebuilt.
    expect(probe()).toBe(mounted)
    expect(mounted.textContent).toBe('second 1')
  })

  it('carries callbacks across as ordinary props', async () => {
    const onBump = vi.fn()
    render(<Vue2Bridge<ProbeProps> component={Probe} props={{ label: 'first', onBump }} />)
    fireEvent.click(probe())
    await Promise.resolve()
    expect(onBump).toHaveBeenCalledWith(1)
  })

  it('empties its host on unmount', () => {
    const { container, unmount } = render(
      <Vue2Bridge<ProbeProps> component={Probe} props={{ label: 'first', onBump: () => {} }} />,
    )
    const host = container.firstElementChild
    expect(host?.childElementCount).toBe(1)
    unmount()
    // $destroy leaves the DOM alone, so the bridge removes the mounted element.
    expect(host?.childElementCount).toBe(0)
  })

  it('leaves the record React handed it unobserved', () => {
    const props = { label: 'first', onBump: () => {} }
    render(<Vue2Bridge<ProbeProps> component={Probe} props={props} />)
    // Vue's observer stamps `__ob__` on every object it walks; the bridge copies
    // and freezes the record, so React's own object is never touched.
    expect(Object.hasOwn(props, '__ob__')).toBe(false)
  })
})
