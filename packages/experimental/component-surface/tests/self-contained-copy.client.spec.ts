/**
 * The gate on the rule
 * [the self-contained-copy Agent Note](../../../../.agents/notes/implemented/feature/2026-09-04-self-contained-tool-copy.md)
 * records, held over this package: no sentence it writes names a tool other
 * than `show_component`. That covers what the model reads — the tool's
 * description, its parameter and output descriptions, every refusal and result
 * line, every notice an action becomes — and what a view's writer reads: the
 * catalog's labels, purposes and the reasons its declarations splice into a
 * refusal. `show_component` is this package's own tool, so its name in a
 * refusal's prefix or a result line is outside the rule.
 *
 * A sentence names another tool when it carries a name of one of the tool
 * families below, one of the named tools, an external MCP tool's
 * `mcp__<server>__<tool>` name, or one of the single-word tool names in quotes
 * or backticks. The single words are matched only quoted because they are
 * ordinary English — `read-only`, `written down` — and a bare match would
 * refuse sentences that name nothing.
 *
 * The spec walks five things, and each asserts that it walked more than a
 * floor before it reads for names, so a walk that came back empty fails
 * rather than passing. It
 * assembles the tool under every offer a composition makes and reads every
 * `description` the definition carries. It reads the catalog of every
 * component this package declares: each label and purpose, the catalog lines
 * the description splices in, and every sentence a property, an action
 * payload or an output declares for a refusal to quote. It builds every
 * catalog action's notice from a recorded context, and an action with no
 * context recorded here fails the walk, so an action added later is read the
 * day it is declared. It reads the whole export surface of `data-page.ts` and
 * `data-source.ts`: every string, and every function called with the
 * arguments recorded here, a function with none recorded failing the walk;
 * the exports that produce no sentence of their own are listed, and a listed
 * name the modules no longer export fails too. Last, it reads every string
 * literal, template piece and JSX text under `src/`, which is what covers a
 * sentence the other four never reach, such as a result line `tool.ts`
 * composes privately. That walk reads literals only: a name spliced into a
 * sentence through an expression is seen by the first four walks, and only in
 * the sentences they reach.
 *
 * Three controls then run the same readers over names planted on purpose: a
 * name of every family, every named tool and every quoted word, beside two
 * ordinary phrases that must not match; a name appended to one purpose, read
 * through the description and the catalog lines; and a name in each kind of
 * literal of two files written for the control. The first control's names are
 * written out apart from the lists the readers match, so a name dropped from a
 * list fails it. A reader that stopped matching fails there instead of letting
 * every walk pass.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  catalogEntry,
  COMPONENT_KIT_ENTRIES,
  CONFIRM_BAR_ID,
  DATA_PAGE_ID,
  describeCatalog,
  FILTER_BAR_ID,
  FORM_PAGE_ID,
  INFO_CARD_ID,
  placedOnlyByViews,
  readCatalog,
  TABLE_ID,
  type ComponentActionNotice,
  type ComponentCatalogEntry,
  type ComponentNode,
  type PropsFieldSchema,
  type PropsSchema,
} from '../src/component-call.ts'
import * as dataPageText from '../src/data-page.ts'
import type { DataPageLoadReport } from '../src/data-page.ts'
import * as dataSourceText from '../src/data-source.ts'
import type { DataSourceAttribute, DataSourceBlock, DataSourceTarget } from '../src/data-source.ts'
import { showComponentTool, type ShowComponentOptions } from '../src/tool.ts'
import { acceptsActionPayload, validateComponentSpec } from '../src/validate.ts'
import { KIT_CATALOG } from './kit-catalog.client.ts'

/**
 * The tool-name families other packages register, each as the pattern every
 * name of the family matches; the last is how an external MCP server's tools
 * are named.
 *
 * This list and the two below are the names the other packages' tool
 * definitions declare, written out because this package imports none of
 * those packages: a tool registered elsewhere under a name no list here
 * covers is added here by hand.
 */
const TOOL_FAMILIES: readonly RegExp[] = [
  /content_[a-z_]+/,
  /system_map_[a-z_]+/,
  /session_[a-z_]+/,
  /terminal_[a-z_]+/,
  /schedule_[a-z_]+/,
  /job_[a-z_]+/,
  /team_task_[a-z_]+/,
  /[a-z]+_mcp_[a-z_]+/,
  /stagehand_[a-z_]+/,
  /mcp__[\w-]+/,
]

/** Tools other packages register under a name of their own, each matched as a whole word. */
const NAMED_TOOLS: readonly string[] = [
  'show_chart', 'run_code', 'web_fetch', 'web_search', 'todo_write', 'ask_user_question', 'str_replace_editor',
  'spawn_teammate', 'send_message', 'list_agents', 'interrupt_agent', 'wait_agent', 'list_subagent_models',
  'create_goal', 'get_goal', 'update_goal', 'read_image', 'plugin_manager', 'cordis_inspect_list',
  'cordis_inspect_query', 'load_workspace_dependencies', 'exit_plan_mode', 'structured_output',
]

/** Tools named by one ordinary word, matched only between quotes or backticks. */
const WORD_TOOLS: readonly string[] = [
  'read', 'write', 'edit', 'bash', 'pwsh', 'skill', 'glob', 'grep', 'lsp', 'present', 'ralph', 'subagent', 'workflow',
]

/** Every pattern a sentence naming another tool matches; none carries `g`, so each test reads from the start. */
const ANOTHER_TOOL: readonly RegExp[] = [
  ...TOOL_FAMILIES,
  new RegExp(`\\b(?:${NAMED_TOOLS.join('|')})\\b`),
  new RegExp(`[\`"'](?:${WORD_TOOLS.join('|')})[\`"']`),
]

/**
 * The tool name one sentence carries, if it carries one.
 * @param sentence - the sentence.
 * @returns the first match, or `undefined` for a sentence naming no other tool.
 */
function toolNameIn(sentence: string): string | undefined {
  for (const pattern of ANOTHER_TOOL) {
    const match = pattern.exec(sentence)
    if (match !== null) return match[0]
  }
  return undefined
}

/**
 * The sentences that name another tool, each with the name it carries.
 * @param sentences - the sentences one walk reached.
 * @returns the offending sentences, empty when the walk is clean.
 */
function namingAnotherTool(sentences: readonly string[]): { sentence: string; name: string }[] {
  return sentences.flatMap((sentence) => {
    const name = toolNameIn(sentence)
    return name === undefined ? [] : [{ sentence, name }]
  })
}

/** This package's source, the tree the literal walk reads. */
const SOURCE_ROOT = resolve(import.meta.dirname, '../src')

/** Every offer a composition can make: with and without a data backend, with and without the data page. */
const OFFERS: readonly ShowComponentOptions[] = [false, true].flatMap(dataSource => [false, true].map(dataPage => ({
  dataSource, defaultPageSize: 200, dataPage, dataPageLoadTimeoutMs: 1000,
})))

/**
 * Every `description` a JSON Schema node carries, at any depth.
 * @param node - a schema node, or any value nested inside one.
 * @returns the descriptions found under it, outermost first.
 */
function descriptionsIn(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(descriptionsIn)
  if (typeof node !== 'object' || node === null) return []
  return Object.entries(node).flatMap(([key, value]) => (
    key === 'description' && typeof value === 'string' ? [value] : descriptionsIn(value)
  ))
}

/**
 * Every sentence one declared value carries for a refusal to quote, at any depth.
 * @param schema - the declared value.
 * @returns the alphabet and value-set hints under it, outermost first.
 */
function schemaSentences(schema: PropsFieldSchema): string[] {
  switch (schema.kind) {
    case 'string': return schema.charset === undefined ? [] : [schema.charset.hint]
    case 'enum': return schema.hint === undefined ? [] : [schema.hint]
    case 'object': return propsSentences(schema.fields)
    case 'record': return schemaSentences(schema.key)
    case 'array': return schemaSentences(schema.item)
    case 'number':
    case 'boolean':
    case 'scalar': return []
    default: {
      const unhandled: never = schema
      throw new Error(`no walk for ${JSON.stringify(unhandled)}`)
    }
  }
}

/**
 * Every sentence a set of declared properties carries for a refusal to quote.
 * @param props - the declared properties.
 * @returns each property's own reasons and its value's hints, in declaration order.
 */
function propsSentences(props: PropsSchema): string[] {
  return Object.values(props).flatMap(field => [
    ...field.unbindable === undefined ? [] : [field.unbindable],
    ...field.viewOnly === undefined ? [] : [field.viewOnly],
    ...field.bindsFrom === undefined ? [] : [field.bindsFrom.reason],
    ...schemaSentences(field.schema),
  ])
}

/** One block an action is reported from, and one payload it reports. */
interface ActionCase {
  /** The block's properties, as a call or a view writes them. */
  readonly props: Readonly<Record<string, unknown>>
  /** The payload, one the action's own declaration accepts. */
  readonly payload: Readonly<Record<string, unknown>>
}

/** The data page a form page or an info card reads, placed beside it in every case that needs one. */
const PAGE_NODE = { id: 'page', component: DATA_PAGE_ID, props: { relatedMeta: 'SpaceLayer', metaLabel: '空间图层' } }

/** One confirmation bar with one button. */
const BAR = { title: '本月预算', buttons: [{ id: 'ok', label: '确认' }] }

/** One table: a named column, an unnamed one, two rows of which the second shows nothing in the first column. */
const TABLE = {
  tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label', alias: '名称' }, { relatedMetaAttr: 'state' }] },
  displayValueList: [{ zh_label: 'A-1', state: '在用' }, { state: '停用' }],
  customOperations: [{ key: 'export', label: '导出' }],
}

/** One filter bar over one attribute, offering the choice between AND and OR. */
const FILTER = {
  relatedMeta: 'device',
  metaConfig: { attributes: [{ attributeEnName: 'zh_label', alias: '名称' }] },
  confStyle: { showMatchMode: true },
}

/** One data page on `SpaceLayer`, with one row operation. */
const PAGE = { ...PAGE_NODE.props, customOperations: [{ name: 'locate', label: '定位' }] }

/** One form page reading what {@link PAGE_NODE} is editing. */
const FORM = { relatedMeta: 'SpaceLayer', request: { $from: 'node:page.editing' } }

/** One info card reading what {@link PAGE_NODE} opened. */
const CARD = { record: { $from: 'node:page.opened' } }

/** A record with two drawn cells, as a save reports it. */
const SAVED = { zh_label: '测试-1', status: '启用' }

/**
 * The cases every catalog action's notice is built from, keyed
 * `<component>.<action>`. Every action of every component this package
 * declares has an entry, and several carry one case per wording the notice
 * has.
 */
const ACTION_CASES: Readonly<Record<string, readonly ActionCase[]>> = {
  [`${CONFIRM_BAR_ID}.press`]: [{ props: BAR, payload: { buttonId: 'ok' } }],
  [`${TABLE_ID}.select`]: [{ props: TABLE, payload: { rowIndexes: [0, 1] } }, { props: TABLE, payload: { rowIndexes: [] } }],
  [`${TABLE_ID}.row-click`]: [{ props: TABLE, payload: { rowIndex: 0 } }, { props: TABLE, payload: { rowIndex: 1 } }],
  [`${TABLE_ID}.sort`]: [{ props: TABLE, payload: { prop: 'zh_label', order: 'asc' } }, { props: TABLE, payload: { prop: 'state', order: 'none' } }],
  [`${TABLE_ID}.operation`]: [{ props: TABLE, payload: { opId: 'export', rowIndex: 0 } }],
  [`${FILTER_BAR_ID}.submit`]: [
    { props: FILTER, payload: { conditions: [{ key: 'zh_label', op: 'EQ', value: 'A-1' }] } },
    { props: FILTER, payload: { conditions: [{ key: 'zh_label', op: 'LIKE', value: 'A' }], matchMode: 'OR' } },
  ],
  [`${FILTER_BAR_ID}.change`]: [{ props: FILTER, payload: { count: 2 } }],
  [`${DATA_PAGE_ID}.load`]: [
    { props: PAGE, payload: { meta: 'SpaceLayer', columns: [{ attr: 'zh_label', alias: '名称' }, { attr: 'status' }], total: 5, rights: ['query'] } },
    { props: PAGE, payload: { meta: 'SpaceLayer', columns: [], total: 0, rights: [] } },
  ],
  [`${DATA_PAGE_ID}.denied`]: [
    { props: PAGE, payload: { reason: 'no-row' } },
    { props: PAGE, payload: { reason: 'no-rights-table' } },
    { props: PAGE, payload: {} },
  ],
  [`${DATA_PAGE_ID}.auth-failed`]: [{ props: PAGE, payload: { status: 401, code: 'E401' } }, { props: PAGE, payload: { status: 0 } }],
  [`${DATA_PAGE_ID}.query`]: [{ props: PAGE, payload: { total: 89, rows: 20, page: 2 } }],
  [`${DATA_PAGE_ID}.cell-click`]: [{ props: PAGE, payload: { attr: 'zh_label', label: '名称', row: SAVED } }],
  [`${DATA_PAGE_ID}.select`]: [
    { props: PAGE, payload: { count: 7, names: ['测试-1', '测试-2', '测试-3', '测试-4', '测试-5'] } },
    { props: PAGE, payload: { count: 0, names: [] } },
  ],
  [`${DATA_PAGE_ID}.card-open`]: [{ props: PAGE, payload: { name: '测试-1', type: 'SpaceLayer' } }],
  [`${DATA_PAGE_ID}.card-close`]: [{ props: PAGE, payload: {} }],
  [`${DATA_PAGE_ID}.added`]: [{ props: PAGE, payload: { record: SAVED } }, { props: PAGE, payload: { record: {} } }],
  [`${DATA_PAGE_ID}.modified`]: [{ props: PAGE, payload: { record: SAVED } }, { props: PAGE, payload: { record: {} } }],
  [`${DATA_PAGE_ID}.operation`]: [{ props: PAGE, payload: { opId: 'locate', row: SAVED } }],
  [`${DATA_PAGE_ID}.exported`]: [{ props: PAGE, payload: { mode: 'excel', fileType: 'xlsx' } }, { props: PAGE, payload: { mode: 'grid_csv' } }],
  [`${DATA_PAGE_ID}.deleted`]: [
    { props: PAGE, payload: { succeeded: 2, failed: 1, names: ['测试-1', '测试-2'] } },
    { props: PAGE, payload: { succeeded: 0, failed: 2, names: [] } },
  ],
  [`${DATA_PAGE_ID}.batch-modified`]: [
    { props: PAGE, payload: { succeeded: 2, failed: 0, names: ['测试-1', '测试-2'], fields: ['status'] } },
    { props: PAGE, payload: { succeeded: 2, failed: 1, names: ['测试-1', '测试-2'], fields: [] } },
    { props: PAGE, payload: { succeeded: 0, failed: 2, names: [], fields: [] } },
  ],
  [`${FORM_PAGE_ID}.added`]: [{ props: FORM, payload: { record: SAVED } }, { props: FORM, payload: { record: {} } }],
  [`${FORM_PAGE_ID}.modified`]: [{ props: FORM, payload: { record: SAVED } }, { props: FORM, payload: { record: {} } }],
  [`${INFO_CARD_ID}.card-open`]: [{ props: CARD, payload: { name: '测试-1', type: 'SpaceLayer' } }],
  [`${INFO_CARD_ID}.card-close`]: [{ props: CARD, payload: {} }],
}

/**
 * Build one action's two accounts over a block this catalog accepts.
 * @param componentId - the catalog id of the block.
 * @param actionId - the action the block reports.
 * @param one - the block's properties and the payload.
 * @returns the accounts, or `undefined` where the payload names nothing the block draws.
 */
function noticeOf(componentId: string, actionId: string, one: ActionCase): ComponentActionNotice | undefined {
  const component = catalogEntry(KIT_CATALOG, componentId)
  const action = component?.actions.find(declared => declared.id === actionId)
  if (component === undefined || action === undefined) throw new Error(`${componentId} declares no ${actionId}`)
  // A form page or an info card is placed only beside the page it reads.
  const beside = placedOnlyByViews(component) ? [PAGE_NODE] : []
  const result = validateComponentSpec(KIT_CATALOG, {
    nodes: [...beside, { id: 'block', component: componentId, props: one.props }],
  })
  if (!result.ok) throw new Error(result.failure.text)
  const node = result.spec.nodes.find(placed => placed.id === 'block') as ComponentNode
  expect(`${componentId}.${actionId}: ${acceptsActionPayload(one.payload, action.payloadSchema)}`)
    .toBe(`${componentId}.${actionId}: accepted`)
  return action.describe({ entryId: 'layers', entryTitle: '图层管理', node, component, payload: one.payload })
}

/**
 * One data page block, as validation accepted it.
 * @param props - the block's properties.
 * @returns the node.
 */
function pageNode(props: Readonly<Record<string, unknown>>): ComponentNode {
  const result = validateComponentSpec(KIT_CATALOG, { nodes: [{ id: 'rows', component: DATA_PAGE_ID, props }] })
  if (!result.ok) throw new Error(result.failure.text)
  return result.spec.nodes[0] as ComponentNode
}

/** A page with one hidden condition, so the card's sentence counts it. */
const CONDITIONED = pageNode({ ...PAGE_NODE.props, conditions: [{ key: 'status', op: 'EQ', value: '1' }] })

/** What a page with more columns than a report names loaded. */
const REPORT: DataPageLoadReport = { meta: 'SpaceLayer', columns: [{ attr: 'zh_label', alias: '名称' }, { attr: 'status' }], total: 3, rights: [] }

/** One read of `SpaceLayer` with one condition. */
const BLOCK: DataSourceBlock = {
  nodeId: 'rows', meta: 'SpaceLayer', metaLabel: '空间图层', matchMode: 'AND', pageSize: 200, currentPage: 1,
  conditions: [{ key: 'status', op: 'EQ', label: '等于', value: '启用' }],
}

/** That read with the columns the call declared. */
const DECLARED: DataSourceTarget = {
  block: BLOCK, nodeIndex: 0, node: {}, props: {}, tableConfig: {}, columns: [{ attr: 'zh_label', alias: '名称' }],
}

/** That read leaving its columns to the table's own default ones. */
const DEFAULTED: DataSourceTarget = { block: BLOCK, nodeIndex: 0, node: {}, props: {}, tableConfig: {} }

/** A dictionary longer than a refusal lists. */
const ATTRIBUTES: readonly DataSourceAttribute[] = Array.from({ length: 12 }, (_unused, index) => ({
  attributeEnName: `attr_${index}`, attributeCnName: `属性${index}`,
}))

/**
 * The exports of the two text modules that produce no sentence of their own:
 * the table of waiting calls, the judgements, and the readings and fills.
 * Their refusals are sentences the literal walk reads.
 */
const NOT_TEXT: readonly string[] = [
  'PendingLoads', 'judgeDataPageNodes', 'judgeDataPageParts', 'readDataSourceBlocks', 'settleDefaultColumns',
  'resolveDataSourceTargets', 'normalizeRow', 'applyDataSourceRows', 'probeDataSourceSpec',
]

/**
 * The arguments each exported text function is read with. Every function of
 * the two modules outside {@link NOT_TEXT} has an entry; one it does not have
 * fails the walk.
 */
const ARGUMENTS: Readonly<Record<string, readonly (readonly unknown[])[]>> = {
  dataPageApprovalReason: [[pageNode(PAGE_NODE.props)], [CONDITIONED]],
  componentNotOffered: [[KIT_CATALOG, { nodes: [CONDITIONED] }, CONDITIONED]],
  dataPageBesideDataSource: [[{ nodes: [CONDITIONED] }]],
  dataPageLoadedText: [[CONDITIONED, REPORT], [CONDITIONED, { ...REPORT, columns: [], total: 0 }]],
  dataPageUnreportedText: [[CONDITIONED, 10000]],
  dataSourceApprovalReason: [[[DECLARED]], [[DECLARED, DEFAULTED]]],
  dataSourceNotReadable: [['SpaceLayer']],
  dataSourceRightsUnread: [['HTTP 500']],
  dataSourceRejected: [['SpaceLayer', 500], ['SpaceLayer', 200, 40001, 'token expired']],
  dataSourceUnreachable: [['SpaceLayer', 'connect ECONNREFUSED']],
  dataSourceEmpty: [['SpaceLayer']],
  dataSourceOversize: [['SpaceLayer', 500, 70000]],
  dataSourceUndrawable: [['SpaceLayer', 'spec.nodes[0].props.displayValueList — has 600 items; at most 500 are accepted.']],
  dataSourceUnknownAttribute: [['SpaceLayer', 'nmae', ATTRIBUTES]],
  dataSourceNoDefaultColumns: [['SpaceLayer', 'the table has no default query scheme']],
  dataSourceSchemeAttribute: [['SpaceLayer', 'layer_x', ATTRIBUTES]],
}

/**
 * Read one value a text function answered with as the sentence it carries.
 * @param value - what the function returned.
 * @param label - the call, for the failure an unreadable answer earns.
 * @returns the sentence: the string itself, or a refusal's text.
 */
function sentenceIn(value: unknown, label: string): string {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null && 'text' in value && typeof value.text === 'string') return value.text
  throw new Error(`${label} answered neither a sentence nor a refusal`)
}

/**
 * Every sentence one module can put in front of the model: its string exports,
 * and what its function exports answer with.
 * @param module - the module's whole export surface.
 * @param name - the module's own name, for the failure a missing entry earns.
 * @returns every string the module produces, in export order.
 */
function sentencesOf(module: Record<string, unknown>, name: string): string[] {
  return Object.entries(module).flatMap(([key, value]) => {
    if (typeof value === 'string') return [value]
    if (NOT_TEXT.includes(key)) return []
    if (typeof value !== 'function') throw new Error(`${name}.${key} is neither a sentence nor a way to compose one`)
    const args = ARGUMENTS[key]
    if (args === undefined) throw new Error(`${name}.${key} has no arguments recorded in this gate`)
    return args.map(one => sentenceIn((value as (...rest: readonly unknown[]) => unknown)(...one), `${name}.${key}`))
  })
}

describe('every sentence this package writes', () => {
  it('names no other tool in any description the tool carries, under every offer', () => {
    const tools = OFFERS.map(options => showComponentTool(new Context(), KIT_CATALOG, options, new dataPageText.PendingLoads()))
    const descriptions = tools.flatMap(tool => [
      tool.description,
      ...descriptionsIn(tool.parameters),
      ...descriptionsIn(tool.output.schema),
    ])
    // The walk is worthless if a schema read as empty.
    expect(descriptions.length).toBeGreaterThan(30)
    expect(namingAnotherTool(descriptions)).toEqual([])
  })

  it('names no other tool in the catalog: its labels, purposes, lines and declared reasons', () => {
    const entries = KIT_CATALOG.entries
    // The two components only a view places are in the walk although no
    // description lists them: their purposes and reasons are what a view's
    // writer reads.
    expect(entries.map(entry => entry.id)).toEqual(COMPONENT_KIT_ENTRIES.map(entry => entry.id))
    expect(entries.filter(placedOnlyByViews).map(entry => entry.id)).toEqual([FORM_PAGE_ID, INFO_CARD_ID])
    const sentences = [
      describeCatalog(entries),
      ...entries.flatMap(entry => [
        entry.label,
        entry.purpose,
        ...propsSentences(entry.propsSchema),
        ...entry.actions.flatMap(action => propsSentences(action.payloadSchema)),
        ...entry.outputs.flatMap(output => schemaSentences(output.shape)),
      ]),
    ]
    expect(sentences.length).toBeGreaterThan(60)
    expect(namingAnotherTool(sentences)).toEqual([])
  })

  it('names no other tool in any notice an action becomes, for the agent or for the user', () => {
    const declared = KIT_CATALOG.entries.flatMap(entry => entry.actions.map(action => `${entry.id}.${action.id}`))
    // An action with no case recorded here would be a notice nothing reads.
    expect(Object.keys(ACTION_CASES).sort()).toEqual([...declared].sort())
    const sentences = Object.entries(ACTION_CASES).flatMap(([key, cases]) => cases.flatMap((one) => {
      // A catalog id carries a dot of its own, and an action id carries none.
      const at = key.lastIndexOf('.')
      const notice = noticeOf(key.slice(0, at), key.slice(at + 1), one)
      // A payload naming nothing the block draws builds no notice and reads nothing.
      expect(`${key}: ${notice === undefined ? 'nothing' : 'a notice'}`).toBe(`${key}: a notice`)
      return notice === undefined ? [] : [notice.text, notice.summary]
    }))
    expect(sentences.length).toBeGreaterThan(60)
    expect(namingAnotherTool(sentences)).toEqual([])
  })

  it('names no other tool in either text module, string or composed', () => {
    const modules = { 'data-page.ts': dataPageText, 'data-source.ts': dataSourceText }
    const exported = Object.values(modules).flatMap(module => Object.keys(module))
    // A listed name the modules no longer export, or a recorded function they
    // no longer have, is a list nobody would notice going stale.
    expect(NOT_TEXT.filter(name => !exported.includes(name))).toEqual([])
    expect(Object.keys(ARGUMENTS).filter(name => !exported.includes(name))).toEqual([])
    const sentences = Object.entries(modules).flatMap(([name, module]) => sentencesOf(module, name))
    expect(sentences.length).toBeGreaterThan(20)
    expect(namingAnotherTool(sentences)).toEqual([])
  })

  it('names no other tool in any literal its source writes, wherever it is written', () => {
    const literals = sourceFiles(SOURCE_ROOT).flatMap(file => literalsIn(file).map(text => ({
      file: relative(SOURCE_ROOT, file).split(sep).join('/'),
      text,
    })))
    expect(new Set(literals.map(literal => literal.file)).size).toBeGreaterThan(25)
    expect(literals.length).toBeGreaterThan(2000)
    expect(literals.flatMap(({ file, text }) => {
      const name = toolNameIn(text)
      return name === undefined ? [] : [{ file, text, name }]
    })).toEqual([])
  })
})

/** One name of every family in {@link TOOL_FAMILIES}, each a tool another package registers. */
const FAMILY_SAMPLES: readonly string[] = [
  'content_read', 'system_map_model', 'session_search', 'terminal_open', 'schedule_create', 'job_list',
  'team_task_create', 'list_mcp_resources', 'mcp__github__create_issue', 'stagehand_act',
]

/**
 * Every tool {@link NAMED_TOOLS} lists, written out again so that a name dropped
 * from that list is still planted, and the control reading it fails.
 */
const NAMED_SAMPLES: readonly string[] = [
  'ask_user_question', 'cordis_inspect_list', 'cordis_inspect_query', 'create_goal', 'exit_plan_mode', 'get_goal',
  'interrupt_agent', 'list_agents', 'list_subagent_models', 'load_workspace_dependencies', 'plugin_manager',
  'read_image', 'run_code', 'send_message', 'show_chart', 'spawn_teammate', 'str_replace_editor',
  'structured_output', 'todo_write', 'update_goal', 'wait_agent', 'web_fetch', 'web_search',
]

/**
 * Every word {@link WORD_TOOLS} lists, written out again for the same reason as
 * {@link NAMED_SAMPLES}.
 */
const WORD_SAMPLES: readonly string[] = [
  'bash', 'edit', 'glob', 'grep', 'lsp', 'present', 'pwsh', 'ralph', 'read', 'skill', 'subagent', 'workflow', 'write',
]

describe('the gate itself', () => {
  it('reads a name of every family, every named tool and every quoted word, and not the words in ordinary prose', () => {
    // A list entry no sample stands for is an entry this control does not check.
    expect(TOOL_FAMILIES.filter(family => !FAMILY_SAMPLES.some(name => family.test(name))).map(String)).toEqual([])
    expect(NAMED_TOOLS.filter(name => !NAMED_SAMPLES.includes(name))).toEqual([])
    expect(WORD_TOOLS.filter(word => !WORD_SAMPLES.includes(word))).toEqual([])
    const quoted = WORD_SAMPLES.flatMap(word => [`\`${word}\``, `"${word}"`, `'${word}'`])
    const names = [...FAMILY_SAMPLES, ...NAMED_SAMPLES, ...quoted]
    expect(names.filter(name => toolNameIn(`Then call ${name} on the same rows.`) !== name)).toEqual([])
    const prose = ['read-only', '\'read-only\'', 'written down', '\'written down\'', 'a view written down for this deployment']
    expect(prose.filter(sentence => toolNameIn(sentence) !== undefined)).toEqual([])
  })

  it('reports a name appended to one purpose, through the description and through the catalog lines', () => {
    const entries = COMPONENT_KIT_ENTRIES.map((entry): ComponentCatalogEntry => (
      entry.id === TABLE_ID ? { ...entry, purpose: `${entry.purpose} Then call content_read.` } : entry
    ))
    const catalog = readCatalog(entries)
    const described = OFFERS.map(options => showComponentTool(new Context(), catalog, options, new dataPageText.PendingLoads()).description)
    expect(described.map(description => namingAnotherTool([description]).map(found => found.name)))
      .toEqual(OFFERS.map(() => ['content_read']))
    expect(namingAnotherTool([describeCatalog(catalog.entries)]).map(found => found.name)).toEqual(['content_read'])
  })

  it('reports a name in a string literal, in a template piece and in JSX text of a file it walks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'self-contained-copy-'))
    try {
      writeFileSync(
        join(dir, 'line.ts'),
        'export const line = (count: number): string => `Ask todo_write for ${count} rows.`\n'
        + 'export const word = \'Run `bash` first.\'\n',
      )
      writeFileSync(join(dir, 'view.tsx'), 'export const View = () => <p>Fetch it with web_fetch.</p>\n')
      const files = sourceFiles(dir)
      expect(files.map(file => relative(dir, file)).sort()).toEqual(['line.ts', 'view.tsx'])
      const names = files.flatMap(file => literalsIn(file)).flatMap(text => toolNameIn(text) ?? [])
      expect(names.sort()).toEqual(['`bash`', 'todo_write', 'web_fetch'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * Every TypeScript source file under a directory, declaration files excluded.
 * @param dir - the directory to walk.
 * @returns the files' paths, in directory order.
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : []
  })
}

/**
 * Every string literal, template piece and JSX text one file writes.
 * @param file - the source file to parse.
 * @returns the literals' text, in source order.
 */
function literalsIn(file: string): string[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind)
  const literals: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      literals.push(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return literals
}
