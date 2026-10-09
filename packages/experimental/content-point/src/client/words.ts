/**
 * The words the picker and the attachment row state a point in, and the names
 * a reference shows, built from this package's dictionary in the console's
 * locale.
 * @module @deepseek-ai/dsh-experimental-content-point/client/words
 */

import { DATA_PAGE_REGIONS, DESCRIBE_REFUSALS, ZH_LABEL_WORDS } from '@haoran/dsh-point-anchor'
import type { DescribeRefusal, LabelWords } from '@haoran/dsh-point-anchor'
import type { ContentPointKey } from './locales.ts'
import { WHOLE_BLOCK_REASONS } from './pick.ts'
import type { PointNames } from './pick.ts'

/** Component ids whose display name the locale holds. */
const NAMED_COMPONENTS: ReadonlySet<string> = new Set([
  'toy.data-page', 'toy.form-page', 'toy.info-card', 'toy.table', 'toy.record', 'el.metric', 'el.filter-bar', 'el.confirm-bar',
])

/** Seat kinds whose display name the locale holds. */
const NAMED_SEATS: ReadonlySet<string> = new Set(['component', 'page', 'office'])

/** Roles whose name the locale holds: describe format 1's. */
const NAMED_ROLES: ReadonlySet<string> = new Set(Object.keys(ZH_LABEL_WORDS.roles))

/** A locale lookup in this package's namespace. */
export type Translate = (key: ContentPointKey, params?: Record<string, unknown>) => string

/**
 * The words a place is labelled in, in the locale.
 * @param t - the lookup.
 * @returns point-anchor's label words.
 */
export function labelWords(t: Translate): LabelWords {
  return {
    regions: Object.fromEntries(DATA_PAGE_REGIONS.map(region => [region, t(`label.region.${region}`)])) as LabelWords['regions'],
    roles: Object.fromEntries([...NAMED_ROLES].map(name => [name, t(`label.role.${name}` as ContentPointKey)])),
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
    component: component => (component !== undefined && NAMED_COMPONENTS.has(component)
      ? t(`block.${component}` as ContentPointKey)
      : t('block.component')),
    seat: seat => t(NAMED_SEATS.has(seat) ? `seat.${seat}` as ContentPointKey : 'seat.other'),
    role: name => (NAMED_ROLES.has(name) ? t(`label.role.${name}` as ContentPointKey) : t('label.role')),
    cellControl: (column, role) => t('label.cellControl', { column, role }),
    tableItem: role => t('label.tableItem', { role }),
  }
}
