/**
 * Everything the three reads compute, as pure functions of what the backend
 * answered.
 *
 * Nothing here reaches a network, a clock, or a session: one answer reduces to
 * one value, so a listing is the same listing on every host and in every
 * replay. Order is by code unit rather than by locale for the same reason — a
 * listing sorted by the host's collation would put the same models in a
 * different order on two machines, and a cursor built out of that order would
 * skip or repeat rows between two calls.
 * @module @deepseek-ai/dsh-experimental-system-map/reduce
 */

import type {
  BizModelRights,
  BizModelSummary,
  BizScheme,
  BizSchemeFormItem,
  BizUserRights,
} from '@deepseek-ai/dsh-experimental-biz-backend'
import type {
  AttributeEntry,
  AttributeValue,
  DomainEntry,
  MapBounds,
  ModelEntry,
} from './types.ts'
import type { BizMetaAttribute } from '@deepseek-ai/dsh-experimental-biz-backend'

/**
 * The code stood in for a model this deployment files under no subject area.
 *
 * A fixed word rather than a configured one: it is the name a caller passes
 * back to list those models, so a deployment that moved it would move a value
 * the model reads out of one answer and writes into the next.
 */
export const UNFILED = 'UNFILED'

/**
 * The scheme kinds this read names, by the schema service's own numbering.
 *
 * An external specification: the deployment's own frontend writes these same
 * four numbers when it opens a resource list, an add form, an edit form and an
 * information card. A scheme stored under any other number is left out of
 * every answer, because it is not one of the four a person is ever shown.
 */
export const SCHEME_FORMS: ReadonlyMap<number, string> = new Map([
  [1, 'query'],
  [2, 'add'],
  [3, 'modify'],
  [4, 'card'],
])

/** The two scheme kinds a person fills in, and therefore the two that say what a value must be. */
const EDITING_SCHEME_TYPES: readonly number[] = [2, 3]

/** The name given to an attribute a scheme's table lists. */
const GRID_FORM = 'grid'

/**
 * The order the form names are listed in: a person meets them in this order,
 * finding a row in a list before opening it, and adding one before editing it.
 *
 * Listing them in the order the schemes happen to be read would put the table
 * ahead of the search form for one attribute and behind it for the next, which
 * is a difference a reader would take to mean something.
 */
const FORM_ORDER: readonly string[] = ['query', GRID_FORM, 'add', 'modify', 'card']

/**
 * Compare two names by code unit.
 * @param left - the first name.
 * @param right - the second name.
 * @returns negative, zero, or positive as the first sorts before, with, or after the second.
 */
export function compareNames(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

/**
 * The subject area one model is filed under.
 * @param summary - the model as the catalog lists it.
 * @returns the code and the name shown for it, both standing in where the catalog states neither.
 */
export function domainOf(summary: BizModelSummary): { domain: string; name: string } {
  const domain = summary.classDiagramType ?? UNFILED
  return { domain, name: summary.classDiagramTypeCnName ?? domain }
}

/**
 * Group one catalog into subject areas.
 *
 * The name shown for a subject area is taken from the first model filed under
 * it in English-name order, so a catalog whose entries disagree about that name
 * still reduces to one listing rather than to two spellings of one code.
 * @param models - the deployment's whole catalog.
 * @returns one entry per subject area, in code order.
 */
export function groupDomains(models: readonly BizModelSummary[]): readonly DomainEntry[] {
  const counted = new Map<string, { name: string; models: number }>()
  for (const summary of [...models].sort((left, right) => compareNames(left.resClassEnName, right.resClassEnName))) {
    const { domain, name } = domainOf(summary)
    const seen = counted.get(domain)
    if (seen === undefined) counted.set(domain, { name, models: 1 })
    else seen.models += 1
  }
  return [...counted]
    .map(([domain, { name, models: held }]) => ({ domain, name, models: held }))
    .sort((left, right) => compareNames(left.domain, right.domain))
}

/**
 * The subject area one request names.
 *
 * The code is tried before the name shown, because the code is what a listing
 * gives a caller to pass back and the name is what a person says out loud.
 * @param domains - the grouped catalog.
 * @param wanted - what the request named.
 * @returns the subject area, or `undefined` when this deployment has none of that code or name.
 */
export function resolveDomain(
  domains: readonly DomainEntry[],
  wanted: string,
): DomainEntry | undefined {
  return domains.find(entry => entry.domain === wanted) ?? domains.find(entry => entry.name === wanted)
}

/**
 * The model one request names.
 *
 * The English name is tried before the name shown, for the reason a subject
 * area's code is. Two models sharing one shown name resolve to the one that
 * sorts first by English name, so the same request reaches the same model every
 * time rather than whichever the catalog happened to list first.
 * @param models - the deployment's whole catalog.
 * @param wanted - what the request named.
 * @returns the model, or `undefined` when this deployment has none of that name.
 */
export function resolveModel(
  models: readonly BizModelSummary[],
  wanted: string,
): BizModelSummary | undefined {
  const sorted = [...models].sort((left, right) => compareNames(left.resClassEnName, right.resClassEnName))
  return sorted.find(summary => summary.resClassEnName === wanted)
    ?? sorted.find(summary => summary.resClassCnName === wanted)
}

/**
 * What this deployment records about one model, cut to the deployment's ceiling.
 *
 * The short note is preferred over the long description, and the long one is
 * read only where there is no short one: a catalog of a thousand models is
 * listed a line at a time, and a listing carrying a paragraph per model is one
 * a model pays for and cannot read.
 * @param summary - the model as the catalog lists it.
 * @param noteChars - most characters a note may contribute.
 * @returns the note, or `undefined` when the deployment records none.
 */
export function noteOf(summary: BizModelSummary, noteChars: number): string | undefined {
  const note = summary.remark ?? summary.resClassDescription
  if (note === undefined) return undefined
  return note.length <= noteChars ? note : note.slice(0, noteChars)
}

/**
 * The rights table as a lookup by model.
 * @param rights - what the rights read answered.
 * @returns one row per model the table names.
 */
export function rightsByModel(rights: BizUserRights): ReadonlyMap<string, BizModelRights> {
  return new Map(rights.resclass.map(row => [row.resclassenname, row]))
}

/**
 * The attributes one rights row narrows editing to.
 * @param row - the rights row, where the table has one for the model.
 * @returns the attribute names, or `undefined` where the row narrows nothing.
 */
export function editableColumns(row: BizModelRights | undefined): readonly string[] | undefined {
  const listed = row?.columns
  if (listed === undefined) return undefined
  const names = listed.split(',').map(name => name.trim()).filter(name => name !== '')
  return names.length === 0 ? undefined : names
}

/**
 * Reduce one subject area's models to the lines a listing carries.
 * @param models - the models filed under the subject area, already narrowed to it.
 * @param rights - the rights table as a lookup by model.
 * @param noteChars - most characters a note may contribute.
 * @returns one entry per model, in English-name order.
 */
export function modelEntries(
  models: readonly BizModelSummary[],
  rights: ReadonlyMap<string, BizModelRights>,
  noteChars: number,
): readonly ModelEntry[] {
  return [...models]
    .sort((left, right) => compareNames(left.resClassEnName, right.resClassEnName))
    .map((summary) => {
      const may = rights.get(summary.resClassEnName)?.operations ?? []
      const note = noteOf(summary, noteChars)
      return {
        model: summary.resClassEnName,
        ...summary.resClassCnName === '' ? {} : { name: summary.resClassCnName },
        ...summary.dsTableName === undefined ? {} : { table: summary.dsTableName },
        ...may.length === 0 ? {} : { may: [...may] },
        ...note === undefined ? {} : { note },
      }
    })
}

/** What one model's schemes say about one attribute. */
interface SchemeFacts {
  /** Which of this deployment's own forms draw the attribute. */
  readonly forms: readonly string[]
  /** Whether a form refuses to save without a value. */
  readonly required?: boolean
  /** Whether the forms let a person change the value. */
  readonly editable?: boolean
  /** The model the attribute takes a row of. */
  readonly picks?: string
  /** The fixed values it offers, before the ceiling is applied. */
  readonly values: readonly AttributeValue[]
}

/**
 * Every form item one scheme draws, keyed by the attribute it edits.
 * @param scheme - the stored scheme.
 * @returns the items, one per attribute; a scheme drawing one attribute twice keeps the first.
 */
function itemsByAttribute(scheme: BizScheme): ReadonlyMap<string, BizSchemeFormItem> {
  const items = new Map<string, BizSchemeFormItem>()
  for (const item of scheme.formItems) {
    if (!items.has(item.relatedMetaAttr)) items.set(item.relatedMetaAttr, item)
  }
  return items
}

/**
 * Read what one model's schemes say about one attribute.
 *
 * The schemes are read in the order the schema service numbers them, so the
 * fixed values and the picked model come from the first form that states them
 * and a second form restating them differently never changes an answer between
 * two calls. A scheme stored under a kind {@link SCHEME_FORMS} does not name is
 * skipped whole: it is not one of the four a person is ever shown. A scheme
 * contributes {@link GRID_FORM} where its table lists the attribute without
 * hiding it, and its own name where its form draws it without hiding it.
 * Whether a value is required, and whether this person may change it, are read
 * from the two forms a person fills in and from no other.
 * @param schemes - the model's default schemes, as the backend listed them.
 * @param attribute - the attribute's English name.
 * @returns what the schemes state.
 */
function schemeFacts(schemes: readonly BizScheme[], attribute: string): SchemeFacts {
  const forms: string[] = []
  let required: boolean | undefined
  let editable: boolean | undefined
  let picks: string | undefined
  let values: readonly AttributeValue[] = []
  for (const scheme of [...schemes].sort((left, right) => left.schemaType - right.schemaType)) {
    const form = SCHEME_FORMS.get(scheme.schemaType)
    if (form === undefined) continue
    if (scheme.columns.some(column => column.relatedMetaAttr === attribute && column.isShow !== false)) {
      if (!forms.includes(GRID_FORM)) forms.push(GRID_FORM)
    }
    const item = itemsByAttribute(scheme).get(attribute)
    if (item === undefined) continue
    if (item.isShow !== false) forms.push(form)
    if (EDITING_SCHEME_TYPES.includes(scheme.schemaType)) {
      if (item.isRequired === true) required = true
      if (item.isEditable === false) editable = false
      else if (item.isEditable === true && editable === undefined) editable = true
    }
    picks ??= item.relatedMeta
    if (values.length === 0 && item.relatedDict !== undefined) {
      values = item.relatedDict.map(entry => ({ stored: entry.key, shown: entry.value }))
    }
  }
  return {
    forms: [...forms].sort((left, right) => FORM_ORDER.indexOf(left) - FORM_ORDER.indexOf(right)),
    ...required === undefined ? {} : { required },
    ...editable === undefined ? {} : { editable },
    ...picks === undefined ? {} : { picks },
    values,
  }
}

/**
 * Reduce one described attribute and what the schemes say about it to one entry.
 * @param attribute - the attribute as the model describes it.
 * @param facts - what the schemes say about it.
 * @param valuesPerAttribute - most fixed values the entry may carry.
 * @returns the entry.
 */
function attributeEntry(
  attribute: BizMetaAttribute,
  facts: SchemeFacts,
  valuesPerAttribute: number,
): AttributeEntry {
  const values = facts.values.slice(0, valuesPerAttribute)
  const moreValues = facts.values.length - values.length
  return {
    attribute: attribute.attributeEnName,
    ...attribute.attributeCnName === '' ? {} : { name: attribute.attributeCnName },
    ...attribute.dataType === undefined ? {} : { type: attribute.dataType },
    ...attribute.dataLength === undefined ? {} : { length: attribute.dataLength },
    ...attribute.isPrimaryKey === undefined ? {} : { key: attribute.isPrimaryKey },
    ...attribute.isNull === undefined ? {} : { nullable: attribute.isNull },
    ...attribute.defaultValue === undefined ? {} : { default: attribute.defaultValue },
    ...attribute.attrGrpName === undefined ? {} : { group: attribute.attrGrpName },
    ...facts.required === undefined ? {} : { required: facts.required },
    ...facts.editable === undefined ? {} : { editable: facts.editable },
    ...facts.forms.length === 0 ? {} : { forms: [...facts.forms] },
    ...facts.picks === undefined ? {} : { picks: facts.picks },
    ...values.length === 0 ? {} : { values },
    ...moreValues === 0 ? {} : { moreValues },
  }
}

/**
 * Reduce one model's attributes and schemes to the lines a read carries.
 * @param attributes - the attributes as the model describes them.
 * @param schemes - the model's default schemes.
 * @param bounds - the deployment's ceilings.
 * @returns one entry per attribute, in English-name order.
 */
export function attributeEntries(
  attributes: readonly BizMetaAttribute[],
  schemes: readonly BizScheme[],
  bounds: MapBounds,
): readonly AttributeEntry[] {
  return [...attributes]
    .sort((left, right) => compareNames(left.attributeEnName, right.attributeEnName))
    .map(attribute => attributeEntry(
      attribute,
      schemeFacts(schemes, attribute.attributeEnName),
      bounds.valuesPerAttribute,
    ))
}

/** One listing's worth of entries, and where it stopped. */
export interface Page<T> {
  /** The entries this answer carries. */
  readonly items: readonly T[]
  /** How far into the whole listing this answer reaches. */
  readonly to: number
  /** Whether it stops short of the whole listing. */
  readonly truncated: boolean
  /** The key to pass back to continue; present only where it stops short. */
  readonly cursor?: string
}

/**
 * Take as much of one listing as the deployment's character budget allows.
 *
 * The budget is spent on the rendered lines, which is what a model actually
 * reads, and the first entry is always taken: an entry longer than the whole
 * budget is carried alone and the listing is marked cut, because a listing that
 * took nothing would hand back the cursor it was given and a caller following
 * that cursor would never move.
 * @param sorted - the whole listing, already in key order.
 * @param after - the key a previous answer stopped at, where the request continues one.
 * @param keyOf - the key of one entry, which is also the cursor it is continued from.
 * @param lineOf - the rendered line of one entry.
 * @param budget - characters the lines may spend between them.
 * @returns the entries taken and where they stop.
 */
export function pageWithin<T>(
  sorted: readonly T[],
  after: string | undefined,
  keyOf: (item: T) => string,
  lineOf: (item: T) => string,
  budget: number,
): Page<T> {
  const start = after === undefined ? 0 : sorted.findIndex(item => compareNames(keyOf(item), after) > 0)
  if (start < 0) return { items: [], to: sorted.length, truncated: false }
  const items: T[] = []
  let spent = 0
  for (const item of sorted.slice(start)) {
    const line = lineOf(item)
    if (items.length > 0 && spent + line.length + 1 > budget) {
      return { items, to: start + items.length, truncated: true, cursor: keyOf(items[items.length - 1] as T) }
    }
    items.push(item)
    spent += line.length + 1
  }
  return { items, to: sorted.length, truncated: false }
}
