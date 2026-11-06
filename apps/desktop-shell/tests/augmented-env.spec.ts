/**
 * PATH augmentation for the embedded server: which interactive locations the
 * desktop shell adds to a GUI-launched process, and what it leaves alone.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { augmentedEnv } from '../src/server.ts'

/** The interactive locations augmentedEnv appends, in the order it appends them. */
const STANDARD = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

const realPlatform = process.platform

/**
 * Run `body` with `process.platform` reporting `platform`. Both branches have
 * to be reachable from either kind of host, so no assertion here depends on
 * where the suite runs.
 * @param platform - what process.platform reports inside `body`.
 * @param body - the call to make under that platform.
 * @returns whatever `body` returned.
 */
function withPlatform<T>(platform: NodeJS.Platform, body: () => T): T {
  Object.defineProperty(process, 'platform', { value: platform, writable: false, enumerable: true, configurable: true })
  try {
    return body()
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, writable: false, enumerable: true, configurable: true })
  }
}

describe('augmentedEnv on POSIX', () => {
  it('appends the missing standard locations behind the inherited PATH', () => {
    const result = withPlatform('darwin', () => augmentedEnv({ PATH: '/home/me/bin:/usr/local/bin' }))
    expect(result.PATH).toBe(['/home/me/bin', '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'))
  })

  it('leaves a PATH that already holds every standard location unchanged', () => {
    const path = STANDARD.join(':')
    expect(withPlatform('linux', () => augmentedEnv({ PATH: path })).PATH).toBe(path)
  })

  it('does not repeat a standard location the inherited PATH already lists', () => {
    const result = withPlatform('darwin', () => augmentedEnv({ PATH: '/usr/bin' }))
    expect(result.PATH?.split(':').filter(part => part === '/usr/bin')).toEqual(['/usr/bin'])
    expect(result.PATH).toBe(['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin', '/bin', '/usr/sbin', '/sbin'].join(':'))
  })

  it('yields exactly the standard locations when PATH is unset or empty', () => {
    expect(withPlatform('darwin', () => augmentedEnv({})).PATH).toBe(STANDARD.join(':'))
    expect(withPlatform('darwin', () => augmentedEnv({ PATH: '' })).PATH).toBe(STANDARD.join(':'))
  })

  it('drops the empty segments of a malformed PATH', () => {
    const result = withPlatform('linux', () => augmentedEnv({ PATH: '/a::/b:' }))
    expect(result.PATH).toBe(['/a', '/b', ...STANDARD].join(':'))
  })

  it('carries the rest of the environment across without mutating the input', () => {
    const base = { HOME: '/home/me', PATH: '/home/me/bin' }
    const result = withPlatform('darwin', () => augmentedEnv(base))
    expect(result.HOME).toBe('/home/me')
    expect(base.PATH).toBe('/home/me/bin')
  })
})

describe('augmentedEnv on Windows', () => {
  it('copies the environment without touching PATH', () => {
    const base = { PATH: 'C:\\Windows\\system32', USERPROFILE: 'C:\\Users\\me' }
    const result = withPlatform('win32', () => augmentedEnv(base))
    expect(result).toEqual(base)
    expect(result).not.toBe(base)
  })

  it('does not invent a PATH when the environment has none', () => {
    expect(withPlatform('win32', () => augmentedEnv({ USERPROFILE: 'C:\\Users\\me' })).PATH).toBeUndefined()
  })
})
