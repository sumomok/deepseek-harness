/**
 * Whether the organization plugin's settings section is on the Settings page.
 *
 * The identity row's menu offers 组织 (Organization) only while the section
 * that entry opens exists. The section is the browser half of the
 * organization plugin's row: a disabled or incompatible row ships no client
 * bundle, registers no section, and so takes the menu entry away with it. The
 * read is of the slot's shadowing winners, the same rows the Settings page
 * draws, so a section another entry shadows under the same id counts as the
 * shadowing entry does.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/org-section
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls ui-settings' declaration of `settings.section`.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

/**
 * The organization plugin's `settings.section` id. It is an agreement with
 * that plugin, which registers its section under it, and with
 * `dsh-client-ui-settings-general`'s navigation table, which files the id
 * under 账户与用量 (Account & usage).
 */
export const ORG_SECTION_ID = 'sumomok-org'

/**
 * Observe whether a `settings.section` winner carries {@link ORG_SECTION_ID}.
 * A subscription made before the slot is declared is kept and fires once the
 * declaration and the section arrive.
 * @param slots - the client slot registry.
 * @returns a boolean source, recomputed only when the slot's version moves.
 */
export function createOrgSectionSource(slots: Pick<SlotRegistry, 'entriesOfSlot' | 'getVersion' | 'subscribe'>): HostObservable<boolean> {
  let version: number | undefined
  let present = false
  return {
    getSnapshot: () => {
      const next = slots.getVersion('settings.section')
      if (next !== version) {
        version = next
        present = slots.entriesOfSlot('settings.section').some(entry => entry.options.id === ORG_SECTION_ID)
      }
      return present
    },
    subscribe: listener => slots.subscribe('settings.section', listener),
  }
}
