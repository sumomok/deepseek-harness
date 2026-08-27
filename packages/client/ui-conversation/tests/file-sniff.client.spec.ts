// @vitest-environment jsdom
// Client-side text/binary pre-sniff: a UX-only pre-check ahead of the
// durable attachment seam's own authoritative NOT_TEXT_FILE validation.

import { describe, expect, it } from 'vitest'
import { partitionDroppedFiles, sniffIsText } from '../src/client/file-sniff.ts'

describe('sniffIsText', () => {
  it('accepts plain ASCII/UTF-8 text content', async () => {
    await expect(sniffIsText(new File(['hello world'], 'a.txt', { type: 'text/plain' }))).resolves.toBe(true)
    await expect(sniffIsText(new File(['你好，世界'], 'b.txt', { type: 'text/plain' }))).resolves.toBe(true)
  })

  it('rejects content carrying a NUL byte', async () => {
    const file = new File([Uint8Array.of(104, 105, 0, 106)], 'c.bin')
    await expect(sniffIsText(file)).resolves.toBe(false)
  })

  it('rejects content that fails strict UTF-8 decode', async () => {
    // 0x80 is a bare continuation byte: invalid as a lead byte anywhere.
    const file = new File([Uint8Array.of(0x80, 0x81)], 'd.bin')
    await expect(sniffIsText(file)).resolves.toBe(false)
  })

  it('rejects genuine binary magic bytes (PNG)', async () => {
    const file = new File([Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)], 'e.png')
    await expect(sniffIsText(file)).resolves.toBe(false)
  })

  it('treats an empty file as text: no evidence of binary content', async () => {
    await expect(sniffIsText(new File([], 'empty.txt'))).resolves.toBe(true)
  })

  it('only reads the leading probe window of a large file', async () => {
    // A NUL byte far past the 8192-byte probe window must not flip the verdict.
    const bytes = new Uint8Array(9000).fill(97) // 'a'
    bytes[8500] = 0
    await expect(sniffIsText(new File([bytes], 'f.txt'))).resolves.toBe(true)
  })
})

describe('partitionDroppedFiles', () => {
  it('splits a mixed batch, preserving order within each side', async () => {
    const text1 = new File(['one'], '1.txt')
    const binary = new File([Uint8Array.of(0x89, 0x50, 0x4e, 0x47)], '2.png')
    const text2 = new File(['two'], '3.txt')
    const { texts, other } = await partitionDroppedFiles([text1, binary, text2])
    expect(texts).toEqual([text1, text2])
    expect(other).toEqual([binary])
  })

  it('returns an all-text split as texts and an all-binary split as other', async () => {
    const text = new File(['x'], 'a.txt')
    const binary = new File([Uint8Array.of(0x89)], 'b.bin')
    expect(await partitionDroppedFiles([text])).toEqual({ texts: [text], other: [] })
    expect(await partitionDroppedFiles([binary])).toEqual({ texts: [], other: [binary] })
  })

  it('returns an empty split for an empty batch', async () => {
    expect(await partitionDroppedFiles([])).toEqual({ texts: [], other: [] })
  })
})
