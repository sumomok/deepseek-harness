/**
 * Where the sidebar column and its foot band are on screen, for the
 * organization notice card.
 *
 * On a wide frame the card stands over the lower part of the sidebar column,
 * clear of the foot band (the footer actions and the identity row with its
 * settings button) and inside the column's width, so it covers neither the
 * row a member signs out or opens Settings from, nor the conversation's
 * composer beside the column. The card is a `shell.overlay` entry and does
 * not share the sidebar's element tree, so the sidebar measures the two
 * boxes ({@link useFootPlacementReport}) and publishes them through a
 * {@link FootPlacementSource} the card reads. The source holds `undefined`
 * while no sidebar is mounted, which on a narrow frame is whenever its drawer
 * is closed; the narrow card is placed under the drawer button instead and
 * reads nothing from it.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/foot-placement
 */
import { useLayoutEffect, type RefObject } from 'react'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** The sidebar column's box and its foot band's top edge, in viewport pixels. */
export interface FootPlacement {
  /** The column's left edge. */
  left: number
  /** The column's width. */
  width: number
  /** The distance from the viewport's bottom edge up to the foot band's top edge. */
  bottom: number
}

/** The latest placement the sidebar measured, observable by the card. */
export interface FootPlacementSource extends HostObservable<FootPlacement | undefined> {
  /**
   * Record a measurement, notifying subscribers when any of its numbers moved.
   * @param placement - the measurement, or `undefined` once the sidebar unmounts.
   */
  publish(placement: FootPlacement | undefined): void
}

/**
 * Create an empty source.
 * @returns the source, holding `undefined` until the first publish.
 */
export function createFootPlacementSource(): FootPlacementSource {
  let current: FootPlacement | undefined
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    publish: (placement) => {
      if (placement === current) return
      if (placement !== undefined && current !== undefined && placement.left === current.left
        && placement.width === current.width && placement.bottom === current.bottom) return
      current = placement
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * Measure the column and its foot band.
 * @param column - the sidebar column element.
 * @param foot - the foot band element.
 * @param viewportHeight - the viewport's height.
 * @returns the placement.
 */
export function measureFootPlacement(column: Element, foot: Element, viewportHeight: number): FootPlacement {
  const columnBox = column.getBoundingClientRect()
  return { left: columnBox.left, width: columnBox.width, bottom: viewportHeight - foot.getBoundingClientRect().top }
}

/**
 * Report the column's placement while the component that holds both
 * elements is mounted: once at mount, whenever either element resizes or the
 * window does, and `undefined` at unmount.
 * @param column - ref to the sidebar column element.
 * @param foot - ref to the foot band element.
 * @param report - where each measurement goes.
 */
export function useFootPlacementReport(
  column: RefObject<HTMLElement | null>,
  foot: RefObject<HTMLElement | null>,
  report: (placement: FootPlacement | undefined) => void,
): void {
  useLayoutEffect(() => {
    const columnElement = column.current
    const footElement = foot.current
    /* v8 ignore next -- both refs are attached by layout-effect time: the column and its foot band render unconditionally. */
    if (columnElement === null || footElement === null) return
    const measure = (): void => { report(measureFootPlacement(columnElement, footElement, window.innerHeight)) }
    const observer = new ResizeObserver(measure)
    observer.observe(columnElement)
    observer.observe(footElement)
    window.addEventListener('resize', measure)
    measure()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      report(undefined)
    }
  }, [column, foot, report])
}
