import { describe, expect, it } from 'vitest'
import { attachmentSizeText } from '../src/byte-size.ts'

describe('attachmentSizeText', () => {
  it('picks bytes, kilobytes, or megabytes by magnitude, dropping a trailing fraction unless one exists', () => {
    expect(attachmentSizeText(0)).toBe('0 B')
    expect(attachmentSizeText(11)).toBe('11 B')
    expect(attachmentSizeText(1023)).toBe('1023 B')
    expect(attachmentSizeText(1024)).toBe('1 KB')
    expect(attachmentSizeText(512 * 1024)).toBe('512 KB')
    expect(attachmentSizeText(1024 * 1024 - 1)).toBe('1024 KB')
    expect(attachmentSizeText(10 * 1024 * 1024)).toBe('10 MB')
    expect(attachmentSizeText(2.5 * 1024 * 1024)).toBe('2.5 MB')
  })
})
