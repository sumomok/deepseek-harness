/**
 * `AttachmentSpill`: idempotent, session-scoped spill materialization for one
 * oversized text-file attachment. Registers as `ctx.attachmentSpill`.
 *
 * A provider adapter lowers each `file` content block into request text once
 * per request build, for the complete message history, on every step
 * (`@deepseek-ai/dsh-llm`'s `lowerFileBlocksFromStore`). A file whose decoded
 * text exceeds `inlineWholeUnderChars` therefore needs a STABLE spill
 * artifact reused across repeated lowering calls for the same attachment
 * within one session, rather than a fresh spill (and a fresh locator) every
 * time the history is re-lowered. This service owns exactly that: given a
 * `FileAttachmentRef` and its already-decoded text, it resolves or creates
 * the backing `ctx.spillStore` artifact, caches the result in-process for
 * (session, attachment id), and appends `attachment/materialized` the first
 * time in this process it spills a given attachment — the durable record
 * that keeps the model-visible locator text reconstructable from the
 * session log.
 *
 * Ownership for the spill is the CURRENT initiating agent
 * (`ctx.agents.currentInitiator()`), not a session id threaded through the
 * call: a request always lowers file blocks from within the initiating
 * agent's own asynchronous chain, and reading ownership from the live
 * `Agent.session` (rather than a caller-supplied session id) rules out the
 * two ever disagreeing. Absent a live initiating agent (a session-less LLM
 * call, e.g. a one-shot request outside any agent turn), `resolveSpill`
 * returns `undefined` and the caller keeps the file inline, truncated —
 * spilling without a session to log the materialization against would make
 * the model-visible locator text unreconstructable from the session log.
 *
 * @module @deepseek-ai/dsh-attachment-spill
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { AttachmentId, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CallId, DEFAULT_MAX_LOWERED_FILE_CHARS } from '@deepseek-ai/dsh-llm'
import type { FileSpillOptions } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SpillRef } from '@deepseek-ai/dsh-spill'

export * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    attachmentSpill: AttachmentSpill
  }
}

/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config {
  /** Character threshold at/under which a file's decoded text stays fully inline. Above it, the file spills. */
  inlineWholeUnderChars?: number
  /** Characters of a spilled file's decoded text shown as a preview alongside its locator. */
  previewChars?: number
}

/**
 * Default `inlineWholeUnderChars`: `@deepseek-ai/dsh-llm`'s retired
 * always-truncate cap, repurposed as this field's default so the two stay
 * one number absent an explicit deployment override.
 */
export const DEFAULT_INLINE_WHOLE_UNDER_CHARS = DEFAULT_MAX_LOWERED_FILE_CHARS
/** Default `previewChars`. */
export const DEFAULT_PREVIEW_CHARS = 4_000

/** Validate one non-negative-integer config field, failing loud at load rather than at first use. */
function requireNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`attachment-spill: ${field} must be a non-negative integer (got ${value})`)
  }
}

/** Strip an `AttachmentId`'s `sha256:` prefix and keep the first 8 hex characters, for a readable spill filename. */
function shortAttachmentId(attachmentId: AttachmentId): string {
  return String(attachmentId).replace(/^sha256:/u, '').slice(0, 8)
}

/**
 * `ctx.attachmentSpill`: idempotent, session-scoped spill materialization for
 * oversized text-file attachments. See the module doc for the full contract.
 */
export class AttachmentSpill extends Service {
  static Config: z<Config> = z.object({
    inlineWholeUnderChars: z.number().step(1).min(0).default(DEFAULT_INLINE_WHOLE_UNDER_CHARS),
    previewChars: z.number().step(1).min(0).default(DEFAULT_PREVIEW_CHARS),
  })

  /** Character threshold at/under which a file's decoded text stays fully inline. */
  readonly inlineWholeUnderChars: number
  /** Characters of a spilled file's decoded text shown as a preview alongside its locator. */
  readonly previewChars: number

  /** Process-local idempotency cache: (session, attachment id) → the spill artifact already materialized for it. */
  private readonly materialized = new Map<SessionId, Map<AttachmentId, SpillRef>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'attachmentSpill')
    const inlineWholeUnderChars = config.inlineWholeUnderChars ?? DEFAULT_INLINE_WHOLE_UNDER_CHARS
    const previewChars = config.previewChars ?? DEFAULT_PREVIEW_CHARS
    requireNonNegativeInteger(inlineWholeUnderChars, 'inlineWholeUnderChars')
    requireNonNegativeInteger(previewChars, 'previewChars')
    this.inlineWholeUnderChars = inlineWholeUnderChars
    this.previewChars = previewChars
  }

  /**
   * Resolve the spill artifact backing one oversized attachment's lowered
   * request text, materializing it at most once per (session, attachment id)
   * in this process.
   * @param attachment - the durable file attachment being lowered.
   * @param content - the attachment's already-decoded full UTF-8 text.
   * @returns the artifact's `SpillRef`, or `undefined` when there is no live
   *   initiating agent to own and log the spill against, `ctx.spillStore` is
   *   not loaded, or the backend rejected the write (best-effort: the caller
   *   keeps the file inline, truncated, on `undefined`).
   */
  async resolveSpill(attachment: FileAttachmentRef, content: string): Promise<SpillRef | undefined> {
    const agent = this.ctx.get('agents')?.currentInitiator()
    if (agent === undefined) return undefined
    const sessionId = agent.session.id
    const cached = this.materialized.get(sessionId)?.get(attachment.attachmentId)
    if (cached !== undefined) return cached
    const store = this.ctx.get('spillStore')
    if (store === undefined) return undefined
    let ref: SpillRef
    try {
      ref = await store.saveText({
        owner: { sessionId },
        source: {
          toolName: 'attachment',
          callId: CallId(String(attachment.attachmentId)),
          label: attachment.name,
        },
        suggestedName: `attachment-${shortAttachmentId(attachment.attachmentId)}-${attachment.name}`,
        content,
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `attachment-spill: saveText failed for ${attachment.name}: ${String(error)}; keeping the file inline`,
      )
      return undefined
    }
    agent.session.append('attachment/materialized', { attachmentId: attachment.attachmentId, locator: ref.locator })
    let bySession = this.materialized.get(sessionId)
    if (bySession === undefined) {
      bySession = new Map()
      this.materialized.set(sessionId, bySession)
    }
    bySession.set(attachment.attachmentId, ref)
    return ref
  }
}

/**
 * Adapt one `AttachmentSpill` instance into `@deepseek-ai/dsh-llm`'s
 * `FileSpillOptions`, for a provider adapter's `lowerFileBlocksFromStore`
 * call — the one conversion every adapter shares, so none has to restate
 * `resolveSpill`'s binding.
 * @param attachmentSpill - the resolved service instance, or `undefined` when `ctx.attachmentSpill` is not loaded.
 * @returns spill options bound to `attachmentSpill`, or `undefined` when it is
 *   absent (the caller then falls back to truncated inline text).
 */
export function fileSpillOptionsFrom(attachmentSpill: AttachmentSpill | undefined): FileSpillOptions | undefined {
  if (attachmentSpill === undefined) return undefined
  return {
    inlineWholeUnderChars: attachmentSpill.inlineWholeUnderChars,
    previewChars: attachmentSpill.previewChars,
    resolveSpill: (attachment, content) => attachmentSpill.resolveSpill(attachment, content),
  }
}

export default AttachmentSpill
