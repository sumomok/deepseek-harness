// @vitest-environment jsdom
/**
 * Where the sidebar column and its foot band are: the source the notice card
 * reads, the measurement, and the report a mounted column makes at mount, on
 * a resize of either element or the window, and at unmount.
 */
import { cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createFootPlacementSource, measureFootPlacement, useFootPlacementReport, type FootPlacement,
} from '../src/client/foot-placement.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/**
 * An element whose box is the given rectangle.
 * @param rect - the box.
 * @returns the element.
 */
function boxed(rect: { left: number; top: number; width: number; height: number }): HTMLElement {
  const element = document.createElement('div')
  element.getBoundingClientRect = () => DOMRect.fromRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
  return element
}

describe('createFootPlacementSource', () => {
  it('holds nothing until the first publish, then tells subscribers of each change', () => {
    const source = createFootPlacementSource()
    const changed = vi.fn()
    const unsubscribe = source.subscribe(changed)
    expect(source.getSnapshot()).toBeUndefined()
    const first: FootPlacement = { left: 0, width: 210, bottom: 60 }
    source.publish(first)
    expect(source.getSnapshot()).toBe(first)
    source.publish(first)
    source.publish({ ...first })
    expect(changed).toHaveBeenCalledTimes(1)
    for (const moved of [{ ...first, left: 1 }, { ...first, left: 1, width: 200 }, { ...first, left: 1, width: 200, bottom: 70 }]) {
      source.publish(moved)
    }
    expect(changed).toHaveBeenCalledTimes(4)
    source.publish(undefined)
    expect(source.getSnapshot()).toBeUndefined()
    source.publish(undefined)
    expect(changed).toHaveBeenCalledTimes(5)
    unsubscribe()
    source.publish(first)
    expect(changed).toHaveBeenCalledTimes(5)
  })
})

describe('measureFootPlacement', () => {
  it('reads the column\'s left edge and width, and the foot band\'s top edge from the viewport\'s bottom', () => {
    const column = boxed({ left: 4, top: 0, width: 210, height: 1000 })
    const foot = boxed({ left: 16, top: 900, width: 186, height: 90 })
    expect(measureFootPlacement(column, foot, 1000)).toEqual({ left: 4, width: 210, bottom: 100 })
  })
})

/**
 * A column and its foot band that report where they are.
 * @param props.report - where each measurement goes.
 * @returns the two elements.
 */
function Column({ report }: { report: (placement: FootPlacement | undefined) => void }) {
  const column = useRef<HTMLDivElement>(null)
  const foot = useRef<HTMLDivElement>(null)
  useFootPlacementReport(column, foot, report)
  return (
    <div ref={column} data-testid="column">
      <div ref={foot} data-testid="foot" />
    </div>
  )
}

describe('useFootPlacementReport', () => {
  it('reports at mount, on either element resizing and on the window resizing, and nothing at unmount', () => {
    const observed: Element[] = []
    let resized: (() => void) | undefined
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized = callback }
      observe(target: Element): void { observed.push(target) }
      unobserve(): void {}
      disconnect(): void { disconnect() }
    })
    const report = vi.fn()
    const view = render(<Column report={report} />)
    expect(observed.map(element => element.getAttribute('data-testid'))).toEqual(['column', 'foot'])
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenLastCalledWith({ left: 0, width: 0, bottom: window.innerHeight })
    resized?.()
    window.dispatchEvent(new Event('resize'))
    expect(report).toHaveBeenCalledTimes(3)
    view.unmount()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(report).toHaveBeenLastCalledWith(undefined)
    window.dispatchEvent(new Event('resize'))
    expect(report).toHaveBeenCalledTimes(4)
  })
})
