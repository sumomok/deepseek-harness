/**
 * `dataSource` — the one parameter that fills a table from the deployment's own
 * data backend instead of from rows the model wrote out.
 *
 * Everything here is pure, and it is everything a read is judged and described
 * by: the parameter's own rules, the sentence the user is asked the question
 * with, the rows a backend answer becomes, and every sentence the model is
 * refused with. The requests themselves — the approval, the two backend calls,
 * the session event — are `tool.ts`'s, so what a read costs the user can be
 * read and tested without a backend anywhere near it.
 *
 * Host-only, and deliberately not part of `component-call.ts`: the browser seat
 * runs that catalog over the payload it receives, and a payload the seat
 * receives has its rows in it already. Nothing about where the rows came from
 * survives into the entry, which is what keeps the seat unchanged by this
 * parameter existing.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/data-source
 */

import {
  FIELD_CHARSET,
  FIELD_HINT,
  MATCH_OPERATOR_IDS,
  MATCH_OPERATORS,
  MAX_COLUMN_ALIAS_LENGTH,
  MAX_CONDITION_VALUE_LENGTH,
  MAX_FIELD_NAME_LENGTH,
  MAX_NODE_ID_LENGTH,
  MAX_NODES,
  MAX_SPEC_BYTES,
  MAX_TABLE_ROWS,
  SHOW_COMPONENT_TOOL_NAME,
  TABLE_ID,
  TOKEN_CHARSET,
  TOKEN_HINT,
} from './component-call.ts'
import { refuse, type ComponentCallFailure } from './validate.ts'

/** Conditions one block's read may carry. */
const MAX_DATA_SOURCE_CONDITIONS = 10

/** Values one `IN`-shaped condition may list. */
const MAX_CONDITION_VALUES = 20

/** Largest accepted table name in the user's own language, in characters. */
const MAX_META_LABEL_LENGTH = 20

/**
 * What a word the model wrote may be made of before a person reads it on the
 * approval card.
 *
 * The card is built by joining these words with punctuation of its own, so a
 * value carrying a line break or a `「」` of its own could draw a line the card
 * never wrote — including the line naming the table in the backend's words,
 * which is the one part of the card a person can check the rest against.
 * Control and format characters go for the same reason plus a second: a
 * right-to-left override or a zero-width joiner changes what a sentence reads
 * as without changing what it says. The two Unicode separators that break a
 * line without being control characters — `U+2028` and `U+2029` — go with them,
 * because a renderer that honours either draws exactly the line this rule
 * exists to keep the model from drawing. `\p{Zs}` stays accepted: an ordinary
 * space between words breaks nothing.
 */
const CARD_TEXT_CHARSET = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}「」]+$/u

/** Model-facing wording of {@link CARD_TEXT_CHARSET}, spliced into every refusal that states it. */
const CARD_TEXT_HINT = 'one line of plain text, carrying no line break, no other control character, and no 「」 bracket'

/** Columns the approval sentence names before it stops naming them and counts the rest. */
const MAX_NAMED_COLUMNS = 3

/**
 * Characters the approval card's prose is held to, across every table it covers.
 *
 * A card nobody reads to the end is a card that consented to nothing, so each
 * table's description is cut to its share of this budget. Two things are never
 * part of what gets cut, and neither counts against the budget: the line naming
 * each table the way the backend names it, which is the one part of the card
 * the model did not write and therefore the part a person checks the rest
 * against, and {@link APPROVAL_PROMISE}. A read covering many tables makes a
 * longer card rather than a card that has quietly stopped saying what it reads.
 */
const MAX_APPROVAL_PROSE_CHARS = 300

/** Attributes a refusal names when the table has no attribute by the name the call sent. */
const MAX_CANDIDATE_ATTRIBUTES = 10

/**
 * The two sentences every approval card ends with, whatever it is asking for.
 *
 * The second half is the one that must be there: a ticked row leaves the panel
 * through `/component-action` and reaches the model as the user's own answer,
 * so a card promising the data stays out of the conversation would be promising
 * something this row does not do. The first half is the part that is true —
 * nothing the backend returned is in the model's request; what the model is
 * told is a count and a list of column names.
 */
export const APPROVAL_PROMISE
  = '取回来的数据画成表格放在右边，小助手看不到表里的内容；您在表里勾选的行，会作为您的选择告诉小助手。'

/** One condition of one block's read, as the call wrote it and validation accepted it. */
export interface DataSourceCondition {
  /** The attribute the condition is about, in the backend's own naming. */
  readonly key: string
  /** The match strategy, one of {@link MATCH_OPERATOR_IDS}. */
  readonly op: string
  /** The wording the user reads for {@link op}; the backend is sent {@link op} itself. */
  readonly label: string
  /**
   * What the attribute is matched against. A list carries text and numbers
   * only: the backend's set comparisons are over identifiers, and a yes-or-no
   * inside one is a value nothing there compares.
   */
  readonly value: string | number | boolean | readonly (string | number)[]
}

/** One block's read, as the call wrote it and validation accepted it. */
export interface DataSourceBlock {
  /** The `toy.table` node in this call's own spec that the rows are put into. */
  readonly nodeId: string
  /** The table's name in the backend. */
  readonly meta: string
  /** The table's name in the user's own language, which is what the approval card shows. */
  readonly metaLabel: string
  /** The conditions, empty where the call sent none. */
  readonly conditions: readonly DataSourceCondition[]
  /** How the conditions join; `'AND'` where the call sent none. */
  readonly matchMode: 'AND' | 'OR'
  /** Rows to ask for, the deployment's own default where the call sent none. */
  readonly pageSize: number
  /** Attribute to sort ascending by, where the call named one. */
  readonly asc?: string
  /** Attribute to sort descending by, where the call named one. */
  readonly desc?: string
}

/** One column of a targeted table, as its `tableConfig.gridItems` declares it. */
export interface DataSourceColumn {
  /** The attribute the column reads its cell out of, which is what the backend is asked for. */
  readonly attr: string
  /** The header the call wrote, where it wrote one. */
  readonly alias?: string
}

/** One block's read resolved against the node it fills. */
export interface DataSourceTarget {
  /** The read itself. */
  readonly block: DataSourceBlock
  /** Where the node sits in `spec.nodes`. */
  readonly nodeIndex: number
  /** The node object as the call wrote it. */
  readonly node: Readonly<Record<string, unknown>>
  /** The node's `props` object as the call wrote it. */
  readonly props: Readonly<Record<string, unknown>>
  /** The node's `props.tableConfig` object as the call wrote it. */
  readonly tableConfig: Readonly<Record<string, unknown>>
  /** The columns the table declares, in the order it declares them. */
  readonly columns: readonly DataSourceColumn[]
}

/** Outcome of reading the `dataSource` parameter on its own. */
export type DataSourceBlocksResult =
  | { readonly ok: true; readonly blocks: readonly DataSourceBlock[] }
  | { readonly ok: false; readonly failure: ComponentCallFailure }

/** Outcome of resolving the reads against the spec they fill. */
export type DataSourceTargetsResult =
  | { readonly ok: true; readonly targets: readonly DataSourceTarget[]; readonly nodes: readonly unknown[] }
  | { readonly ok: false; readonly failure: ComponentCallFailure }

/** One table's rows, ready to be put into the node they were read for. */
export interface DataSourceFill {
  /** The node the rows belong to. */
  readonly target: DataSourceTarget
  /** The drawn rows. */
  readonly displayValueList: readonly Readonly<Record<string, unknown>>[]
  /**
   * The rows behind the drawn ones, one for one. Absent where the backend
   * answered a different number of them, which is a pairing the table's own
   * property cannot express.
   */
  readonly rawValueList?: readonly Readonly<Record<string, unknown>>[]
  /** Headers to write where the call left one out, keyed by attribute name. */
  readonly aliases: ReadonlyMap<string, string>
}

/** One attribute of a table, as the backend's own dictionary declares it. */
export interface DataSourceAttribute {
  /** The attribute's name in the backend. */
  readonly attributeEnName: string
  /** The attribute's name in the user's own language. */
  readonly attributeCnName: string
}

/** The property names one `dataSource` entry may carry. */
const BLOCK_KEYS: readonly string[]
  = ['nodeId', 'meta', 'metaLabel', 'conditions', 'matchMode', 'page', 'asc', 'desc']

/** The property names one condition may carry. */
const CONDITION_KEYS: readonly string[] = ['key', 'op', 'value']

/** The property names one `page` object may carry. */
const PAGE_KEYS: readonly string[] = ['pageSize']

/** How the conditions of one read may join. */
const MATCH_MODES: readonly string[] = ['AND', 'OR']

/**
 * Read one bounded, non-blank string out of an untrusted value.
 * @param value - the value the call wrote.
 * @param path - parameter path used in the refusal.
 * @param maxLength - largest accepted length, in characters.
 * @param charset - the alphabet the value is judged against, where it has one.
 * @returns the string, or the refusal.
 */
function readString(
  value: unknown,
  path: string,
  maxLength: number,
  charset?: { readonly allowed: RegExp; readonly hint: string },
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly failure: ComponentCallFailure } {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, failure: refuse(path, 'must be a non-empty string.') }
  }
  if (value.length > maxLength) {
    return { ok: false, failure: refuse(path, `is ${value.length} characters; at most ${maxLength} are accepted.`) }
  }
  if (charset !== undefined && !charset.allowed.test(value)) {
    return { ok: false, failure: refuse(path, `must be ${charset.hint}.`) }
  }
  return { ok: true, value }
}

/**
 * Read one scalar a condition may be matched against.
 * @param value - the value the call wrote.
 * @param path - parameter path used in the refusal.
 * @param allowBoolean - whether a yes-or-no stands here; it does alone and does not inside a list.
 * @returns the scalar, or the refusal.
 */
function readScalar(
  value: unknown,
  path: string,
  allowBoolean: boolean,
): { readonly ok: true; readonly value: string | number | boolean } | { readonly ok: false; readonly failure: ComponentCallFailure } {
  if (typeof value === 'boolean') {
    if (allowBoolean) return { ok: true, value }
    return { ok: false, failure: refuse(path, 'must be text or a number; a list carries neither yes nor no.') }
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { ok: false, failure: refuse(path, 'must be a finite number.') }
    return { ok: true, value }
  }
  if (typeof value !== 'string') {
    return { ok: false, failure: refuse(path, 'must be text, a number, a yes-or-no, or a list of those.') }
  }
  if (value.length > MAX_CONDITION_VALUE_LENGTH) {
    return {
      ok: false,
      failure: refuse(path, `is ${value.length} characters; at most ${MAX_CONDITION_VALUE_LENGTH} are accepted.`),
    }
  }
  return { ok: true, value }
}

/**
 * Read what one condition matches against, scalar or list.
 * @param value - the value the call wrote.
 * @param path - parameter path used in the refusal.
 * @returns the value, or the refusal.
 */
function readConditionValue(
  value: unknown,
  path: string,
): { readonly ok: true; readonly value: DataSourceCondition['value'] } | { readonly ok: false; readonly failure: ComponentCallFailure } {
  if (!Array.isArray(value)) {
    const scalar = readScalar(value, path, true)
    return scalar.ok ? { ok: true, value: scalar.value } : scalar
  }
  if (value.length === 0 || value.length > MAX_CONDITION_VALUES) {
    return {
      ok: false,
      failure: refuse(path, `lists ${value.length} values; between 1 and ${MAX_CONDITION_VALUES} are accepted.`),
    }
  }
  const items: (string | number)[] = []
  for (const [position, item] of value.entries()) {
    const scalar = readScalar(item, `${path}[${position}]`, false)
    if (!scalar.ok) return scalar
    items.push(scalar.value as string | number)
  }
  return { ok: true, value: items }
}

/**
 * Read one condition of one block's read.
 * @param value - the condition the call wrote.
 * @param path - parameter path used in the refusal.
 * @returns the condition, or the refusal.
 */
function readCondition(
  value: unknown,
  path: string,
): { readonly ok: true; readonly condition: DataSourceCondition } | { readonly ok: false; readonly failure: ComponentCallFailure } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, failure: refuse(path, `must be an object carrying ${CONDITION_KEYS.join(', ')}.`) }
  }
  for (const key of Object.keys(value)) {
    if (!CONDITION_KEYS.includes(key)) {
      return { ok: false, failure: refuse(`${path}.${key}`, `is not part of a condition. A condition carries ${CONDITION_KEYS.join(', ')}.`) }
    }
  }
  const entry = value as { key?: unknown; op?: unknown; value?: unknown }
  const key = readString(entry.key, `${path}.key`, MAX_FIELD_NAME_LENGTH, { allowed: FIELD_CHARSET, hint: FIELD_HINT })
  if (!key.ok) return key
  const operator = MATCH_OPERATORS.find(candidate => candidate.value === entry.op)
  if (operator === undefined) {
    return { ok: false, failure: refuse(`${path}.op`, `must be one of ${MATCH_OPERATOR_IDS.join(', ')}.`) }
  }
  const matched = readConditionValue(entry.value, `${path}.value`)
  if (!matched.ok) return matched
  return { ok: true, condition: { key: key.value, op: operator.value, label: operator.label, value: matched.value } }
}

/**
 * Read how many rows one block asks for.
 * @param value - the `page` object the call wrote, or `undefined`.
 * @param path - parameter path used in the refusal.
 * @param defaultPageSize - what the deployment asks for when the call names no count.
 * @returns the count, or the refusal.
 */
function readPageSize(
  value: unknown,
  path: string,
  defaultPageSize: number,
): { readonly ok: true; readonly pageSize: number } | { readonly ok: false; readonly failure: ComponentCallFailure } {
  if (value === undefined) return { ok: true, pageSize: defaultPageSize }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, failure: refuse(path, `must be an object carrying ${PAGE_KEYS.join(', ')}.`) }
  }
  for (const key of Object.keys(value)) {
    if (!PAGE_KEYS.includes(key)) {
      return { ok: false, failure: refuse(`${path}.${key}`, `is not part of a page. A page carries ${PAGE_KEYS.join(', ')}.`) }
    }
  }
  const pageSize = (value as { pageSize?: unknown }).pageSize
  if (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_TABLE_ROWS) {
    return { ok: false, failure: refuse(`${path}.pageSize`, `must be a whole number between 1 and ${MAX_TABLE_ROWS}.`) }
  }
  return { ok: true, pageSize }
}

/**
 * Read one entry of the `dataSource` parameter.
 * @param value - the entry the call wrote.
 * @param path - parameter path used in the refusal.
 * @param defaultPageSize - what the deployment asks for when the entry names no count.
 * @returns the read, or the refusal.
 */
function readBlock(
  value: unknown,
  path: string,
  defaultPageSize: number,
): { readonly ok: true; readonly block: DataSourceBlock } | { readonly ok: false; readonly failure: ComponentCallFailure } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, failure: refuse(path, `must be an object carrying ${BLOCK_KEYS.join(', ')}.`) }
  }
  for (const key of Object.keys(value)) {
    if (!BLOCK_KEYS.includes(key)) {
      return { ok: false, failure: refuse(`${path}.${key}`, `is not part of a data source. A data source carries ${BLOCK_KEYS.join(', ')}.`) }
    }
  }
  const entry = value as Record<string, unknown>
  const nodeId = readString(entry['nodeId'], `${path}.nodeId`, MAX_NODE_ID_LENGTH, { allowed: TOKEN_CHARSET, hint: TOKEN_HINT })
  if (!nodeId.ok) return nodeId
  const meta = readString(entry['meta'], `${path}.meta`, MAX_FIELD_NAME_LENGTH, { allowed: FIELD_CHARSET, hint: FIELD_HINT })
  if (!meta.ok) return meta
  const metaLabel = readString(
    entry['metaLabel'],
    `${path}.metaLabel`,
    MAX_META_LABEL_LENGTH,
    { allowed: CARD_TEXT_CHARSET, hint: CARD_TEXT_HINT },
  )
  if (!metaLabel.ok) return metaLabel
  const conditions: DataSourceCondition[] = []
  const written = entry['conditions']
  if (written !== undefined) {
    if (!Array.isArray(written) || written.length > MAX_DATA_SOURCE_CONDITIONS) {
      return {
        ok: false,
        failure: refuse(`${path}.conditions`, `must be a list of at most ${MAX_DATA_SOURCE_CONDITIONS} conditions.`),
      }
    }
    for (const [position, item] of written.entries()) {
      const condition = readCondition(item, `${path}.conditions[${position}]`)
      if (!condition.ok) return condition
      conditions.push(condition.condition)
    }
  }
  const matchMode = entry['matchMode']
  if (matchMode !== undefined && (typeof matchMode !== 'string' || !MATCH_MODES.includes(matchMode))) {
    return { ok: false, failure: refuse(`${path}.matchMode`, `must be one of ${MATCH_MODES.join(', ')}.`) }
  }
  const page = readPageSize(entry['page'], `${path}.page`, defaultPageSize)
  if (!page.ok) return page
  if (entry['asc'] !== undefined && entry['desc'] !== undefined) {
    return { ok: false, failure: refuse(`${path}.desc`, 'cannot be sent beside asc. Sort by one attribute, in one direction.') }
  }
  const order: { asc?: string; desc?: string } = {}
  for (const direction of ['asc', 'desc'] as const) {
    if (entry[direction] === undefined) continue
    const attribute = readString(entry[direction], `${path}.${direction}`, MAX_FIELD_NAME_LENGTH, { allowed: FIELD_CHARSET, hint: FIELD_HINT })
    if (!attribute.ok) return attribute
    order[direction] = attribute.value
  }
  return {
    ok: true,
    block: {
      nodeId: nodeId.value,
      meta: meta.value,
      metaLabel: metaLabel.value,
      conditions,
      matchMode: matchMode === 'OR' ? 'OR' : 'AND',
      pageSize: page.pageSize,
      ...order,
    },
  }
}

/**
 * Read the whole `dataSource` parameter.
 * @param value - the parameter the call wrote.
 * @param defaultPageSize - what the deployment asks for when an entry names no count.
 * @returns the reads in the order they were written, or the refusal.
 */
export function readDataSourceBlocks(value: unknown, defaultPageSize: number): DataSourceBlocksResult {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_NODES) {
    return {
      ok: false,
      failure: refuse('dataSource', `must be a list of between 1 and ${MAX_NODES} data sources, one per block to fill.`),
    }
  }
  const blocks: DataSourceBlock[] = []
  const claimed = new Set<string>()
  for (const [position, entry] of value.entries()) {
    const block = readBlock(entry, `dataSource[${position}]`, defaultPageSize)
    if (!block.ok) return block
    if (claimed.has(block.block.nodeId)) {
      return {
        ok: false,
        failure: refuse(
          `dataSource[${position}].nodeId`,
          'names a block already filled by an earlier data source. One block is filled once.',
        ),
      }
    }
    claimed.add(block.block.nodeId)
    blocks.push(block.block)
  }
  return { ok: true, blocks }
}

/**
 * Read the columns one targeted table declares.
 * @param tableConfig - the node's `tableConfig` object as the call wrote it.
 * @param path - parameter path used in the refusal.
 * @returns the columns in declaration order, or the refusal.
 */
function readColumns(
  tableConfig: Readonly<Record<string, unknown>>,
  path: string,
): { readonly ok: true; readonly columns: readonly DataSourceColumn[] } | { readonly ok: false; readonly failure: ComponentCallFailure } {
  const gridItems = tableConfig['gridItems']
  if (!Array.isArray(gridItems) || gridItems.length === 0) {
    return { ok: false, failure: refuse(`${path}.gridItems`, 'must be a list of the columns to read, one per column.') }
  }
  const columns: DataSourceColumn[] = []
  for (const [position, item] of gridItems.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, failure: refuse(`${path}.gridItems[${position}]`, 'must be an object naming the attribute the column reads.') }
    }
    const column = item as { relatedMetaAttr?: unknown; alias?: unknown }
    const attr = readString(
      column.relatedMetaAttr,
      `${path}.gridItems[${position}].relatedMetaAttr`,
      MAX_FIELD_NAME_LENGTH,
      { allowed: FIELD_CHARSET, hint: FIELD_HINT },
    )
    if (!attr.ok) return attr
    if (column.alias === undefined) {
      columns.push({ attr: attr.value })
      continue
    }
    // Judged here rather than left to the call's own validation, which runs
    // after the question has been asked: a header is printed on the approval
    // card, so one too long to draw would be found only once the user had
    // consented and the credential had been spent.
    const alias = readString(
      column.alias,
      `${path}.gridItems[${position}].alias`,
      MAX_COLUMN_ALIAS_LENGTH,
      { allowed: CARD_TEXT_CHARSET, hint: CARD_TEXT_HINT },
    )
    if (!alias.ok) return alias
    columns.push({ attr: attr.value, alias: alias.value })
  }
  return { ok: true, columns }
}

/**
 * Resolve every read against the node it fills, before anything is asked of the
 * user or of the backend.
 *
 * The nodes nothing fills are judged here too, on the one point that decides
 * whether the whole call can succeed: a table nobody is reading rows for has to
 * carry its own. Learning that after the user has approved a read and the
 * backend has answered it would spend a person's consent on a call that was
 * never going to be drawable.
 * @param blocks - the reads, already judged on their own.
 * @param spec - the `spec` argument, however malformed.
 * @returns the resolved reads and the nodes they sit in, or the refusal.
 */
export function resolveDataSourceTargets(blocks: readonly DataSourceBlock[], spec: unknown): DataSourceTargetsResult {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return { ok: false, failure: refuse('spec', 'must be an object carrying a nodes array.') }
  }
  const nodes = (spec as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) return { ok: false, failure: refuse('spec.nodes', 'must be an array of nodes.') }
  const targets: DataSourceTarget[] = []
  const filled = new Set<number>()
  for (const [position, block] of blocks.entries()) {
    const path = `dataSource[${position}].nodeId`
    const nodeIndex = nodes.findIndex(node => node !== null && typeof node === 'object' && (node as { id?: unknown }).id === block.nodeId)
    if (nodeIndex < 0) {
      return { ok: false, failure: refuse(path, 'names no block of this call. Name one of the blocks in spec.nodes.') }
    }
    const node = nodes[nodeIndex] as Readonly<Record<string, unknown>>
    if (node['component'] !== TABLE_ID) {
      return { ok: false, failure: refuse(path, `names a ${String(node['component'])} block. Only a ${TABLE_ID} block is filled from a data source.`) }
    }
    const props = node['props']
    if (props === null || typeof props !== 'object' || Array.isArray(props)) {
      return { ok: false, failure: refuse(`spec.nodes[${nodeIndex}].props`, 'must be an object carrying the properties the component declares.') }
    }
    const record = props as Readonly<Record<string, unknown>>
    // Both row lists, not the drawn one alone: the stored list stands behind
    // the drawn rows one for one and is what a reported gesture is answered
    // from, so a call that wrote it and had the drawn rows read for it would
    // put its own values behind rows the card said came out of the backend.
    for (const written of ['displayValueList', 'rawValueList'] as const) {
      if (record[written] === undefined) continue
      return {
        ok: false,
        failure: refuse(
          `spec.nodes[${nodeIndex}].props.${written}`,
          'cannot be sent for a block a data source fills. Send the rows, or name the block in dataSource; not both.',
        ),
      }
    }
    const tableConfig = record['tableConfig']
    if (tableConfig === null || typeof tableConfig !== 'object' || Array.isArray(tableConfig)) {
      return { ok: false, failure: refuse(`spec.nodes[${nodeIndex}].props.tableConfig`, 'must be an object carrying a gridItems list.') }
    }
    const table = tableConfig as Readonly<Record<string, unknown>>
    const columns = readColumns(table, `spec.nodes[${nodeIndex}].props.tableConfig`)
    if (!columns.ok) return columns
    filled.add(nodeIndex)
    targets.push({ block, nodeIndex, node, props: record, tableConfig: table, columns: columns.columns })
  }
  for (const [position, node] of nodes.entries()) {
    if (filled.has(position)) continue
    if (node === null || typeof node !== 'object') continue
    if ((node as { component?: unknown }).component !== TABLE_ID) continue
    const props = (node as { props?: unknown }).props
    if (props !== null && typeof props === 'object' && (props as { displayValueList?: unknown }).displayValueList !== undefined) continue
    return {
      ok: false,
      failure: refuse(
        `spec.nodes[${position}].props.displayValueList`,
        'is required for a block no data source fills. Send its rows, or name it in dataSource.',
      ),
    }
  }
  return { ok: true, targets, nodes }
}

/**
 * Keep the cells this read declared a column for and a table can draw.
 *
 * The first half is what the approval card promised: it told the user which
 * columns this read takes, and a backend answers with the attributes it chose
 * rather than the ones a request named — this one puts its own row identifier
 * in front of every `source` it is given. A key no column declared is therefore
 * dropped here, so nothing outside the answered question reaches the panel or
 * the session log.
 *
 * The second half is what a table row is: text, numbers and yes-or-no, while a
 * backend answers with whatever it holds, nulls and nested records included.
 * Dropping the key rather than writing an empty value is what an absent cell
 * already means to the component, and keeping the key with an undrawable value
 * would refuse the whole read over one blank cell.
 * @param row - one row exactly as the backend answered it.
 * @param asked - the attributes this read declared a column for.
 * @returns the declared cells the table can draw.
 */
export function normalizeRow(row: unknown, asked: ReadonlySet<string>): Readonly<Record<string, unknown>> {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return {}
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (!asked.has(key)) continue
    const drawable = typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))
    if (drawable) kept[key] = value
  }
  return kept
}

/**
 * Put the rows that were read into the spec the call wrote.
 * @param spec - the `spec` argument, as {@link resolveDataSourceTargets} accepted it.
 * @param nodes - that spec's nodes.
 * @param fills - one entry per filled block.
 * @returns a spec carrying the rows, judged by nothing yet.
 */
export function applyDataSourceRows(
  spec: unknown,
  nodes: readonly unknown[],
  fills: readonly DataSourceFill[],
): unknown {
  const byIndex = new Map(fills.map(fill => [fill.target.nodeIndex, fill]))
  const written = nodes.map((node, index) => {
    const fill = byIndex.get(index)
    if (fill === undefined) return node
    // `readColumns` walked `gridItems` in order, so a column and the object it
    // was read out of share an index.
    const declared = fill.target.tableConfig['gridItems'] as readonly unknown[]
    const gridItems = fill.target.columns.map((column, columnIndex) => {
      const alias = fill.aliases.get(column.attr)
      const source = declared[columnIndex]
      return alias === undefined ? source : { ...source as object, alias }
    })
    return {
      ...fill.target.node,
      props: {
        ...fill.target.props,
        tableConfig: { ...fill.target.tableConfig, gridItems },
        displayValueList: fill.displayValueList,
        ...fill.rawValueList === undefined ? {} : { rawValueList: fill.rawValueList },
      },
    }
  })
  return { ...spec as object, nodes: written }
}

/**
 * The stand-in row a call is judged with before anything has been read.
 *
 * One field of text, which is what a table row is at its smallest: the point of
 * the pass it belongs to is everything a call is judged on that the rows have
 * no part in, so the row itself has to be the least a table accepts rather than
 * anything resembling what the backend will answer with.
 */
const PROBE_ROW: Readonly<Record<string, unknown>> = { probe: 'x' }

/**
 * Put a stand-in row into every table a data source fills, so the whole call
 * can be judged before the user is asked anything.
 *
 * Without this, the only judgement a filled block gets is the one after the
 * question has been answered and the credential has been spent — and a title
 * too long, a thirteenth block, a component this deployment does not have, or a
 * thirty-first column has nothing to do with the rows. All of them are the
 * model's to fix, and finding them last would mean a person answering a
 * question for a call that was never drawable.
 *
 * What this pass cannot decide stays behind for the real one: how many rows
 * arrived, and how many bytes the filled call is.
 * @param spec - the `spec` argument, as {@link resolveDataSourceTargets} accepted it.
 * @param nodes - that spec's nodes.
 * @param targets - the resolved reads.
 * @returns the spec with one stand-in row per filled block.
 */
export function probeDataSourceSpec(
  spec: unknown,
  nodes: readonly unknown[],
  targets: readonly DataSourceTarget[],
): unknown {
  return applyDataSourceRows(spec, nodes, targets.map(target => ({
    target,
    displayValueList: [PROBE_ROW],
    aliases: new Map<string, string>(),
  })))
}

/**
 * Name a few of a table's columns for the approval card.
 *
 * Only the headers the call wrote are named. The alternative — falling back to
 * the attribute name the backend keys the column by — would put an identifier
 * on a card an end user reads, and the dictionary that could translate it is
 * read only after this question has been answered. A column with no header of
 * its own is therefore counted rather than named.
 * @param columns - the columns the table declares.
 * @returns the phrase naming them.
 */
function columnPhrase(columns: readonly DataSourceColumn[]): string {
  const written = columns.map(column => column.alias).filter(alias => alias !== undefined)
  if (written.length === 0) return `只取其中 ${columns.length} 列`
  const named = written.slice(0, MAX_NAMED_COLUMNS).join('、')
  if (written.length === columns.length && written.length <= MAX_NAMED_COLUMNS) return `只取「${named}」这几列`
  return `只取「${named}」等 ${columns.length} 列`
}

/**
 * Say what one read is filtered by, without saying what it is filtered against.
 *
 * The values stay out: a condition can carry another person's identifier or a
 * paragraph of text, and neither belongs on a card whose job is to say what is
 * about to be read.
 * @param conditions - the conditions of one read.
 * @returns the phrase, empty where the read carries no conditions.
 */
function conditionPhrase(
  conditions: readonly DataSourceCondition[],
  columns: readonly DataSourceColumn[],
): string {
  if (conditions.length === 0) return ''
  const counted = `，一共 ${conditions.length} 个筛选条件`
  if (conditions.length > 2) return counted
  const headers = new Map(columns.flatMap(column => column.alias === undefined ? [] : [[column.attr, column.alias]]))
  const named: string[] = []
  for (const condition of conditions) {
    const header = headers.get(condition.key)
    // A condition on an attribute the call gave no header to has no name this
    // card may print, so the whole phrase falls back to the count rather than
    // half the conditions being named and half being identifiers.
    if (header === undefined) return counted
    named.push(`「${header} ${condition.label}」`)
  }
  return `，条件是${named.join('、')}`
}

/**
 * What one table's read is described as, in the words the model wrote for it.
 * @param target - the resolved read.
 * @returns the description, without the table's own name in the backend.
 */
function targetDescription(target: DataSourceTarget): string {
  return `从「${target.block.metaLabel}」里取最多 ${target.block.pageSize} 条，`
    + `${columnPhrase(target.columns)}${conditionPhrase(target.block.conditions, target.columns)}。`
}

/**
 * Build the sentence the user is asked one call's whole read with.
 *
 * One card per call rather than one per table: the user consented to a call,
 * and a second card for the same press is a second question about a decision
 * already made. Each table's own name in the backend goes on a line of its own,
 * small print rather than prose — the name in the card's sentence is the one
 * the model wrote, so a person who wants to check what was really asked for has
 * the identifier and a person who does not never reads a term.
 *
 * Every description is cut to its share of {@link MAX_APPROVAL_PROSE_CHARS}
 * before its identifier line is appended, so no amount of text a model writes
 * can push an identifier — or the closing promise — off the card.
 * @param targets - the resolved reads, in the order they were written.
 * @returns the sentence, ending in {@link APPROVAL_PROMISE}.
 */
export function dataSourceApprovalReason(targets: readonly DataSourceTarget[]): string {
  const head = targets.length === 1 ? '用您的账号查一份数据：' : `用您的账号查 ${targets.length} 份数据。\n\n`
  // The blank line between two tables is prose the reader pays for, so it is
  // taken out of the budget before the rest is shared out.
  const separators = 2 * (targets.length - 1)
  const budget = Math.max(1, Math.floor((MAX_APPROVAL_PROSE_CHARS - head.length - separators) / targets.length))
  const entries = targets.map((target) => {
    const description = targetDescription(target)
    const fitted = description.length > budget ? `${description.slice(0, budget - 1)}…` : description
    return `${fitted}\n数据表：${target.block.meta}`
  })
  return `${head}${entries.join('\n\n')}\n\n${APPROVAL_PROMISE}`
}

/** Refusal for a call with no session behind it: nothing can be asked, and nothing can be recorded. */
export const DATA_SOURCE_NO_SESSION
  = `${SHOW_COMPONENT_TOOL_NAME}: this call is not running in a session, so nothing could be read from the data source. `
    + 'Nothing on the panel changed.'

/** Refusal for a process holding no credential of the signed-in visitor. */
export const DATA_SOURCE_UNAUTHENTICATED
  = `${SHOW_COMPONENT_TOOL_NAME}: no signed-in credential is held for this session, so nothing could be read from the `
    + 'data source. Nothing on the panel changed.'

/**
 * Refusal for a read the user did not allow.
 *
 * One sentence for every way the question can end other than a grant — refused,
 * withdrawn, nobody there to answer — because the three are one thing from
 * where the model is sitting: it may not read, and why is the user's business.
 */
export const DATA_SOURCE_NOT_APPROVED
  = `${SHOW_COMPONENT_TOOL_NAME}: the data source was not read, so nothing was drawn. Nothing on the panel changed.`

/**
 * Refusal for a backend that answered something other than rows.
 * @param meta - the table that was asked for.
 * @param status - the HTTP status the backend answered with.
 * @param code - the backend's own code, where it sent one.
 * @param message - the backend's own message, where it sent one.
 * @returns the sentence.
 */
export function dataSourceRejected(meta: string, status: number, code?: number, message?: string): string {
  const said = message === undefined ? '' : `: ${message}`
  const detail = code === undefined ? '' : ` (code ${code}${said})`
  return `${SHOW_COMPONENT_TOOL_NAME}: the data source answered ${status} for "${meta}"${detail} and no rows were read. `
    + 'Nothing on the panel changed.'
}

/**
 * Refusal for a backend nothing reached.
 * @param meta - the table that was asked for.
 * @param detail - what went wrong on the way, as the provider classified it.
 * @returns the sentence.
 */
export function dataSourceUnreachable(meta: string, detail: string): string {
  return `${SHOW_COMPONENT_TOOL_NAME}: the data source could not be reached for "${meta}": ${detail}. `
    + 'Nothing on the panel changed.'
}

/**
 * Refusal for a read that matched nothing.
 * @param meta - the table that was asked for.
 * @returns the sentence.
 */
export function dataSourceEmpty(meta: string): string {
  return `${SHOW_COMPONENT_TOOL_NAME}: "${meta}" returned no rows for those conditions, so there is nothing to draw. `
    + 'Nothing on the panel changed.'
}

/**
 * Refusal for rows that arrived and do not fit.
 * @param meta - the table that was asked for.
 * @param rows - how many rows arrived.
 * @param bytes - how large the filled spec is.
 * @returns the sentence.
 */
export function dataSourceOversize(meta: string, rows: number, bytes: number): string {
  return `${SHOW_COMPONENT_TOOL_NAME}: "${meta}" returned ${rows} rows and the filled spec is ${bytes} bytes of JSON; `
    + `at most ${MAX_SPEC_BYTES} are accepted. Ask for fewer rows or fewer columns.`
}

/**
 * Refusal for rows that arrived and cannot be drawn for some other reason.
 * @param meta - the table that was asked for.
 * @param detail - the refusal the filled spec was judged with, from its path onwards.
 * @returns the sentence.
 */
export function dataSourceUndrawable(meta: string, detail: string): string {
  return `${SHOW_COMPONENT_TOOL_NAME}: the rows read from "${meta}" cannot be drawn — ${detail} `
    + 'Nothing on the panel changed.'
}

/**
 * Refusal for a column naming an attribute the table does not have.
 *
 * The whole point of asking the backend for its dictionary before reading is
 * this sentence: a misspelt attribute is not an error anywhere downstream, it
 * is a column that draws blank in front of the user with nothing anywhere
 * saying why. The candidates are the dictionary's own first few, in its own
 * order, which is what tells the model how this table names things.
 * @param meta - the table that was asked for.
 * @param attr - the attribute the call named.
 * @param attributes - the table's own attributes, in the backend's order.
 * @returns the sentence.
 */
export function dataSourceUnknownAttribute(
  meta: string,
  attr: string,
  attributes: readonly DataSourceAttribute[],
): string {
  const named = attributes.slice(0, MAX_CANDIDATE_ATTRIBUTES)
  const list = named.map(entry => `${entry.attributeEnName} (${entry.attributeCnName})`).join(', ')
  const rest = attributes.length > named.length ? `, and ${attributes.length - named.length} more` : ''
  return `${SHOW_COMPONENT_TOOL_NAME}: "${meta}" has no attribute named "${attr}". Its first ${named.length} of `
    + `${attributes.length} are: ${list}${rest}. Send the attributes this table actually has.`
}
