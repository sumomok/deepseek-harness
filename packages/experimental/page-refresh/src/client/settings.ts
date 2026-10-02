/**
 * Read this plugin's settings out of the page global the node half assigns.
 * The value crossed a process boundary inside the served index, so its fields
 * are checked here rather than trusted from the node half's type.
 * @module @deepseek-ai/dsh-experimental-page-refresh/src/client/settings
 */

import type { Config } from '../index.ts'
import { MAX_STUCK_AFTER_SECONDS, MAX_TIMER_DELAY_MS, PAGE_REFRESH_CONFIG_GLOBAL } from '../config.ts'

/**
 * Whether a value is an integer within an inclusive range.
 * @param value - the value to check.
 * @param min - the smallest accepted value.
 * @param max - the largest accepted value.
 * @returns `true` for an integer from `min` to `max`.
 */
function integerWithin(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

/**
 * Validate the settings the served index carries.
 * @param value - the page global's value, however malformed.
 * @returns the settings.
 * @throws {Error} naming the global and the first field that is missing or out
 * of range. The error fails this plugin's activation, and the web client then
 * fails the whole page's boot rather than run on settings the deployment did not
 * write. A missing global means the row's node half did not activate.
 */
export function readPageRefreshSettings(value: unknown): Config {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`page-refresh: the page carries no usable ${PAGE_REFRESH_CONFIG_GLOBAL}: ${String(value)}. `
      + 'The row\'s node half publishes it when it activates; a missing value means it did not, and the host\'s startup warning names why.')
  }
  const field = (key: keyof Config): unknown => Reflect.get(value, key)
  const checkOnVisible = field('checkOnVisible')
  const reloadDelayMs = field('reloadDelayMs')
  const disconnectNotice = field('disconnectNotice')
  const stuckAfterSeconds = field('stuckAfterSeconds')
  const unusable = (key: keyof Config, found: unknown): Error =>
    new Error(`page-refresh: ${PAGE_REFRESH_CONFIG_GLOBAL}.${key} is unusable: ${JSON.stringify(found)}`)
  if (typeof checkOnVisible !== 'boolean') throw unusable('checkOnVisible', checkOnVisible)
  if (!integerWithin(reloadDelayMs, 0, MAX_TIMER_DELAY_MS)) throw unusable('reloadDelayMs', reloadDelayMs)
  if (typeof disconnectNotice !== 'boolean') throw unusable('disconnectNotice', disconnectNotice)
  if (!integerWithin(stuckAfterSeconds, 1, MAX_STUCK_AFTER_SECONDS)) throw unusable('stuckAfterSeconds', stuckAfterSeconds)
  return { checkOnVisible, reloadDelayMs, disconnectNotice, stuckAfterSeconds }
}
