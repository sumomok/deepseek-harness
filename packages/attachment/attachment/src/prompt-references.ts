/** Protocol bounds and validation for prompt references. @module @deepseek-ai/dsh-attachment/prompt-references */

import type { PromptReference } from './types.ts'

/** Maximum references on one prompt. */
export const MAX_PROMPT_REFERENCES = 16

/** Maximum code points in one reference label. */
export const MAX_PROMPT_REFERENCE_LABEL_CHARS = 64

/** Maximum UTF-8 bytes of one reference's JSON-encoded `data`. */
export const MAX_PROMPT_REFERENCE_DATA_BYTES = 8192

const SOURCE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u
const FORBIDDEN_LABEL_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}]/u

/**
 * Check prompt references against the protocol bounds. The wire codec has
 * already checked field types; this checks the complete values that the Host
 * records durably.
 * @param references - references from one prompt request, in submission order.
 * @returns a caller-facing description of the first violation, or `undefined` when all are valid.
 */
export function promptReferencesProblem(references: readonly PromptReference[]): string | undefined {
  if (references.length > MAX_PROMPT_REFERENCES) {
    return `a prompt accepts at most ${MAX_PROMPT_REFERENCES} references`
  }
  for (const [index, reference] of references.entries()) {
    if (!SOURCE_PATTERN.test(reference.source)) {
      return `reference ${index} source must match [A-Za-z0-9_.-]{1,64}`
    }
    const labelChars = Array.from(reference.label).length
    if (labelChars > MAX_PROMPT_REFERENCE_LABEL_CHARS || reference.label.trim() === '') {
      return `reference ${index} label must be 1-${MAX_PROMPT_REFERENCE_LABEL_CHARS} code points and not blank`
    }
    if (FORBIDDEN_LABEL_CHARACTER.test(reference.label)) {
      return `reference ${index} label must not contain control, format, or unpaired surrogate characters`
    }
    if (new TextEncoder().encode(JSON.stringify(reference.data)).byteLength > MAX_PROMPT_REFERENCE_DATA_BYTES) {
      return `reference ${index} data exceeds ${MAX_PROMPT_REFERENCE_DATA_BYTES} bytes`
    }
  }
  return undefined
}
