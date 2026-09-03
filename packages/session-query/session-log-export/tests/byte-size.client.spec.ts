import { describe, expect, it } from 'vitest'
import { byteSizeText } from '../src/client/byte-size.ts'

describe('byteSizeText', () => {
  it('picks bytes, kilobytes, or megabytes by magnitude, dropping a trailing fraction unless one exists', () => {
    expect(byteSizeText(0)).toBe('0 B')
    expect(byteSizeText(11)).toBe('11 B')
    expect(byteSizeText(1023)).toBe('1023 B')
    expect(byteSizeText(1024)).toBe('1 KB')
    expect(byteSizeText(512 * 1024)).toBe('512 KB')
    expect(byteSizeText(1024 * 1024 - 1)).toBe('1024 KB')
    expect(byteSizeText(10 * 1024 * 1024)).toBe('10 MB')
    expect(byteSizeText(2.5 * 1024 * 1024)).toBe('2.5 MB')
  })
})
