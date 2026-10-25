/**
 * Fixed-density heuristic token pricing shared by the meter service and the
 * pure context-breakdown projection, so both surfaces price identical content
 * to identical numbers.
 *
 * @module @deepseek-ai/dsh-token-meter/estimate
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { EpochHeader } from '@deepseek-ai/dsh-session'

/** Fixed text-density estimate used until exact tokenization is needed. */
const CHARS_PER_TOKEN = 4

/** Per-block structural overhead for JSON framing and type tags. */
const BLOCK_OVERHEAD = 4

/** Role-field framing overhead added to every priced message. */
export const ROLE_OVERHEAD = 4

/**
 * Structural JSON price of one block outside the typed pricing arms: the
 * fixed heuristic for merge-extended blocks and for image references, whose
 * request price is route-owned rather than fixed. Image offload marks do not
 * change this reference-only heuristic; route pricing owns their placeholders.
 * @param block - block to price without mutation.
 * @returns heuristic tokens for the block's JSON structure.
 */
export function estimateStructuralBlock(block: ContentBlock): number {
  if (block.type === 'image') {
    const { offloaded: _offloaded, ...reference } = block
    return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(reference).length / CHARS_PER_TOKEN)
  }
  return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
}

/**
 * Price content blocks recursively under the fixed density heuristic.
 * @param blocks - content blocks to price without mutation.
 * @returns heuristic tokens including per-block structural overhead.
 */
export function estimateContent(blocks: readonly ContentBlock[]): number {
  let tokens = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += Math.ceil(block.name.length / CHARS_PER_TOKEN)
          + Math.ceil(block.arguments.length / CHARS_PER_TOKEN)
          + BLOCK_OVERHEAD
        break
      default:
        // ContentBlockMap is merge-extensible; unknown blocks (and image
        // references, whose request price is route-owned) retain a
        // conservative structural JSON price under the fixed heuristic.
        tokens += estimateStructuralBlock(block)
    }
  }
  return tokens
}

/**
 * Price the rendered system prompt: the `system/message` surface node's text.
 * Adapters serialize the prompt as a plain string — a system-role message or
 * the request's system field — not as a typed content block, so the price is
 * text density plus role framing with no per-block overhead.
 * @param message - system-role message to price without mutation.
 * @returns heuristic system-prompt tokens; 0 for empty content ("no system prompt").
 */
export function estimateSystemMessage(message: Message): number {
  if (message.content.length === 0) return 0
  let characters = 0
  for (const block of message.content) {
    characters += block.type === 'text' ? block.text.length : JSON.stringify(block).length
  }
  return Math.ceil(characters / CHARS_PER_TOKEN) + ROLE_OVERHEAD
}

/**
 * Heuristically price one model-visible message.
 * @param message - message to price without mutation.
 * @returns content and role-framing tokens under the fixed heuristic; a
 *   system-role message prices as {@link estimateSystemMessage}.
 */
export function estimateMessage(message: Message): number {
  if (message.role === 'system') return estimateSystemMessage(message)
  return estimateContent(message.content) + ROLE_OVERHEAD
}

/**
 * Price the tool-schema part of a canonical request envelope — the envelope's
 * only priced field, since the system prompt is a surface node.
 * @param header - canonical envelope, or undefined before any request.
 * @returns heuristic tool-schema tokens; 0 when absent or empty.
 */
export function estimateToolsTokens(header: EpochHeader | undefined): number {
  if (header?.tools === undefined || header.tools.length === 0) return 0
  return Math.ceil(JSON.stringify(header.tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

/**
 * Density of non-CJK text under the dense profile. Providers price Latin text
 * near four characters per token; the profile keeps a small margin below the
 * fixed heuristic so a dense price is not lower than the provider's.
 */
const DENSE_LATIN_CHARS_PER_TOKEN = 3.5

/**
 * Code points a provider tokenizer charges at least one token for, although
 * they occupy a single character: CJK ideographs, kana, Hangul, and the CJK
 * punctuation and full-width forms around them. The fixed {@link CHARS_PER_TOKEN}
 * heuristic prices them at a quarter token each, which is why a Chinese summary
 * can look small to the fixed heuristic while costing more than what it replaced.
 */
const DENSE_CODE_POINT = new RegExp(
  '[\\u2E80-\\u2EFF\\u2F00-\\u2FFF\\u3000-\\u303F\\u3040-\\u30FF'
  + '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF\\uFF00-\\uFFEF]',
)

/**
 * Price text whose provider tokenization is denser than the fixed ASCII
 * heuristic: every code point {@link DENSE_CODE_POINT} matches counts as one
 * token, the rest at {@link DENSE_LATIN_CHARS_PER_TOKEN}.
 *
 * This is the conservative side of the estimate — a provider charges at least
 * this many tokens for the same text — so a caller that must not overstate a
 * shrink can compare against it. It is not the price the meter folds into
 * occupancy, which stays on the fixed heuristic so projections agree with the
 * appended prices they replay.
 * @param text - text to price without mutation.
 * @returns dense token estimate for the text alone.
 */
export function estimateDenseTextTokens(text: string): number {
  let dense = 0
  for (const codePoint of text) {
    if (DENSE_CODE_POINT.test(codePoint)) dense += 1
  }
  return dense + Math.ceil((text.length - dense) / DENSE_LATIN_CHARS_PER_TOKEN)
}

/**
 * Price one model-visible message under the dense text profile, keeping the
 * fixed heuristic for structural blocks and tool-call JSON.
 * @param message - message to price without mutation.
 * @returns dense token estimate including the same framing overheads as
 *   {@link estimateMessage}.
 */
export function estimateDenseMessageTokens(message: Message): number {
  if (message.role === 'system') {
    if (message.content.length === 0) return 0
    let tokens = 0
    for (const block of message.content) {
      tokens += block.type === 'text'
        ? estimateDenseTextTokens(block.text)
        : Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
    }
    return tokens + ROLE_OVERHEAD
  }
  let tokens = ROLE_OVERHEAD
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += estimateDenseTextTokens(block.text) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += Math.ceil(block.name.length / CHARS_PER_TOKEN)
          + Math.ceil(block.arguments.length / CHARS_PER_TOKEN)
          + BLOCK_OVERHEAD
        break
      default:
        tokens += estimateStructuralBlock(block)
    }
  }
  return tokens
}
