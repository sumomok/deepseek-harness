/**
 * Durable event vocabulary for `@deepseek-ai/dsh-attachment-spill`.
 * @module @deepseek-ai/dsh-attachment-spill/types
 */

import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { SpillLocator } from '@deepseek-ai/dsh-spill'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Durable, non-surface record of one attachment lowered to a
     * session-scoped spill artifact instead of an inline truncated preview.
     * Recorded once per (session, attachment id) the first time this
     * process spills it; log replay uses the most recent record for an
     * attachment id to reconstruct the exact locator text a past request
     * showed the model. A later resumed process with an empty in-process
     * cache may append a second record for the same attachment id under a
     * fresh locator rather than reusing the earlier one.
     */
    'attachment/materialized': AttachmentMaterializedEventData
  }
}

/** Durable payload recorded when one file attachment is first spilled in this process. */
export interface AttachmentMaterializedEventData {
  /** The attachment whose lowered request text now points at `locator` instead of inline text. */
  attachmentId: AttachmentId
  /** The spill backend's locator for the materialized artifact. */
  locator: SpillLocator
}
