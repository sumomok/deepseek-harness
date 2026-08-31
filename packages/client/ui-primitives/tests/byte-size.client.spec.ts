import { describe, expect, it } from 'vitest'
import { attachmentSizeText } from '../src/byte-size.ts'

describe('attachmentSizeText', () => {
  it('renders megabytes without a trailing fraction unless one exists', () => {
    expect(attachmentSizeText(10 * 1024 * 1024)).toBe('10MB')
    expect(attachmentSizeText(2.5 * 1024 * 1024)).toBe('2.5MB')
  })
})
