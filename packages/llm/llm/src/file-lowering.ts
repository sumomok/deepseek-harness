/**
 * Deterministic model-visible text a `FileBlock` lowers to, and the shared
 * recursive walk that replaces every file block, including nested
 * tool-result content, with its resolved text. No production adapter
 * accepts a file part natively, so every adapter runs this lowering once at
 * the top of its own request construction, against a locally derived copy
 * of the messages — never against the frozen `GenerateOptions.messages` a
 * dispatched request carries, which the agent-loop's request-reconstruction
 * invariant requires to stay byte-identical to the session log's own
 * derivation. This mirrors how each adapter already resolves `ImageBlock`
 * bytes locally rather than materializing them into that frozen array.
 *
 * A file at or under `inlineWholeUnderChars` (the {@link FileSpillOptions}
 * field, defaulting to {@link DEFAULT_MAX_LOWERED_FILE_CHARS} when no spill
 * options are supplied at all) lowers to its full inline text, unchanged. A
 * larger file spills to a session-scoped artifact through the caller's
 * `resolveSpill` hook (`@deepseek-ai/dsh-attachment-spill`'s
 * `ctx.attachmentSpill`, threaded in by each adapter) and lowers to a
 * locator line plus a bounded preview instead of the truncated inline text
 * this module used to always produce for an oversized file; `resolveSpill`
 * returning `undefined` (no owning session, no backend, or a storage
 * failure) falls back to that truncated inline text so an oversized file is
 * never dropped.
 *
 * The inline/truncated serialization (header line, language-tagged fence,
 * fence-lengthening, truncation) is an exact port of the retired
 * `@sumomok/dsh-text-drop` plugin's
 * `core/message.ts`/`fence.ts`/`language.ts`/`size.ts`/`payload.ts`.
 *
 * @module @deepseek-ai/dsh-llm/file-lowering
 */

import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from './types.ts'
import type { Message } from './message.ts'

/**
 * Character cap for one file's lowered content when no {@link FileSpillOptions}
 * are supplied at all: a longer file is cut and its header reports the full
 * length. Also the default source for `@deepseek-ai/dsh-attachment-spill`'s
 * `inlineWholeUnderChars` config field, so the two stay one number absent an
 * explicit deployment override.
 */
export const DEFAULT_MAX_LOWERED_FILE_CHARS = 16_000

/**
 * Minimal spill-artifact shape file-lowering needs to render a locator line.
 * Matches `@deepseek-ai/dsh-spill`'s `SpillRef` structurally (a `SpillRef`
 * satisfies this type directly) without importing that package: `dsh-spill`
 * itself depends on this package (for `CallId`), so importing it back here
 * would cycle.
 */
export interface LoweredFileSpillRef {
  /** Opaque backend-produced locator the model is told to `read`/`grep`. */
  locator: string
  /** Backend-owned retrieval guidance appended after the locator. */
  retrievalHint: string
}

/**
 * Caller-supplied policy and backend hook for spilling an oversized file
 * instead of truncating it, passed through {@link lowerFileBlocksFromStore}.
 */
export interface FileSpillOptions {
  /** Character threshold at/under which a file's decoded text stays fully inline. Above it, the file spills. */
  inlineWholeUnderChars: number
  /** Characters of a spilled file's decoded text shown as a preview alongside its locator. */
  previewChars: number
  /**
   * Resolve or create the spill artifact backing one oversized file's
   * lowered text. Returns `undefined` when spilling is unavailable for this
   * call (no owning session to log the materialization event against, no
   * backend, or a storage failure); the caller then keeps the file inline,
   * truncated at `inlineWholeUnderChars`, instead of losing it.
   * @param attachment - the durable file attachment being lowered.
   * @param content - the attachment's already-decoded full UTF-8 text.
   */
  resolveSpill: (attachment: FileAttachmentRef, content: string) => Promise<LoweredFileSpillRef | undefined>
}

/** Extensions fenced bare (no language tag): their content is prose or a log, not code. */
const BARE_EXTENSIONS = new Set(['txt', 'log'])

/**
 * Derive the fence language tag from a file name.
 * @param name - the file's display name.
 * @returns the lowercased extension, or '' for no extension or a bare-listed one.
 */
function languageFor(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return ''
  const ext = name.slice(dot + 1).toLowerCase()
  return BARE_EXTENSIONS.has(ext) ? '' : ext
}

/**
 * Pick a fence at least one backtick longer than the longest run already in
 * `content`, so no line of the content can close it early.
 * @param content - the file text the fence will wrap.
 * @returns a run of backticks, three or more.
 */
function fenceFor(content: string): string {
  let longest = 0
  for (const match of content.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * Format a byte count as the size note in a file's header line, e.g. `2.1 KB`.
 * @param bytes - the file's stored size in bytes.
 * @returns a compact size label.
 */
function fileSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/**
 * Cap one file's text at `limit` code points, so a cap never splits an emoji
 * or other multi-code-unit character.
 * @param text - decoded file content.
 * @param limit - maximum code points kept.
 * @returns the kept text, plus the original code-point count when the text was capped.
 */
function capFileText(text: string, limit: number): { text: string; totalChars?: number } {
  const units = Array.from(text)
  if (units.length <= limit) return { text }
  return { text: units.slice(0, limit).join(''), totalChars: units.length }
}

/**
 * Render one file as the header line and fenced block a model sees in place
 * of a `FileBlock`. The fence is sized to the file's own content, so a
 * dropped markdown note's embedded backtick run cannot close it early. A
 * file at or under `maxChars` lowers whole, unchanged; a larger one is cut
 * and its header reports the full length — the fallback format used when no
 * spill artifact is available (see {@link lowerFileBlocksFromStore}).
 * @param name - display name; also the fence's language-tag source.
 * @param text - complete decoded file content.
 * @param bytes - stored byte length, for the header's size note.
 * @param maxChars - character cap; longer content is cut and reports its full length. Defaults to {@link DEFAULT_MAX_LOWERED_FILE_CHARS}.
 * @returns the header line, fenced block, and (when capped) a truncation note, newline-joined.
 */
export function lowerFileBlockText(
  name: string,
  text: string,
  bytes: number,
  maxChars: number = DEFAULT_MAX_LOWERED_FILE_CHARS,
): string {
  const capped = capFileText(text, maxChars)
  const fence = fenceFor(capped.text)
  const lines = [
    `File ${name} (${fileSizeLabel(bytes)}):`,
    `${fence}${languageFor(name)}`,
    capped.text,
    fence,
  ]
  if (capped.totalChars !== undefined) lines.push(`…(truncated, ${String(capped.totalChars)} chars total)`)
  return lines.join('\n')
}

/**
 * Render one spilled file as the header/locator line, a bounded preview
 * fenced block, and a trailing preview-size note — the model-visible text a
 * `FileBlock` lowers to once its decoded text exceeds
 * {@link FileSpillOptions.inlineWholeUnderChars} and `resolveSpill` returns
 * an artifact.
 * @param name - display name; also the fence's language-tag source.
 * @param text - complete decoded file content (only its first `previewChars` are shown).
 * @param bytes - stored byte length, for the header's size note.
 * @param previewChars - characters of `text` to preview alongside the locator.
 * @param ref - the resolved spill artifact.
 * @returns the header/locator line, fenced preview, and preview-size note, newline-joined.
 */
export function lowerSpilledFileBlockText(
  name: string,
  text: string,
  bytes: number,
  previewChars: number,
  ref: LoweredFileSpillRef,
): string {
  const units = Array.from(text)
  const totalChars = units.length
  const previewText = units.slice(0, previewChars).join('')
  const fence = fenceFor(previewText)
  const shownPreviewChars = Math.min(previewChars, totalChars)
  return [
    `File ${name} (${fileSizeLabel(bytes)}, ${String(totalChars)} chars) stored at: ${ref.locator}. ${ref.retrievalHint}`,
    `${fence}${languageFor(name)}`,
    previewText,
    fence,
    `(preview: first ${String(shownPreviewChars)} of ${String(totalChars)} chars)`,
  ].join('\n')
}

/**
 * Decide between whole inline text, a spilled locator + preview, or
 * truncated inline text (the fallback when spilling is unavailable) for one
 * file attachment, per {@link FileSpillOptions}.
 * @param attachment - the durable file attachment being lowered.
 * @param text - the attachment's already-decoded full UTF-8 text.
 * @param spill - the caller's spill policy and backend hook.
 * @returns the model-visible text {@link lowerFileBlocksIn} substitutes for the `FileBlock`.
 */
async function lowerFileBlockTextWithSpill(
  attachment: FileAttachmentRef,
  text: string,
  spill: FileSpillOptions,
): Promise<string> {
  if (Array.from(text).length <= spill.inlineWholeUnderChars) {
    return lowerFileBlockText(attachment.name, text, attachment.bytes, spill.inlineWholeUnderChars)
  }
  const ref = await spill.resolveSpill(attachment, text)
  if (ref === undefined) return lowerFileBlockText(attachment.name, text, attachment.bytes, spill.inlineWholeUnderChars)
  return lowerSpilledFileBlockText(attachment.name, text, attachment.bytes, spill.previewChars, ref)
}

/**
 * True when typed model content contains a file block, walking nested
 * tool-result content.
 * @param content - content blocks to inspect without mutation.
 * @returns whether any nested block is a file.
 */
export function contentHasFile(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'file'
    || (block.type === 'tool-result' && contentHasFile(block.content)))
}

/** Replace every file block in one content tree with its resolved text block. */
async function lowerFileBlocksIn(
  blocks: readonly ContentBlock[],
  resolve: (attachment: FileAttachmentRef) => Promise<string>,
): Promise<ContentBlock[]> {
  return Promise.all(blocks.map(async (block): Promise<ContentBlock> => {
    if (block.type === 'file') return { type: 'text', text: await resolve(block.attachment) }
    if (block.type === 'tool-result' && contentHasFile(block.content)) {
      return { ...block, content: await lowerFileBlocksIn(block.content, resolve) }
    }
    return block
  }))
}

/**
 * Replace every file block, including nested tool-result content, with its
 * resolved lowered text. The one recursive file walk every request path
 * shares, so a consumer cannot silently diverge on nesting depth.
 * @param messages - complete request history.
 * @param resolve - reads and formats one file block's model-visible text.
 * @returns the original messages when none carry a file block, otherwise shallow copies with file blocks replaced by text.
 */
export async function lowerFileBlocks(
  messages: readonly Message[],
  resolve: (attachment: FileAttachmentRef) => Promise<string>,
): Promise<readonly Message[]> {
  if (!messages.some(message => contentHasFile(message.content))) return messages
  return Promise.all(messages.map(async (message) => {
    if (!contentHasFile(message.content)) return message
    return { ...message, content: await lowerFileBlocksIn(message.content, resolve) }
  }))
}

/**
 * {@link lowerFileBlocks} with its `resolve` step fixed to the durable
 * attachment service: read the stored bytes, UTF-8 decode, then format
 * either whole, spilled, or truncated per `spill` (see
 * {@link lowerFileBlockTextWithSpill}) — or always truncated at
 * {@link DEFAULT_MAX_LOWERED_FILE_CHARS} when `spill` is omitted entirely.
 * The one read-decode-format composition every adapter's own request path
 * shares, called locally within request construction — never against the
 * frozen `GenerateOptions.messages` a dispatched request carries, which must
 * stay reconstructable from the session log unchanged.
 * @param messages - request history that may carry file blocks.
 * @param attachments - durable store that resolves each file block's bytes.
 * @param signal - forwarded into every file read.
 * @param spill - optional spill policy and backend hook; omission preserves this module's original always-truncate behavior.
 * @returns `messages` unchanged when none carry a file block, otherwise shallow copies with file blocks replaced by lowered text.
 */
export async function lowerFileBlocksFromStore(
  messages: readonly Message[],
  attachments: AttachmentStore,
  signal?: AbortSignal,
  spill?: FileSpillOptions,
): Promise<readonly Message[]> {
  return lowerFileBlocks(messages, async (attachment: FileAttachmentRef) => {
    const stored = await attachments.readFile(attachment, signal)
    const text = new TextDecoder('utf-8').decode(stored.data)
    return spill === undefined
      ? lowerFileBlockText(attachment.name, text, attachment.bytes)
      : lowerFileBlockTextWithSpill(attachment, text, spill)
  })
}
