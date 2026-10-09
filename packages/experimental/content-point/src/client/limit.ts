/**
 * The most references one prompt may carry, as the host's prompt check
 * (`MAX_PROMPT_REFERENCES` of `@deepseek-ai/dsh-attachment`) bounds it. The
 * browser bundle may not import that package's values, so the number is
 * stated here; `tests/button.client.spec.tsx` holds the two equal.
 * @module @deepseek-ai/dsh-experimental-content-point/client/limit
 */

/** The most references one prompt may carry. */
export const REFERENCE_LIMIT = 16
