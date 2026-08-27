import { describe, expect, it } from 'vitest'
import { PROBE_BYTES, sniffProbe } from '../src/sniff.ts'

describe('sniffProbe', () => {
  it('accepts valid UTF-8, including multibyte code points', () => {
    const probe = new TextEncoder().encode('hello 你好 🙂')
    expect(sniffProbe(probe)).toBe('text')
  })

  it('rejects a NUL byte without even attempting a decode', () => {
    expect(sniffProbe(new Uint8Array([0x68, 0x69, 0x00, 0x21]))).toBe('binary')
  })

  it('rejects invalid UTF-8', () => {
    // A lone continuation byte (0x80) never opens a valid UTF-8 sequence.
    expect(sniffProbe(new Uint8Array([0x68, 0x69, 0x80, 0x21]))).toBe('binary')
  })

  it('treats an empty probe as text: no bytes prove otherwise', () => {
    expect(sniffProbe(new Uint8Array(0))).toBe('text')
  })

  it('does not fatal on a multibyte code point split at the probe boundary', () => {
    // '你' is E4 BD A0 in UTF-8; cutting after the first byte leaves an
    // incomplete sequence at the very edge of the probe. `stream: true`
    // holds it back instead of rejecting it as invalid.
    const full = new TextEncoder().encode('你')
    expect(sniffProbe(full.subarray(0, 1))).toBe('text')
    expect(sniffProbe(full.subarray(0, 2))).toBe('text')
  })

  it('sizes the probe window at 8192 bytes, a protocol constant', () => {
    expect(PROBE_BYTES).toBe(8192)
  })
})
