/**
 * The ceilings and the charsets `toy.data-page` holds its reports to.
 *
 * Their own module, importing nothing, because two packages have to agree on
 * them: this row reduces a page's event to a report, and the placement
 * package's catalog decides whether that report is admitted. A declaration
 * that drifted apart would make this block report gestures that catalog
 * silently refuses, so `component-surface` pins {@link DATA_PAGE_REPORT_LIMITS}
 * against its own `MAX_DATA_PAGE_*` and field-name constants in its test lane
 * rather than leaving a comment to hold the pair together.
 * @module @deepseek-ai/dsh-experimental-component-kit/src/client/data-page-limits
 */

/** Columns one load names before it counts the rest. */
export const MAX_REPORTED_COLUMNS = 20

/** Cells one reported row carries: the first drawn columns, in the page's own order. */
export const MAX_REPORTED_CELLS = 16

/** Longest reported cell value, in characters; a longer one is cut and ends in an ellipsis. */
export const MAX_CELL_LENGTH = 40

/** Longest reported column header, in characters; a longer one is cut the same way. */
export const MAX_HEADER_LENGTH = 24

/** Longest attribute name a report carries: a column's attribute, and every key of a reported row. */
export const MAX_ATTRIBUTE_LENGTH = 64

/** What an attribute name may be made of. */
export const ATTRIBUTE_NAME = /^[A-Za-z_][\w-]*$/

/** Rights one load names out of the record this deployment answered with. */
export const MAX_REPORTED_RIGHTS = 16

/** Longest reported right key, in characters; a longer key is left out rather than cut, because a cut key names nothing. */
export const MAX_RIGHT_LENGTH = 24

/** Fields one saved record reports: what names the record, and no more of the form. */
export const MAX_SAVED_FIELDS = 8

/** Ticked rows one selection counts before the count itself is one the catalog refuses. */
export const MAX_TICKED_ROWS = 500

/** Ticked rows one selection names before it leaves the rest to the count. */
export const MAX_NAMED_ROWS = 5

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
 * The two exports the page's toolbar submits, as the page's own event names
 * them: the template export and the table export.
 *
 * A closed set here as well as in the catalog, so a payload naming a third
 * export is not reported at all rather than reported and refused.
 */
export const EXPORT_MODES: readonly string[] = ['excel', 'grid_csv']

/**
 * Why a page-level refusal was decided, as the page's own event spells it: the
 * rights this deployment holds for this user were answered and hold no row for
 * the table, or they could not be obtained at all.
 *
 * A closed set here as well as in the catalog, and declared as its own literals
 * so a reason the page starts sending that neither knows is reported as absent
 * rather than passed through and refused.
 */
export const DENIED_REASONS = ['no-row', 'no-rights-table'] as const

/**
 * Widest answer code one refused sign-in reports.
 *
 * The page reports the code of the answer that refused it, or zero where it had
 * no sign-in to present and no request left at all; a value outside that range
 * is not an answer this row can state.
 */
export const MAX_AUTH_STATUS = 599

/**
 * Longest reported business code, in characters.
 *
 * A longer one is left out rather than cut, for the same reason a right key is:
 * a cut code names nothing, and the answer code beside it is the part of the
 * refusal that is always there.
 */
export const MAX_AUTH_CODE_LENGTH = 24

/**
 * Every declaration as one record, for the placement package to pin against
 * the catalog that declares them: each pair must be one value, or a gesture
 * this block reports is one the catalog refuses.
 */
export const DATA_PAGE_REPORT_LIMITS = Object.freeze({
  columns: MAX_REPORTED_COLUMNS,
  cells: MAX_REPORTED_CELLS,
  cellLength: MAX_CELL_LENGTH,
  headerLength: MAX_HEADER_LENGTH,
  attributeLength: MAX_ATTRIBUTE_LENGTH,
  attributeCharset: ATTRIBUTE_NAME,
  rights: MAX_REPORTED_RIGHTS,
  rightLength: MAX_RIGHT_LENGTH,
  savedFields: MAX_SAVED_FIELDS,
  tickedRows: MAX_TICKED_ROWS,
  namedRows: MAX_NAMED_ROWS,
  number: MAX_REPORTED_NUMBER,
  uniqueColumnBy: UNIQUE_COLUMN_BY,
  exportModes: EXPORT_MODES,
  deniedReasons: DENIED_REASONS,
  authStatus: MAX_AUTH_STATUS,
  authCodeLength: MAX_AUTH_CODE_LENGTH,
})
