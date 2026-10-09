/**
 * What of a point-anchor description a reference may carry: the place's
 * structure, never a record's values.
 *
 * A DataPage description loses its row. An original-system page's control
 * inside a table cell is named by its column and role only, because its
 * accessible name is the cell's text, which is the record's own — a project
 * title, a person, a phone number: its anchor keeps `page`, `column`, `role`
 * and `in`, and its display target is the column. An original-system place
 * without an anchor keeps no display target, since what it would show is the
 * same text. The browser applies this before a reference is filed, and the
 * host again before it writes the model text, whatever a logged payload holds.
 * @module @deepseek-ai/dsh-experimental-content-point/place
 */

import { CELL_ROLES, POINT_LIMITS, sanitizeLabel } from '@haoran/dsh-point-anchor'
import type { Anchor, PointDescription } from '@haoran/dsh-point-anchor'

/** A frame anchor of a control in a table cell, as a reference carries it. */
export interface CellControlAnchor {
  readonly kind: 'frame'
  readonly page: string
  readonly column: string
  readonly role: string
  readonly in?: string
}

/**
 * Whether an anchor names a control inside a table cell of an original-system
 * page: a frame anchor with a column whose role is not the cell's own.
 * @param anchor - the anchor.
 * @returns the answer.
 */
export function isCellControl(anchor: Anchor | undefined): anchor is Anchor & CellControlAnchor {
  return anchor?.kind === 'frame' && anchor.column !== undefined && !CELL_ROLES.has(anchor.role)
}

/**
 * The anchor a reference carries for a place: a control in a table cell
 * without its name, mark or position.
 * @param anchor - the anchor the page described.
 * @returns the anchor to carry.
 */
function carriedAnchor(anchor: Anchor): Anchor {
  if (!isCellControl(anchor)) return anchor
  return { kind: 'frame', page: anchor.page, column: anchor.column, role: anchor.role, ...anchor.in !== undefined ? { in: anchor.in } : {} }
}

/**
 * A description as a reference may carry it: no DataPage row, no record text
 * of an original-system page.
 * @param point - the description.
 * @returns the description to carry.
 */
export function forReference(point: PointDescription): PointDescription {
  const anchor = point.anchor === undefined ? undefined : carriedAnchor(point.anchor)
  const frame = point.what.kind === 'frame'
  const target = frame && (anchor === undefined || isCellControl(anchor))
    ? (isCellControl(anchor) ? anchor.column : undefined)
    : point.shown.target
  return {
    v: point.v,
    anchorFormat: point.anchorFormat,
    what: point.what,
    ...anchor !== undefined ? { anchor } : {},
    ...point.unanchored !== undefined ? { unanchored: point.unanchored } : {},
    shown: {
      ...point.shown.nav !== undefined ? { nav: point.shown.nav } : {},
      ...point.shown.page !== undefined ? { page: point.shown.page } : {},
      ...target !== undefined ? { target } : {},
    },
  }
}

/** The words the two labels of {@link placeLabel} are written in. */
export interface PlaceWords {
  /**
   * A role's name.
   * @param role - the role.
   * @returns the name.
   */
  readonly role: (role: string) => string
  /**
   * A control in a table cell, by its column.
   * @param column - the column header text.
   * @param role - the role's name.
   * @returns the label.
   */
  readonly cellControl: (column: string, role: string) => string
  /**
   * A place in a table whose column cannot be told.
   * @param role - the role's name.
   * @returns the label.
   */
  readonly tableItem: (role: string) => string
}

/**
 * The label of a place whose name {@link forReference} leaves out, where
 * point-anchor's own would name it by text it no longer carries: a control in
 * a table cell, and an original-system place no column can be told for.
 * @param point - a description as {@link forReference} returned it.
 * @param words - the words to write the label in.
 * @returns the label, 1–64 code points, or undefined for every other place.
 */
export function placeLabel(point: PointDescription, words: PlaceWords): string | undefined {
  const bound = (label: string): string => sanitizeLabel(label, POINT_LIMITS.labelCodePoints)
  if (isCellControl(point.anchor)) return bound(words.cellControl(point.anchor.column, words.role(point.anchor.role)))
  if (point.what.kind === 'frame' && point.anchor === undefined && point.unanchored === 'no-column') return bound(words.tableItem(words.role(point.what.role)))
  return undefined
}
