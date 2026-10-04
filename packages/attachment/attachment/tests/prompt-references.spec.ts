import { describe, expect, it } from 'vitest'
import {
  MAX_PROMPT_REFERENCE_DATA_BYTES, MAX_PROMPT_REFERENCE_LABEL_CHARS, MAX_PROMPT_REFERENCES, promptReferencesProblem,
} from '../src/index.ts'
import type { PromptReference } from '../src/index.ts'

function reference(overrides: Partial<PromptReference> = {}): PromptReference {
  return { source: 'owner', label: 'Add', data: {}, ...overrides }
}

/** A `{"v":"…"}` object whose UTF-8 JSON encoding is exactly `bytes` long, filled with a 3-byte character. */
function dataOfBytes(bytes: number): PromptReference['data'] {
  const overhead = new TextEncoder().encode(JSON.stringify({ v: '' })).byteLength
  const body = bytes - overhead
  const wide = '界'.repeat(Math.floor(body / 3))
  const value = wide + 'a'.repeat(body - wide.length * 3)
  const data = { v: value }
  expect(new TextEncoder().encode(JSON.stringify(data)).byteLength).toBe(bytes)
  return data
}

describe('prompt reference bounds', () => {
  it('accepts no references, the smallest reference, and every exact limit', () => {
    expect(promptReferencesProblem([])).toBeUndefined()
    expect(promptReferencesProblem([reference({ source: 'a', label: 'x', data: {} })])).toBeUndefined()
    expect(promptReferencesProblem(Array.from({ length: MAX_PROMPT_REFERENCES }, () => reference()))).toBeUndefined()
    expect(promptReferencesProblem([reference({ source: 'A-z_0.9'.padEnd(64, 'x') })])).toBeUndefined()
    // Astral code points count once although each is two UTF-16 units.
    expect(promptReferencesProblem([reference({ label: '😀'.repeat(MAX_PROMPT_REFERENCE_LABEL_CHARS) })])).toBeUndefined()
    expect(promptReferencesProblem([reference({ data: dataOfBytes(MAX_PROMPT_REFERENCE_DATA_BYTES) })])).toBeUndefined()
  })

  it('rejects one reference past the count limit', () => {
    expect(promptReferencesProblem(Array.from({ length: MAX_PROMPT_REFERENCES + 1 }, () => reference())))
      .toBe('a prompt accepts at most 16 references')
  })

  it.each(['', 'has space', 'a/b', 'x'.repeat(65), 'ünïcode'])('rejects source %j', (source) => {
    expect(promptReferencesProblem([reference(), reference({ source })]))
      .toBe('reference 1 source must match [A-Za-z0-9_.-]{1,64}')
  })

  it.each(['', '   ', '😀'.repeat(MAX_PROMPT_REFERENCE_LABEL_CHARS + 1), 'a'.repeat(65)])('rejects label %j', (label) => {
    expect(promptReferencesProblem([reference({ label })]))
      .toBe('reference 0 label must be 1-64 code points and not blank')
  })

  it.each(['line\nbreak', 'tab\there', 'bidi‮override', 'zero​width', 'lone\uD800surrogate'])('rejects label %j', (label) => {
    expect(promptReferencesProblem([reference({ label })]))
      .toBe('reference 0 label must not contain control, format, or unpaired surrogate characters')
  })

  it('measures data as UTF-8 bytes of the complete JSON value', () => {
    const over = dataOfBytes(MAX_PROMPT_REFERENCE_DATA_BYTES + 1)
    expect(JSON.stringify(over).length).toBeLessThan(MAX_PROMPT_REFERENCE_DATA_BYTES)
    expect(promptReferencesProblem([reference({ data: over })])).toBe('reference 0 data exceeds 8192 bytes')
  })
})
