/**
 * Certificate eligibility from codesign's display, including sealed ad-hoc
 * bundles and unsuccessful probes. No platform signing tools run in these cases.
 * @module
 */

import type { SpawnSyncReturns } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { macAppHasCertificateSignature } from '../src/mac-signature.ts'

/** The external display operation; signature classification stays real. */
const probe = vi.hoisted(() => vi.fn<() => SpawnSyncReturns<string>>())

vi.mock('node:child_process', () => ({ spawnSync: probe }))

/** An input path only; these cases acquire no bundle on the host. */
const BUNDLE = '/Applications/DSH Desktop.app'

/**
 * A successful codesign display, which normally writes its details to stderr.
 * @param details - signature metadata to display.
 * @param stdout - output on stdout; empty by default.
 * @returns the completed local probe result.
 */
function displayed(details: string, stdout = ''): SpawnSyncReturns<string> {
  return { pid: 1, output: [null, stdout, details], stdout, stderr: details, status: 0, signal: null }
}

beforeEach(() => { probe.mockReset() })

describe('macOS certificate-backed update eligibility', () => {
  it('accepts a self-signed product certificate without a team identifier', () => {
    probe.mockReturnValue(displayed('Authority=DSH Desktop Signing\nTeamIdentifier=not set\nSealed Resources version=2\n'))

    expect(macAppHasCertificateSignature(BUNDLE)).toBe(true)
    expect(probe).toHaveBeenCalledOnce()
    expect(probe).toHaveBeenCalledWith('/usr/bin/codesign', ['--display', '--verbose=4', BUNDLE], { encoding: 'utf8' })
  })

  it('accepts certificate display metadata on stdout without a TeamIdentifier field', () => {
    probe.mockReturnValue(displayed('', 'Authority=DSH Desktop Signing\r\n'))
    expect(macAppHasCertificateSignature(BUNDLE)).toBe(true)
  })

  it.each([
    ['ad-hoc resource seal', 'Signature=adhoc\nSealed Resources version=2\n'],
    ['ad-hoc despite an authority line', 'Authority=DSH Desktop Signing\nSignature=adhoc\n'],
    ['ad-hoc with surrounding whitespace', 'Authority=DSH Desktop Signing\r\n Signature=adhoc \r\n'],
    ['team identifier alone', 'TeamIdentifier=EXAMPLE\nSealed Resources version=2\n'],
    ['empty certificate authority', 'Authority=   \nSignature size=4444\n'],
    ['resource seal alone', 'Sealed Resources version=2\n'],
    ['empty display', ''],
  ])('refuses %s', (_description, details) => {
    probe.mockReturnValue(displayed(details))
    expect(macAppHasCertificateSignature(BUNDLE)).toBe(false)
  })

  it('refuses a nonzero display even when partial output names an authority', () => {
    probe.mockReturnValue({ ...displayed('Authority=DSH Desktop Signing\n'), status: 1 })
    expect(macAppHasCertificateSignature(BUNDLE)).toBe(false)
  })

  it('refuses a terminated display even when partial output names an authority', () => {
    probe.mockReturnValue({ ...displayed('Authority=DSH Desktop Signing\n'), status: null, signal: 'SIGTERM' })
    expect(macAppHasCertificateSignature(BUNDLE)).toBe(false)
  })

  it('refuses an execution error even if a result also reports success', () => {
    probe.mockReturnValue({ ...displayed('Authority=DSH Desktop Signing\n'), error: new Error('codesign could not start') })
    expect(macAppHasCertificateSignature(BUNDLE)).toBe(false)
  })

  it('contains a thrown probe as unavailable certificate-backed updating', () => {
    probe.mockImplementation(() => { throw new Error('codesign could not start') })
    expect(macAppHasCertificateSignature(BUNDLE)).toBe(false)
  })
})
