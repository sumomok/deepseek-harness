/**
 * The words the picker and the attachment row state a point in, and the names
 * a reference shows, built from this package's dictionary in the console's
 * locale.
 * @module @deepseek-ai/dsh-experimental-content-point/client/words
 */

import { DATA_PAGE_REGIONS, DESCRIBE_REFUSALS, ZH_LABEL_WORDS } from '@haoran/dsh-point-anchor'
import type { DescribeRefusal, LabelWords } from '@haoran/dsh-point-anchor'
import { zh } from './locales.ts'
import type { ContentPointKey } from './locales.ts'
import { WHOLE_BLOCK_REASONS } from './pick.ts'
import type { PointNames } from './pick.ts'

/** A locale lookup in this package's namespace. */
export type Translate = (key: ContentPointKey, params?: Record<string, unknown>) => string

/**
 * Whether a key is one of this package's dictionary.
 * @param key - the candidate.
 * @returns the answer.
 */
function isKey(key: string): key is ContentPointKey {
  return Object.hasOwn(zh, key)
}

/**
 * The words of a key the dictionary may hold, else of a general key.
 * @param t - the lookup.
 * @param key - the key, built from a component id, a seat kind or a role.
 * @param otherwise - the key looked up when the dictionary holds no `key`.
 * @returns the words.
 */
function named(t: Translate, key: string, otherwise: ContentPointKey): string {
  return t(isKey(key) ? key : otherwise)
}

/**
 * The words a place is labelled in, in the locale.
 * @param t - the lookup.
 * @returns point-anchor's label words.
 */
export function labelWords(t: Translate): LabelWords {
  return {
    regions: Object.fromEntries(DATA_PAGE_REGIONS.map(region => [region, t(`label.region.${region}`)])) as LabelWords['regions'],
    roles: Object.fromEntries(Object.keys(ZH_LABEL_WORDS.roles).map(name => [name, named(t, `label.role.${name}`, 'label.role')])),
    role: t('label.role'),
    header: name => t('label.header', { name }),
    cell: column => t('label.cell', { column }),
    row: t('label.row'),
    operation: name => t('label.operation', { name }),
    button: name => t('label.button', { name }),
    field: name => t('label.field', { name }),
    control: (roleName, name) => t('label.control', { role: roleName, name }),
    nameless: roleName => t('label.nameless', { role: roleName }),
    picture: t('label.picture'),
    nav: title => t('label.nav', { title }),
    untitledNav: t('label.untitledNav'),
  }
}

/**
 * The words the picker's tooltip states a refusal in, in the locale: every
 * refusal that becomes a block reference as the whole block.
 * @param t - the lookup.
 * @returns the words, one per refusal.
 */
export function refusalWords(t: Translate): Record<DescribeRefusal, string> {
  return Object.fromEntries(DESCRIBE_REFUSALS.map(reason => [
    reason, WHOLE_BLOCK_REASONS.has(reason) ? t('picker.block') : t(`refusal.${reason}`),
  ])) as Record<DescribeRefusal, string>
}

/**
 * The names a reference shows, in the locale.
 * @param t - the lookup.
 * @returns the names.
 */
export function pointNames(t: Translate): PointNames {
  return {
    component: component => (component === undefined ? t('block.component') : named(t, `block.${component}`, 'block.component')),
    seat: seat => named(t, `seat.${seat}`, 'seat.other'),
    role: name => named(t, `label.role.${name}`, 'label.role'),
    cellControl: (column, role) => t('label.cellControl', { column, role }),
    tableItem: role => t('label.tableItem', { role }),
  }
}
