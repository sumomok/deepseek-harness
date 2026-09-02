import { describe, expect, it } from 'vitest'
import { detectText } from '../src/text.ts'

describe('detectText', () => {
  it('decodes valid UTF-8, including multibyte code points', () => {
    expect(detectText(new TextEncoder().encode('hello 你好 🙂'))).toEqual({ text: 'hello 你好 🙂' })
  })

  it('decodes an empty file as empty text', () => {
    expect(detectText(new Uint8Array(0))).toEqual({ text: '' })
  })

  it('rejects a NUL byte anywhere in the file', () => {
    expect(() => detectText(new Uint8Array([0x68, 0x69, 0x00, 0x21]))).toThrow(
      expect.objectContaining({ name: 'AttachmentError', code: 'NOT_TEXT_FILE' }),
    )
  })

  it('rejects invalid UTF-8 caught by the fast probe pass', () => {
    // A lone continuation byte (0x80) never opens a valid UTF-8 sequence.
    expect(() => detectText(new Uint8Array([0x68, 0x69, 0x80, 0x21]))).toThrow(
      expect.objectContaining({ code: 'NOT_TEXT_FILE' }),
    )
  })

  it('rejects a multibyte sequence truncated at the very end of the file', () => {
    // '你' is E4 BD A0 in UTF-8; a lone leading byte at the end of a complete
    // file is genuinely invalid — unlike a probe window, nothing follows it.
    // sniffProbe's `stream: true` pass tolerates this (it cannot tell a real
    // file end from a probe cut), so this case only fails on the second,
    // non-streaming decode pass.
    const truncated = new TextEncoder().encode('你').subarray(0, 1)
    expect(() => detectText(truncated)).toThrow(expect.objectContaining({ code: 'NOT_TEXT_FILE' }))
  })

  it('rejects a common binary header', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(() => detectText(png)).toThrow(expect.objectContaining({ code: 'NOT_TEXT_FILE' }))
  })
})
