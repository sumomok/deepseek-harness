/**
 * The console's rows for an automatic compaction that landed or failed.
 *
 * `dsh-client-ui-chat` draws a landed compaction as the marker 上下文已压缩
 * with the number of history items and the tokens it condensed, and pressing
 * it expands the summary `compaction-basic` wrote, in English; a failed one is
 * 上下文压缩失败 with a line promising another attempt. `conversation.chat.node`
 * is a keyed slot, and only a key's lowest-priority entry renders
 * (`SlotCore.register`'s shadowing rule), so {@link replaceCompactionRows}
 * registers these two rows at {@link REPLACING_PRIORITY} under the
 * `compaction` and `compaction-failure` keys, and `ui-chat`'s own entries at
 * the default priority 0 never mount. Where `ui-chat` places the row in a
 * turn is unchanged; only what the row shows is the console's: a fixed
 * sentence, no count, no token figure, and no summary to open. The running row
 * 正在压缩… (`compaction-running`) stays `ui-chat`'s.
 *
 * A key `ui-chat` renames is a key nothing shadows any longer, and its row
 * comes back.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/CompactionRows
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { IconApiOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls ui-chat's declaration of `conversation.chat.node` and its node kinds.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import css from './CompactionRows.module.css'
import { REPLACING_PRIORITY } from './shadowed-overlay.ts'

/** Dictionary namespace both rows read. */
const NS = 'serverSidebar'

/** Props of the landed-compaction row. */
export type CompactedRowProps = PropsRuntime<'conversation.chat.node', 'compaction'> & PropsLocale<'serverSidebar'>

/** Props of the failed-compaction row. */
export type CompactionFailedRowProps = PropsRuntime<'conversation.chat.node', 'compaction-failure'> & PropsLocale<'serverSidebar'>

/**
 * Render the row of a compaction that landed.
 * @param props - see {@link CompactedRowProps}; only `t` is read.
 * @returns the row.
 */
export function CompactedRow({ t }: Pick<CompactedRowProps, 't'>) {
  return (
    <div className={css.completed} data-server-sidebar-compaction="completed">
      <span className={css.icon} aria-hidden>
        <IconApiOutlineRegular />
      </span>
      <span>{t('compaction.completed')}</span>
    </div>
  )
}

/**
 * Render the row of a compaction that failed.
 * @param props - see {@link CompactionFailedRowProps}; only `t` is read.
 * @returns the row.
 */
export function CompactionFailedRow({ t }: Pick<CompactionFailedRowProps, 't'>) {
  return (
    <div className={css.failed} role="status" data-server-sidebar-compaction="failed">
      <StateDot state="warning" className={css.failedDot} />
      <span className={css.failedTitle}>{t('compaction.failed')}</span>
    </div>
  )
}

/**
 * Shadow `ui-chat`'s landed and failed compaction rows, once the Chat view
 * declares its node slot.
 * @param ctx - client root context; its unload removes the entries.
 */
export function replaceCompactionRows(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'compaction', priority: REPLACING_PRIORITY, locale: NS },
    CompactedRow,
  )), 'server-sidebar: the landed compaction row')
  ctx.effect(() => ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'compaction-failure', priority: REPLACING_PRIORITY, locale: NS },
    CompactionFailedRow,
  )), 'server-sidebar: the failed compaction row')
}
