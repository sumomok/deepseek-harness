/** Host registration for browser Chat preferences and the busy-state `/compact` timing. */
import type {} from '@deepseek-ai/dsh-settings'
// Type-only: the `ctx.manualCompactionTiming` Context merge this plugin provides.
import type {} from '@deepseek-ai/dsh-compaction'
import type { ManualCompactionWhileBusy } from '@deepseek-ai/dsh-compaction/types'

import type { Volatile, Context } from '@deepseek-ai/cordis'
import type { ChatSettings, LinkOpening, PerformanceUsageMode } from './chat-settings.ts'
import z from '@deepseek-ai/schemastery'
import { TRANSCRIPT_VIEW_FIELD } from './chat-settings.ts'

import { ChatSettingsFields } from './chat-settings.ts'

export {
  BUSY_COMPACTION_FIELD, BUSY_COMPACTION_MODES, DEFAULT_BUSY_COMPACTION,
  CHAT_SETTINGS_NAMESPACE, DEFAULT_TRANSCRIPT_VIEW_MODE, LEGACY_TRANSCRIPT_VIEW_MODE,
  LEGACY_EXPANDED_TRANSCRIPT_VIEW_MODE, TRANSCRIPT_VIEW_FIELD,
  TRANSCRIPT_VIEW_MODES, type ChatSettings, type TranscriptViewMode,
} from './chat-settings.ts'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Completed turn transcript presentation. */
  transcriptView: Volatile<ChatSettings['transcriptView']>
  /** Performance and usage detail level. */
  performanceUsage: Volatile<PerformanceUsageMode>
  /** Default destination for Chat HTTP(S) links. */
  linkOpening: Volatile<LinkOpening>
  /** When `/compact` runs if the agent is running a turn. */
  busyCompaction: Volatile<ManualCompactionWhileBusy>
}

/** Live preferences projected to the browser. */
export const Config = z.object({
  transcriptView: ChatSettingsFields[TRANSCRIPT_VIEW_FIELD].volatile(),
  performanceUsage: ChatSettingsFields['performanceUsage'].volatile(),
  linkOpening: ChatSettingsFields.linkOpening.volatile(),
  busyCompaction: ChatSettingsFields.busyCompaction.volatile(),
})

/**
 * Host preferences are consumed through the configuration form projection;
 * the busy-state `/compact` timing is also provided as
 * `ctx.manualCompactionTiming`, read live on every request.
 * @param ctx Plugin context used for optional settings presentation.
 * @param config Live preferences; the Loader updates volatile fields in place.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.provide('manualCompactionTiming', { whileBusy: () => config.busyCompaction.get() })
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
