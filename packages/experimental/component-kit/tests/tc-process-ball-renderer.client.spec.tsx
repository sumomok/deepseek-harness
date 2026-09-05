// @vitest-environment jsdom
/**
 * `el.metric`: that the vendored ball draws the number, the caption, the size
 * and the three colors a block carries, and that a block that goes away in the
 * middle of the fill animation leaves no timer behind.
 *
 * The timer is the part worth a test of its own. The component animates from
 * the number it last drew to the new one on a chain of `setTimeout` calls, each
 * scheduling the next; the vendored build stops that chain in `beforeDestroy`,
 * and what this pins is that the bridge's teardown reaches it.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { installElementUI } from '../src/client/element-ui.ts'
import { TcProcessBallRenderer } from '../src/client/TcProcessBallRenderer.tsx'
import { en } from '../src/client/locales.ts'
import type { ComponentRendererProps } from '../src/client/renderer.ts'

beforeAll(installElementUI)
afterEach(cleanup)

const t: ComponentRendererProps['t'] = makeTranslate(en)

/** Draw one metric block over the properties under test. */
function draw(props: Record<string, unknown>): ReturnType<typeof render> {
  return render(
    <TcProcessBallRenderer nodeId="node-1" props={props} state="idle" onAction={vi.fn()} t={t} />,
  )
}

/** The two lines drawn on the ball, in order. */
function lines(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.text-content p')].map(line => line.textContent ?? '')
}

describe('el.metric', () => {
  it('draws the number and the caption a block carries', () => {
    const { container } = draw({ process: 72, text: '完成度' })
    const block = container.querySelector('[data-component-block="el.metric"]')
    expect(block?.getAttribute('data-component-node')).toBe('node-1')
    expect(lines(container)).toEqual(['72', '完成度'])
  })

  it('takes the size and the three colors the block declares', () => {
    const { container } = draw({
      process: 40,
      size: 160,
      background: '#123456',
      borderColor: 'rgb(1, 2, 3)',
      pointColor: '#abc',
    })
    const ball = container.querySelector<HTMLElement>('.ball')
    expect(ball?.style.width).toBe('160px')
    expect(ball?.style.boxShadow).toContain('rgb(1, 2, 3)')
    expect(container.querySelector<HTMLElement>('.point-1')?.style.backgroundColor).toBe('rgb(170, 187, 204)')
  })

  it('leaves an absent option to the component\'s own default', () => {
    const { container } = draw({ process: 40 })
    expect(container.querySelector<HTMLElement>('.ball')?.style.width).toBe('100px')
    expect(container.querySelectorAll('.point-content span')).toHaveLength(5)
  })

  it('drops the dots when the block says not to draw them', () => {
    const { container } = draw({ process: 40, isPointShow: false })
    expect(container.querySelector('.point-content')).toBeNull()
  })

  it('draws an empty ball when the block carries nothing the component can use', () => {
    const { container } = draw({
      process: 'seventy',
      size: Number.NaN,
      text: '',
      background: 42,
      borderColor: null,
      pointColor: undefined,
      isPointShow: 'yes',
    })
    expect(lines(container)).toEqual(['0', ''])
    expect(container.querySelector<HTMLElement>('.ball')?.style.width).toBe('100px')
  })

  it('leaves no timer behind when the block goes away mid-animation', async () => {
    vi.useFakeTimers()
    try {
      const view = draw({ process: 0 })
      view.rerender(
        <TcProcessBallRenderer nodeId="node-1" props={{ process: 90 }} state="idle" onAction={vi.fn()} t={t} />,
      )
      // Vue's own scheduler runs on a microtask, which is where the component
      // notices the new number and starts the chain.
      await Promise.resolve()
      vi.advanceTimersByTime(20)
      // The chain schedules its next step from inside the previous one, so a
      // block torn down halfway leaves one live timer unless the component's
      // own teardown ran.
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      view.unmount()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
