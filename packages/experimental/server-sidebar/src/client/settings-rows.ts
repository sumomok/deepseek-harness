/**
 * General settings rows the console withholds from its Settings page.
 *
 * `settings.general.item` is a list slot, and a list entry's cell is its `id`:
 * entries sharing one id coexist at distinct priorities, and only the cell's
 * lowest-priority entry renders (`SlotCore.register`'s shadowing rule). This
 * module registers `() => null` at priority -1 under each id below, so the
 * owning package's own row at the default priority 0 never mounts. The owning
 * packages stay composed and keep their Config and its values; only the row a
 * person would change them with is gone. The fields stay volatile, so the
 * `remote.settings` method still accepts a write to them from any browser the
 * deployment admits.
 *
 * - `busy-compaction` — `dsh-client-ui-chat`'s "Compaction while busy" row,
 *   which picks when a `/compact` typed during a running turn runs. `ui-chat`
 *   draws the Chat column and cannot be disabled; its `busyCompaction` field
 *   stays at its default, `turn-end`.
 *
 * An id the owning package renames is an id nothing shadows any longer, and
 * its row comes back.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/settings-rows
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls ui-settings' declaration of the `settings.general.item` slot.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

/** The General rows withheld, by the list id their owning package registers them under. */
export const WITHHELD_GENERAL_ROWS = ['busy-compaction'] as const

/** Shadowing rank of the withholding entries: below the owning rows' default 0. */
const WITHHOLDING_PRIORITY = -1

/**
 * Shadow each withheld row with an entry that renders nothing, once the
 * Settings General section declares the slot.
 * @param ctx - client root context; its unload removes the entries.
 */
export function withholdGeneralRows(ctx: ClientContext): void {
  for (const id of WITHHELD_GENERAL_ROWS) {
    ctx.effect(
      () => ctx.slots.inject('settings.general.item', () => ctx.slots.register(
        { name: 'settings.general.item', id, priority: WITHHOLDING_PRIORITY },
        () => null,
      )),
      `server-sidebar: withhold the ${id} settings row`,
    )
  }
}
