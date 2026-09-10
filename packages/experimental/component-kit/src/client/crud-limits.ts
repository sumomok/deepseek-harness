/**
 * The ceilings and the charsets `toy.crud` holds its reports to.
 *
 * Their own module, importing nothing, because two packages have to agree on
 * them: this row reduces a page's event to a report, and the placement
 * package's catalog decides whether that report is admitted. A declaration
 * that drifted apart would make this block report gestures that catalog
 * silently refuses, so `component-surface` pins {@link CRUD_REPORT_LIMITS}
 * against its own `MAX_CRUD_*` and field-name constants in its test lane
 * rather than leaving a comment to hold the pair together.
 * @module @deepseek-ai/dsh-experimental-component-kit/src/client/crud-limits
 */

/** Columns one load names before it counts the rest. */
export const MAX_REPORTED_COLUMNS = 20

/** Cells one clicked row reports: the first drawn columns, in the page's own order. */
export const MAX_REPORTED_CELLS = 16

/** Longest reported cell value, in characters; a longer one is cut and ends in an ellipsis. */
export const MAX_CELL_LENGTH = 40

/** Longest reported column header, in characters; a longer one is cut the same way. */
export const MAX_HEADER_LENGTH = 24

/** Longest attribute name a report carries: a column's attribute, and every key of a reported row. */
export const MAX_ATTRIBUTE_LENGTH = 64

/** What an attribute name may be made of. */
export const ATTRIBUTE_NAME = /^[A-Za-z_][\w-]*$/

/**
 * Widest number a reported cell or count carries.
 *
 * The catalog admits a number a record can be read back out of, which is an
 * integer JSON carries exactly; a backend id past this is one `JSON.parse`
 * already rounded, so a report carrying it would be both refused and wrong.
 */
export const MAX_REPORTED_NUMBER = Number.MAX_SAFE_INTEGER

/** The attribute a load's column list is unique by: one entry per attribute, whatever the scheme draws twice. */
const UNIQUE_COLUMN_BY = 'attr'

/**
 * Every declaration as one record, for the placement package to pin against
 * the catalog that declares them: each pair must be one value, or a gesture
 * this block reports is one the catalog refuses.
 */
export const CRUD_REPORT_LIMITS = Object.freeze({
  columns: MAX_REPORTED_COLUMNS,
  cells: MAX_REPORTED_CELLS,
  cellLength: MAX_CELL_LENGTH,
  headerLength: MAX_HEADER_LENGTH,
  attributeLength: MAX_ATTRIBUTE_LENGTH,
  attributeCharset: ATTRIBUTE_NAME,
  number: MAX_REPORTED_NUMBER,
  uniqueColumnBy: UNIQUE_COLUMN_BY,
})
