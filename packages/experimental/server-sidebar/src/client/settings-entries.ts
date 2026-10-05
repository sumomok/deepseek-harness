/**
 * Settings entries the console withholds from its Settings page.
 *
 * `settings.general.item` and `settings.action` are list slots, and a list
 * entry's cell is its `id`: entries sharing one id coexist at distinct
 * priorities, and only the cell's lowest-priority entry renders
 * (`SlotCore.register`'s shadowing rule). This module registers
 * {@link WithheldSettingsEntry}, which renders nothing, at
 * {@link REPLACING_PRIORITY} under each id below, so the owning package's own
 * entry at the default priority 0 never mounts. The owning packages stay
 * composed and keep their Config and its values; only the control a person
 * would use is gone. The `dsh-experimental-console-profile` README states
 * which of those values a settings write can still change.
 *
 * - `busy-compaction` in Settings → General — `dsh-client-ui-chat`'s
 *   "Compaction while busy" row, which picks when a `/compact` typed during a
 *   running turn runs. `ui-chat` draws the Chat column and cannot be disabled;
 *   the console's lock fixes its `busyCompaction` field at `turn-end`.
 * - `auto-compact` in Settings → General — `@haoran/dsh-auto-compact`'s
 *   switch-and-slider row. The console's lock fixes the share that plugin
 *   compacts at, and a customer has no reason to move it. The conversation's
 *   rows for a landed or failed compaction are replaced in
 *   `CompactionRows.tsx`.
 * - The other Settings → General rows whose namespace the console's lock
 *   (`dsh-experimental-console-profile`'s `permission-lock.patch.yml`)
 *   composes above the profile patch: `language` (`dsh-client-locale`),
 *   `appearance` and `font-size` (`dsh-client-ui-theme`), `transcript-view`,
 *   `performance-usage`, and `link-opening` (`dsh-client-ui-chat`),
 *   `composer-enter` (`dsh-client-ui-conversation`), and `developer-tools`
 *   (`dsh-client-ui-settings-general`'s switch for `ui-settings.enabled`).
 *   Each saves into the deployment's shared profile patch, so one visitor's
 *   choice would apply to every visitor; the lock refuses that write, and a
 *   control whose every write is refused changes nothing. With these
 *   withheld, Settings → General draws only the keyboard-shortcut row, which
 *   this browser alone stores, and the current version.
 * - `open-document` in the Settings header — `dsh-client-ui-settings-general`'s
 *   **Open configuration file** action. That package is the settings shell
 *   itself, so its row cannot be disabled, and no Config field gates the
 *   action. The action is guarded by `ctx.remote.$host.isLoopback`, which this
 *   console makes true on a remote visitor: `dsh-experimental-server-base`'s
 *   `ownsHost` declares the deployment's own login gate as the thing deciding
 *   who reaches the page, and every visitor it admits then gets the operator
 *   surface. Without this entry, a customer signed in to the deployed console
 *   is offered the Host's configuration file. The header's action row stays
 *   in the layout, empty, and still seats the close button at its right edge.
 *
 * An id the owning package renames is an id nothing shadows any longer, and
 * its entry comes back.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/settings-entries
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls ui-settings' declarations of `settings.general.item` and `settings.action`.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { REPLACING_PRIORITY } from './shadowed-overlay.ts'

/**
 * The occupant of every withheld cell.
 * @returns nothing, so the cell renders empty.
 */
export function WithheldSettingsEntry(): null {
  return null
}

/**
 * Shadow each withheld entry, once the settings shell declares its slot. Each
 * registration names its slot and id literally, so the client slot catalog
 * lists every withheld id.
 * @param ctx - client root context; its unload removes the entries.
 */
export function withholdSettingsEntries(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('settings.general.item', () => ctx.slots.register(
    { name: 'settings.general.item', id: 'busy-compaction', priority: REPLACING_PRIORITY },
    WithheldSettingsEntry,
  )), 'server-sidebar: withhold the busy-compaction settings row')
  ctx.effect(() => ctx.slots.inject('settings.general.item', () => ctx.slots.register(
    { name: 'settings.general.item', id: 'auto-compact', priority: REPLACING_PRIORITY },
    WithheldSettingsEntry,
  )), 'server-sidebar: withhold the auto-compact settings row')
  ctx.effect(() => ctx.slots.inject('settings.general.item', () => ctx.slots.register(
    { name: 'settings.general.item', id: 'language', priority: REPLACING_PRIORITY },
    WithheldSettingsEntry,
  )), 'server-sidebar: withhold the language settings row')
  ctx.effect(() => ctx.slots.inject('settings.general.item', () => ctx.slots.register(
    { name: 'settings.general.item', id: 'appearance', priority: REPLACING_PRIORITY },
    WithheldSettingsEntry,
  )), 'server-sidebar: withhold the appearance settings row')
  ctx.effect(() => ctx.slots.inject('settings.general.item', () => ctx.slots.register(
    { name: 'settings.general.item', id: 'font-size', priority: REPLACING_PRIORITY },
    WithheldSettingsEntry,
  )), 'server-sidebar: withhold the font-size settings row')
  ctx.effect(() => ctx.slots.inject('settings.general.item', () => ctx.slots.register(
    { name: 'settings.general.item', id: 'transcript-view', priority: REPLACING_PRIORITY },
    WithheldSettingsEntry,
  )), 'server-sidebar: withhold the transcript-view settings row')
  ctx.effect(() => ctx.slots.inject('settings.general.item', () => ctx.slots.register(
    { name: 'settings.general.item', id: 'performance-usage', priority: REPLACING_PRIORITY },
    WithheldSettingsEntry,
  )), 'server-sidebar: withhold the performance-usage settings row')
  ctx.effect(() => ctx.slots.inject('settings.general.item', () => ctx.slots.register(
    { name: 'settings.general.item', id: 'link-opening', priority: REPLACING_PRIORITY },
    WithheldSettingsEntry,
  )), 'server-sidebar: withhold the link-opening settings row')
  ctx.effect(() => ctx.slots.inject('settings.general.item', () => ctx.slots.register(
    { name: 'settings.general.item', id: 'composer-enter', priority: REPLACING_PRIORITY },
    WithheldSettingsEntry,
  )), 'server-sidebar: withhold the composer-enter settings row')
  ctx.effect(() => ctx.slots.inject('settings.general.item', () => ctx.slots.register(
    { name: 'settings.general.item', id: 'developer-tools', priority: REPLACING_PRIORITY },
    WithheldSettingsEntry,
  )), 'server-sidebar: withhold the developer-tools settings row')
  ctx.effect(() => ctx.slots.inject('settings.action', () => ctx.slots.register(
    { name: 'settings.action', id: 'open-document', priority: REPLACING_PRIORITY },
    WithheldSettingsEntry,
  )), 'server-sidebar: withhold the open-document settings action')
}
