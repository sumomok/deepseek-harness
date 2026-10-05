// @vitest-environment jsdom
/**
 * The settings opener seat and its source: the seat draws nothing, publishes
 * the opener the settings shell hands it while mounted and withdraws it on
 * unmount, and the source tells subscribers only about a different function.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { createSettingsOpenerSource, SettingsOpenerSeat } from '../src/client/settings-opener.ts'

afterEach(() => { cleanup() })

describe('createSettingsOpenerSource', () => {
  it('starts empty and notifies each subscriber once per different opener', () => {
    const source = createSettingsOpenerSource()
    expect(source.getSnapshot()).toBeUndefined()
    const listener = vi.fn()
    source.subscribe(listener)
    const opener = vi.fn()
    source.publish(opener)
    source.publish(opener)
    expect(source.getSnapshot()).toBe(opener)
    expect(listener).toHaveBeenCalledTimes(1)
    source.publish(undefined)
    expect(source.getSnapshot()).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('stops notifying a subscriber that unsubscribed', () => {
    const source = createSettingsOpenerSource()
    const listener = vi.fn()
    source.subscribe(listener)()
    source.publish(vi.fn())
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('SettingsOpenerSeat', () => {
  it('renders nothing, publishes the opener while mounted, republishes a new one, and withdraws it on unmount', () => {
    const source = createSettingsOpenerSource()
    const first = vi.fn()
    const view = render(<SettingsOpenerSeat openSection={first} publish={source.publish} />)
    expect(view.container.childNodes).toHaveLength(0)
    expect(source.getSnapshot()).toBe(first)
    const second = vi.fn()
    view.rerender(<SettingsOpenerSeat openSection={second} publish={source.publish} />)
    expect(source.getSnapshot()).toBe(second)
    view.unmount()
    expect(source.getSnapshot()).toBeUndefined()
  })
})
