/**
 * Two-level settings navigation: the shell's fixed group table and the
 * projection that files `settings.section` rows under it.
 *
 * The table lives in the shell because a `settings.section` registration
 * carries only `key`/`id`/`order`/`label`/`priority` — a registrant cannot
 * name a group — and a browser plugin receives no cordis.yml config: the
 * client boot wire carries `id`/`inject`/`immediately` per row
 * (`@deepseek-ai/dsh-client-modules` `BootPluginRow`) and the loader creates
 * each entry by name alone. A client-face `apply` may still declare a `Config`
 * parameter (`ui-conversation` does), but with no config on the wire such a
 * parameter only materializes its schema defaults. Grouping is therefore by
 * section id, here.
 *
 * A section id the table does not name keeps its row: it lands in the
 * trailing `other` group in ledger order, so a plugin the shell never heard
 * of stays reachable.
 */
import type { SettingsKey } from './locales.ts'
import type { SettingsSectionRow } from './shell-contract.ts'

/** Top-level nav group keys, in the order the rail draws them. */
export type SettingsNavGroupKey =
  | 'general' | 'models' | 'agent' | 'extensions' | 'account' | 'about' | 'other'

/** One group of the fixed table: its dictionary key and the section ids it claims, in display order. */
interface SettingsNavGroupSpec {
  key: SettingsNavGroupKey
  label: SettingsKey
  sections: readonly string[]
}

/**
 * The claimed groups, in rail order. Ids name sections this product composes:
 * the four upstream ones (`general`, `models`, `plugins`, `agent-presets`)
 * plus the sections the fork's bundled plugins register. An id absent from
 * the running composition contributes nothing.
 */
const NAV_GROUPS: readonly SettingsNavGroupSpec[] = [
  { key: 'general', label: 'nav.group.general', sections: ['general', 'at-file'] },
  { key: 'models', label: 'nav.group.models', sections: ['models', 'vision-switch'] },
  { key: 'agent', label: 'nav.group.agent', sections: ['agent-presets', 'llm-permission-gateway'] },
  { key: 'extensions', label: 'nav.group.extensions', sections: ['plugins', 'mcp-servers', 'screenshot-logins'] },
  { key: 'account', label: 'nav.group.account', sections: ['balance'] },
  { key: 'about', label: 'nav.group.about', sections: ['desktop-update'] },
]

/** The trailing group for every section id the table does not claim. */
const OTHER_GROUP: SettingsNavGroupSpec = { key: 'other', label: 'nav.group.other', sections: [] }

/** Every id the table claims — membership test for the trailing group. */
const CLAIMED = new Set(NAV_GROUPS.flatMap(group => group.sections))

/** One drawn group: its title copy and the rows beneath it, both non-empty. */
export interface SettingsNavGroup {
  key: SettingsNavGroupKey
  label: SettingsKey
  rows: readonly SettingsSectionRow[]
}

/**
 * File ordered nav rows under the fixed group table.
 *
 * Claimed groups keep the table's member order rather than the ledger's, so
 * the rail reads the same whatever `order` the registrants chose; the
 * trailing `other` group keeps ledger order. A group with no present member
 * is dropped, so an absent plugin leaves no empty title behind.
 * @param rows - nav rows in ledger (ascending `order`) sequence.
 * @returns the occupied groups, in rail order.
 */
export function groupNavRows(rows: readonly SettingsSectionRow[]): readonly SettingsNavGroup[] {
  const groups = [...NAV_GROUPS, OTHER_GROUP].map(spec => ({
    key: spec.key,
    label: spec.label,
    rows: spec.key === OTHER_GROUP.key
      ? rows.filter(row => !CLAIMED.has(row.id))
      : spec.sections.flatMap((id) => {
        const row = rows.find(candidate => candidate.id === id)
        return row === undefined ? [] : [row]
      }),
  }))
  return groups.filter(group => group.rows.length > 0)
}
