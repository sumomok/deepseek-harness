/**
 * The reconnect backoff schedule for the notification streams. The rest of
 * `notifications.ts` reaches into `electron` (`app`, `Notification`) the way
 * every other Electron-facing module in this package does, and is exercised
 * by the real-process check instead — see `dsh-server.log` excerpts in the
 * PR description, not a unit test here.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { reconnectDelayMs } from '../src/notifications.ts'

describe('reconnectDelayMs', () => {
  it('starts at the base delay and doubles each consecutive attempt', () => {
    expect(reconnectDelayMs(1)).toBe(3_000)
    expect(reconnectDelayMs(2)).toBe(6_000)
    expect(reconnectDelayMs(3)).toBe(12_000)
    expect(reconnectDelayMs(4)).toBe(24_000)
    expect(reconnectDelayMs(5)).toBe(48_000)
  })

  it('caps at 60s and stays capped for every attempt after that', () => {
    expect(reconnectDelayMs(6)).toBe(60_000)
    expect(reconnectDelayMs(7)).toBe(60_000)
    expect(reconnectDelayMs(20)).toBe(60_000)
  })
})
