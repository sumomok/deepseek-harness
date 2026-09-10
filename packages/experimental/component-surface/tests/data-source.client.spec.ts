/**
 * `show_component` reading its own rows: what the parameter accepts, what the
 * user is asked verbatim, what each way of failing says, and what the log ends
 * up holding.
 *
 * The backend is a stub rather than an HTTP fixture, because `ctx.bizBackend`
 * is a typed same-process seam and the package that owns it tests the wire.
 * What this suite owns is everything on this side of that seam: the request it
 * builds, the question it asks first, the sentence it refuses with, and the one
 * event it appends.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {
  BizBackendFailure,
  BizMetaResult,
  BizSchemeResult,
  BizSearchRequest,
  BizSearchResult,
} from '@deepseek-ai/dsh-experimental-biz-backend'
import { MAX_SPEC_BYTES, SHOW_COMPONENT_TOOL_NAME } from '../src/component-call.ts'
import {
  APPROVAL_PROMISE,
  readDataSourceBlocks,
  resolveDataSourceTargets,
  type DataSourceBlock,
} from '../src/data-source.ts'
import { PendingLoads } from '../src/crud.ts'
import { readComponentEvent } from '../src/projection.ts'
import { componentExtractor } from '../src/surface.ts'
import { describeShowComponent, showComponentTool, type ShowComponentOptions } from '../src/tool.ts'

/** The offer of a deployment that composed a data backend. */
const READING: ShowComponentOptions = { dataSource: true, defaultPageSize: 200, crud: false, crudLoadTimeoutMs: 1000 }

/** The offer of a deployment that composed none. */
const PLAIN: ShowComponentOptions = { dataSource: false, defaultPageSize: 200, crud: false, crudLoadTimeoutMs: 1000 }

/** The table this deployment's own dictionary declares, in the order it lists them. */
const ATTRIBUTES = [
  { attributeEnName: 'int_id', attributeCnName: '唯一标识' },
  { attributeEnName: 'zh_label', attributeCnName: '名称' },
  { attributeEnName: 'layer_id', attributeCnName: '图层id' },
  { attributeEnName: 'belong_map_topic', attributeCnName: '所属地图主题' },
  { attributeEnName: 'belong_scene', attributeCnName: '所属场景' },
]

/** One table block whose rows a data source fills, with one hidden column. */
const TABLE_NODE = {
  id: 'rows',
  component: 'toy.table',
  props: {
    tableConfig: {
      gridItems: [
        { relatedMetaAttr: 'zh_label', alias: '名称' },
        { relatedMetaAttr: 'layer_id', alias: '图层id' },
        { relatedMetaAttr: 'belong_map_topic', alias: '所属地图主题', isShow: false },
      ],
    },
  },
}

/** The spec every read in this suite fills. */
const SPEC = { nodes: [TABLE_NODE] }

/** The same block with no column list of its own, which asks for the table's default columns. */
const DEFAULT_COLUMN_NODE = { id: 'rows', component: 'toy.table', props: {} }

/** The spec of a call that left its columns to the table. */
const DEFAULT_COLUMN_SPEC = { nodes: [DEFAULT_COLUMN_NODE] }

/**
 * The table's default query scheme, as the schema service stores one: two drawn
 * columns and one the deployment hides.
 */
const SCHEME = [
  { relatedMetaAttr: 'zh_label', alias: '名称', isSortable: true },
  { relatedMetaAttr: 'layer_id', alias: '图层id' },
  { relatedMetaAttr: 'belong_scene', alias: '所属场景', isShow: false },
]

/** The `dataSource` every read in this suite sends. */
const SOURCE = [{ nodeId: 'rows', meta: 'SpaceLayer', metaLabel: '图层配置' }]

/** Two rows as the backend displays them. */
const DISPLAY = [
  { zh_label: '配送车-离线', layer_id: 'element:gas', belong_map_topic: '公用专题' },
  { zh_label: '东风站', layer_id: 'element:site', belong_map_topic: '公用专题' },
]

/** The same two rows as the backend stores them. */
const RAW = [
  { int_id: '1134933624650219530', zh_label: '配送车-离线', layer_id: 'element:gas', belong_map_topic: '947543009150173184' },
  { int_id: '1134933624650219531', zh_label: '东风站', layer_id: 'element:site', belong_map_topic: '947543009150173184' },
]

/** A token-shaped string nothing this row writes may ever repeat. */
const FAKE_TOKEN = 'not-a-real-token.PAYLOAD-eyJzdWIiOiJ0ZXN0In0.SIGNATURE'

/** How the stub backend answers one call. */
interface BackendScript {
  /** What `describe` answers; the whole dictionary above when unstated. */
  describe?: (meta: string) => BizMetaResult | BizBackendFailure
  /** What `describeScheme` answers; the default scheme above when unstated. */
  describeScheme?: (meta: string) => BizSchemeResult | BizBackendFailure
  /** What `search` answers; the two rows above when unstated. */
  search?: (request: BizSearchRequest) => BizSearchResult | BizBackendFailure
  /** Whether a visitor's token is held at all; held when unstated. */
  credential?: boolean
}

/** One booted deployment: the tool over a real registry, and what the stubs saw. */
interface Bench {
  /** The registered definition, for the offer's own assertions. */
  definition: ReturnType<typeof showComponentTool>
  /** The session every append lands in. */
  session: Session
  /** Run one call through the real tool registry. */
  run: (args: Record<string, unknown>) => Promise<ToolExecutionResult>
  /** Every question the user was asked, in order. */
  asked: ApprovalRequest[]
  /** Every table whose dictionary was read, in order. */
  described: string[]
  /** Every table whose default query scheme was read, in order. */
  schemed: string[]
  /** Every read that went out, in order. */
  searched: BizSearchRequest[]
  /** The question and every request, in the order they happened. */
  steps: ('ask' | 'describe' | 'scheme' | 'search')[]
}

let calls = 0

/**
 * Boot the tool over a real tool registry and a real session, with the two
 * services it injects stubbed.
 * @param outcome - what the user answers; a grant when unstated.
 * @param script - how the backend answers.
 * @param options - what this composition offers; a reading one when unstated.
 * @returns the bench.
 */
async function bench(
  outcome: ApprovalOutcome = 'allowed-once',
  script: BackendScript = {},
  options: ShowComponentOptions = READING,
): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  const session = (ctx.get('sessions') as unknown as SessionStore).create()
  const agent = { id: session.id, session } as unknown as Agent
  const asked: ApprovalRequest[] = []
  const described: string[] = []
  const schemed: string[] = []
  const searched: BizSearchRequest[] = []
  const steps: Bench['steps'] = []
  ctx.provide('approval', {
    request: (request: ApprovalRequest): Promise<ApprovalOutcome> => {
      asked.push(request)
      steps.push('ask')
      return Promise.resolve(outcome)
    },
  } as never)
  ctx.provide('bizBackend', {
    holdsCredential: (): boolean => script.credential ?? true,
    describe: (meta: string): Promise<BizMetaResult | BizBackendFailure> => {
      described.push(meta)
      steps.push('describe')
      return Promise.resolve(script.describe?.(meta) ?? { attributes: ATTRIBUTES })
    },
    describeScheme: (meta: string): Promise<BizSchemeResult | BizBackendFailure> => {
      schemed.push(meta)
      steps.push('scheme')
      return Promise.resolve(script.describeScheme?.(meta) ?? { columns: SCHEME })
    },
    search: (request: BizSearchRequest): Promise<BizSearchResult | BizBackendFailure> => {
      searched.push(request)
      steps.push('search')
      return Promise.resolve(script.search?.(request) ?? { rawValue: RAW, displayValue: DISPLAY, total: 89 })
    },
  } as never)
  const definition = showComponentTool(ctx, options, new PendingLoads())
  ctx.tools.register(definition)
  return {
    definition,
    session,
    asked,
    described,
    schemed,
    searched,
    steps,
    run: args => ctx.tools.execute({
      callId: ToolCallId(`call-${++calls}`),
      name: SHOW_COMPONENT_TOOL_NAME,
      arguments: args,
      agent,
      signal: new AbortController().signal,
    }),
  }
}

/** The model-facing text of one settled execution. */
function text(result: ToolExecutionResult): string {
  return result.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

/** Every `content-component/resolved` one session's log holds. */
function resolvedEvents(session: Session): SessionEvent<'content-component/resolved'>[] {
  return session.snapshotEvents().filter(
    (event): event is SessionEvent<'content-component/resolved'> => event.type === 'content-component/resolved')
}

/**
 * Run one call and take the one refusal sentence back.
 * @param result - the settled execution.
 * @returns the sentence, without the runtime's own `Error: ` prefix.
 */
function refusal(result: ToolExecutionResult): string {
  expect(result.isError).toBe(true)
  return text(result).replace(/^Error: /, '')
}

describe('the dataSource offer', () => {
  it('names the parameter in the schema and the description where a backend is composed', async () => {
    const { definition } = await bench()
    expect(Object.keys((definition.parameters as { properties: object }).properties)).toEqual(['id', 'title', 'spec', 'dataSource'])
    expect(definition.description).toContain('A toy.table block can be filled from this deployment\'s own data')
    expect(definition.description).toContain('"page"?: {"pageSize": 1–500, "currentPage": 1 or more}')
    expect(definition.description).toContain('A read asks for 200 rows of the first page where it names neither.')
    // The model is told the column list is optional, because a model that does
    // not know a table's attribute names has no other way to draw it.
    expect(definition.description).toContain('leave `gridItems` out (or leave `tableConfig` out entirely) and the table '
      + 'is read and drawn with the columns this deployment shows for it by default')
  })

  it('names it nowhere at all where none is', async () => {
    const { definition } = await bench('allowed-once', {}, PLAIN)
    expect(Object.keys((definition.parameters as { properties: object }).properties)).toEqual(['id', 'title', 'spec'])
    expect(definition.description).not.toContain('dataSource')
    expect(definition.description).toBe(describeShowComponent(PLAIN))
  })
})

describe('a call that writes its own rows', () => {
  it('asks nobody, reads nothing and appends nothing, in a composition that could do all three', async () => {
    const written = { nodes: [{ ...TABLE_NODE, props: { ...TABLE_NODE.props, displayValueList: DISPLAY } }] }
    const { run, session, asked, described, searched } = await bench()
    const result = await run({ id: 'layers', title: '图层', spec: written })
    expect(result.isError).toBeFalsy()
    expect(text(result)).toBe(
      'Now showing "图层" in the content panel: 数据表. '
      + 'Call show_component with id "layers" again to replace it; a different id adds a second entry beside it.',
    )
    expect([asked, described, searched, resolvedEvents(session)]).toEqual([[], [], [], []])
  })
})

describe('what the dataSource parameter accepts', () => {
  /**
   * Send one malformed data source over the standard spec.
   * @param source - the `dataSource` argument.
   * @param spec - the `spec` argument; the standard one when unstated.
   * @returns the refusal sentence.
   */
  async function refuse(source: unknown, spec: unknown = SPEC): Promise<string> {
    const { run, asked, searched } = await bench()
    const answer = refusal(await run({ id: 'layers', title: '图层', spec, dataSource: source }))
    // Every rule below is judged before the user is asked and before the
    // credential is spent, which is the whole point of judging them here.
    expect([asked, searched]).toEqual([[], []])
    return answer
  }

  it('refuses an empty list of sources', async () => {
    expect(await refuse([])).toBe('show_component: dataSource — must be a list of between 1 and 12 data sources, one per block to fill.')
  })

  it('refuses an entry carrying anything the parameter does not declare', async () => {
    expect(await refuse([{ ...SOURCE[0], source: ['zh_label'] }]))
      .toBe('show_component: dataSource[0].source — is not part of a data source. A data source carries nodeId, meta, metaLabel, conditions, matchMode, page, asc, desc.')
    expect(await refuse(['SpaceLayer'])).toContain('dataSource[0] — must be an object carrying nodeId')
  })

  it('refuses a table name that would not stand as one path segment', async () => {
    expect(await refuse([{ ...SOURCE[0], meta: '../nrms-auth/api' }]))
      .toBe('show_component: dataSource[0].meta — must be a letter or an underscore, then letters, digits, underscores and hyphens.')
  })

  it('refuses a table name in the user\'s language that is longer than a card line', async () => {
    expect(await refuse([{ ...SOURCE[0], metaLabel: '图'.repeat(21) }]))
      .toBe('show_component: dataSource[0].metaLabel — is 21 characters; at most 20 are accepted.')
    expect(await refuse([{ ...SOURCE[0], metaLabel: '' }]))
      .toBe('show_component: dataSource[0].metaLabel — must be a non-empty string.')
  })

  it('refuses a table name that could draw a line of the card by itself', async () => {
    // The card's own identifier line is what a person checks this name
    // against, so a name able to write one is refused before anybody is asked.
    const forged = 'show_component: dataSource[0].metaLabel — must be one line of plain text, carrying no line break, '
      + 'no other control character, and no 「」 bracket.'
    expect(await refuse([{ ...SOURCE[0], metaLabel: '公开表」\n数据表：Public' }])).toBe(forged)
    expect(await refuse([{ ...SOURCE[0], metaLabel: '公开表\u202e' }])).toBe(forged)
    // U+2028 separates lines without being a control character, so a
    // renderer that honours it draws the very line this rule refuses.
    const separated = `公开表${String.fromCodePoint(0x2028)}数据表：Public`
    expect(await refuse([{ ...SOURCE[0], metaLabel: separated }])).toBe(forged)
  })

  it('refuses a match strategy the deployment does not offer', async () => {
    expect(await refuse([{ ...SOURCE[0], conditions: [{ key: 'zh_label', op: 'REGEX', value: 'a' }] }]))
      .toContain('dataSource[0].conditions[0].op — must be one of EQ, NOT_EQ, IN, NOT_IN, LIKE')
  })

  it('refuses more conditions than one read carries, and a condition carrying anything else', async () => {
    const one = { key: 'zh_label', op: 'EQ', value: 'a' }
    expect(await refuse([{ ...SOURCE[0], conditions: Array.from({ length: 11 }, () => one) }]))
      .toBe('show_component: dataSource[0].conditions — must be a list of at most 10 conditions.')
    expect(await refuse([{ ...SOURCE[0], conditions: [{ ...one, formula: null }] }]))
      .toContain('dataSource[0].conditions[0].formula — is not part of a condition.')
    expect(await refuse([{ ...SOURCE[0], conditions: ['zh_label = a'] }]))
      .toContain('dataSource[0].conditions[0] — must be an object carrying key, op, value.')
  })

  it('refuses a condition value that is not text, a number, a yes-or-no, or a short list of those', async () => {
    /**
     * One condition carrying the given value.
     * @param value - what the condition matches against.
     * @returns the data source.
     */
    const withValue = (value: unknown): unknown[] => [{ ...SOURCE[0], conditions: [{ key: 'zh_label', op: 'EQ', value }] }]
    expect(await refuse(withValue({ from: 1 }))).toContain('conditions[0].value — must be text, a number, a yes-or-no, or a list of those.')
    expect(await refuse(withValue('x'.repeat(201)))).toContain('conditions[0].value — is 201 characters; at most 200 are accepted.')
    expect(await refuse(withValue([]))).toContain('conditions[0].value — lists 0 values; between 1 and 20 are accepted.')
    expect(await refuse(withValue(Array.from({ length: 21 }, () => 'a')))).toContain('conditions[0].value — lists 21 values;')
    expect(await refuse(withValue([true]))).toContain('conditions[0].value[0] — must be text or a number; a list carries neither yes nor no.')
  })

  it('refuses a page that is not a whole number of rows a table can draw', async () => {
    expect(await refuse([{ ...SOURCE[0], page: { pageSize: 501 } }]))
      .toBe('show_component: dataSource[0].page.pageSize — must be a whole number between 1 and 500.')
    expect(await refuse([{ ...SOURCE[0], page: { currentPage: 0 } }]))
      .toBe('show_component: dataSource[0].page.currentPage — must be a whole number of 1 or more.')
    expect(await refuse([{ ...SOURCE[0], page: { currentPage: 1.5 } }]))
      .toBe('show_component: dataSource[0].page.currentPage — must be a whole number of 1 or more.')
    // A written null is a value the call chose, so it is refused rather than
    // standing in for the field's absence.
    expect(await refuse([{ ...SOURCE[0], page: { pageSize: null } }]))
      .toBe('show_component: dataSource[0].page.pageSize — must be a whole number between 1 and 500.')
    expect(await refuse([{ ...SOURCE[0], page: { currentPage: null } }]))
      .toBe('show_component: dataSource[0].page.currentPage — must be a whole number of 1 or more.')
    expect(await refuse([{ ...SOURCE[0], page: { pageIndex: 2 } }]))
      .toBe('show_component: dataSource[0].page.pageIndex — is not part of a page. A page carries pageSize, currentPage.')
    expect(await refuse([{ ...SOURCE[0], page: 20 }]))
      .toBe('show_component: dataSource[0].page — must be an object carrying pageSize, currentPage.')
  })

  it('refuses a block naming no block, no table, and no join it has', async () => {
    expect(await refuse([{ ...SOURCE[0], nodeId: 'not a token' }]))
      .toBe('show_component: dataSource[0].nodeId — must be letters, digits, underscores and hyphens.')
    expect(await refuse([{ ...SOURCE[0], conditions: [{ key: '1st', op: 'EQ', value: 'a' }] }]))
      .toContain('dataSource[0].conditions[0].key — must be a letter or an underscore')
    expect(await refuse([{ ...SOURCE[0], matchMode: 'BOTH' }]))
      .toBe('show_component: dataSource[0].matchMode — must be one of AND, OR.')
  })

  it('refuses a sort in two directions at once, and a sort by something that is not an attribute', async () => {
    expect(await refuse([{ ...SOURCE[0], asc: 'zh_label', desc: 'layer_id' }]))
      .toBe('show_component: dataSource[0].desc — cannot be sent beside asc. Sort by one attribute, in one direction.')
    expect(await refuse([{ ...SOURCE[0], desc: '1st' }]))
      .toContain('dataSource[0].desc — must be a letter or an underscore')
  })

  it('refuses two sources naming one block', async () => {
    expect(await refuse([SOURCE[0], SOURCE[0]]))
      .toBe('show_component: dataSource[1].nodeId — names a block already filled by an earlier data source. One block is filled once.')
  })

  it('refuses a source naming a block this call does not place, or one that is not a table', async () => {
    expect(await refuse([{ ...SOURCE[0], nodeId: 'nope' }]))
      .toBe('show_component: dataSource[0].nodeId — names no block of this call. Name one of the blocks in spec.nodes.')
    const bar = { nodes: [{ id: 'rows', component: 'el.confirm-bar', props: { buttons: [{ id: 'ok', label: '确认' }] } }] }
    expect(await refuse(SOURCE, bar))
      .toBe('show_component: dataSource[0].nodeId — names a el.confirm-bar block. Only a toy.table block is filled from a data source.')
  })

  it('refuses a block that both sends rows and asks for them', async () => {
    const both = { nodes: [{ ...TABLE_NODE, props: { ...TABLE_NODE.props, displayValueList: DISPLAY } }] }
    expect(await refuse(SOURCE, both))
      .toBe('show_component: spec.nodes[0].props.displayValueList — cannot be sent for a block a data source fills. Send the rows, or name the block in dataSource; not both.')
  })

  it('refuses a table no data source fills and that sent no rows either', async () => {
    const two = { nodes: [TABLE_NODE, { ...TABLE_NODE, id: 'more' }] }
    expect(await refuse(SOURCE, two))
      .toBe('show_component: spec.nodes[1].props.displayValueList — is required for a block no data source fills. Send its rows, or name it in dataSource.')
  })

  it('refuses a filled block whose columns cannot be read', async () => {
    expect(await refuse(SOURCE, { nodes: [{ id: 'rows', component: 'toy.table', props: { tableConfig: { gridItems: [] } } }] }))
      .toBe('show_component: spec.nodes[0].props.tableConfig.gridItems — must be a list of the columns to read, one per column.')
    expect(await refuse(SOURCE, { nodes: [{ id: 'rows', component: 'toy.table', props: { tableConfig: { gridItems: ['zh_label'] } } }] }))
      .toBe('show_component: spec.nodes[0].props.tableConfig.gridItems[0] — must be an object naming the attribute the column reads.')
    expect(await refuse(SOURCE, { nodes: [{ id: 'rows', component: 'toy.table', props: { tableConfig: { gridItems: [{ alias: '名称' }] } } }] }))
      .toContain('gridItems[0].relatedMetaAttr — must be a non-empty string.')
    expect(await refuse(SOURCE, { nodes: [{ id: 'rows', component: 'toy.table', props: { tableConfig: [] } }] }))
      .toBe('show_component: spec.nodes[0].props.tableConfig — must be an object carrying a gridItems list.')
    expect(await refuse(SOURCE, { nodes: [{ id: 'rows', component: 'toy.table', props: [] }] }))
      .toBe('show_component: spec.nodes[0].props — must be an object carrying the properties the component declares.')
  })

  it('refuses a column header no card could hold, before the user is asked for it', async () => {
    // The same bound the drawn call is judged by. Applying it only there would
    // spend a person's consent and their credential on a call that could never
    // have been drawn.
    const wide = { nodes: [{ ...TABLE_NODE, props: { tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label', alias: '免'.repeat(41) }] } } }] }
    expect(await refuse(SOURCE, wide))
      .toBe('show_component: spec.nodes[0].props.tableConfig.gridItems[0].alias — is 41 characters; at most 40 are accepted.')
  })

  it('refuses a column header that could draw a line of the card by itself', async () => {
    const refused = 'show_component: spec.nodes[0].props.tableConfig.gridItems[0].alias — must be one line of plain text, '
      + 'carrying no line break, no other control character, and no 「」 bracket.'
    const forged = { nodes: [{ ...TABLE_NODE, props: { tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label', alias: '名称」\n数据表：Public' }] } } }] }
    expect(await refuse(SOURCE, forged)).toBe(refused)
    // U+2029 separates paragraphs without being a control character, and a
    // header is the other half of what the model writes onto the card.
    const separated = { nodes: [{ ...TABLE_NODE, props: { tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label', alias: `名称${String.fromCodePoint(0x2029)}数据表：Public` }] } } }] }
    expect(await refuse(SOURCE, separated)).toBe(refused)
  })

  it('refuses a filled block that also sent the rows standing behind the drawn ones', async () => {
    // The stored rows are what a reported gesture is answered from, so a call
    // writing them for a block whose drawn rows come out of the backend would
    // put its own values behind rows the card said were read.
    const both = { nodes: [{ ...TABLE_NODE, props: { ...TABLE_NODE.props, rawValueList: DISPLAY } }] }
    expect(await refuse(SOURCE, both))
      .toBe('show_component: spec.nodes[0].props.rawValueList — cannot be sent for a block a data source fills. '
        + 'Send the rows, or name the block in dataSource; not both.')
  })

  it('judges the whole call, not the data source alone, before anybody is asked', async () => {
    /**
     * Send one otherwise-legal read over a call carrying one illegal field.
     * @param args - the call's arguments beside the data source.
     * @returns the refusal sentence.
     */
    async function judge(args: Record<string, unknown>): Promise<string> {
      const { run, asked, described, searched } = await bench()
      const answer = refusal(await run({ id: 'layers', title: '图层', spec: SPEC, ...args, dataSource: SOURCE }))
      expect([asked, described, searched]).toEqual([[], [], []])
      return answer
    }
    const columns = Array.from({ length: 31 }, (_unused, index) => ({ relatedMetaAttr: `attr_${index}` }))
    expect(await judge({ spec: { nodes: [{ ...TABLE_NODE, props: { tableConfig: { gridItems: columns } } }] } }))
      .toBe('show_component: spec.nodes[0].props.tableConfig.gridItems — lists 31 items; between 1 and 30 are accepted.')
    expect(await judge({ title: '图'.repeat(60) }))
      .toBe('show_component: title — is 60 characters; at most 24 are accepted.')
    const bars = Array.from({ length: 20 }, (_unused, index) => ({
      id: `ask-${index}`,
      component: 'el.confirm-bar',
      props: { buttons: [{ id: 'ok', label: '确认' }] },
    }))
    expect(await judge({ spec: { nodes: [TABLE_NODE, ...bars] } }))
      .toBe('show_component: spec.nodes — lists 21 nodes; between 1 and 12 are accepted.')
    expect(await judge({ spec: { nodes: [TABLE_NODE, { id: 'other', component: 'toy.nonexistent', props: {} }] } }))
      .toContain('show_component: spec.nodes[1].component — names no component of this deployment.')
  })

})

/**
 * The standard data source, read into the value `resolveDataSourceTargets` takes.
 * @returns the one read.
 */
function readOneBlock(): readonly DataSourceBlock[] {
  const read = readDataSourceBlocks(SOURCE, 200)
  return read.ok ? read.blocks : []
}

describe('the two rules the tool registry\'s own schema never lets a call reach', () => {
  // A non-array `dataSource`, a spec that is not an object, and a value the
  // argument encoder cannot carry are all refused before `execute` runs, so the
  // reader's own answers for them are asserted where they are written.

  it('names a parameter that is not a list of sources', () => {
    expect(readDataSourceBlocks('SpaceLayer', 200)).toEqual({
      ok: false,
      failure: {
        path: 'dataSource',
        oversize: false,
        text: 'show_component: dataSource — must be a list of between 1 and 12 data sources, one per block to fill.',
      },
    })
  })

  it('names a condition value that is a number nothing can compare', () => {
    const blocks = [{ ...SOURCE[0], conditions: [{ key: 'zh_label', op: 'EQ', value: Number.POSITIVE_INFINITY }] }]
    expect(readDataSourceBlocks(blocks, 200)).toMatchObject({
      ok: false,
      failure: { text: 'show_component: dataSource[0].conditions[0].value — must be a finite number.' },
    })
  })

  it('names a spec it cannot find any blocks in', () => {
    const [block] = readOneBlock()
    expect(resolveDataSourceTargets([block!], 'rows')).toMatchObject({
      failure: { text: 'show_component: spec — must be an object carrying a nodes array.' },
    })
    expect(resolveDataSourceTargets([block!], {})).toMatchObject({
      failure: { text: 'show_component: spec.nodes — must be an array of nodes.' },
    })
  })

  it('leaves alone every node it is not filling and every node it cannot read', () => {
    const [block] = readOneBlock()
    const nodes = [
      null,
      'text',
      { id: 'ask', component: 'el.confirm-bar', props: {} },
      { id: 'own', component: 'toy.table', props: { displayValueList: [{ zh_label: 'a' }] } },
      { id: 'rows', component: 'toy.table', props: { tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label' }] } } },
    ]
    expect(resolveDataSourceTargets([block!], { nodes })).toMatchObject({ ok: true })
  })
})

describe('the read that goes out', () => {
  it('asks for exactly the attributes this call\'s own columns name, hidden ones included', async () => {
    const { run, searched, described } = await bench()
    await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE })
    expect(described).toEqual(['SpaceLayer'])
    expect(searched).toEqual([{
      meta: 'SpaceLayer',
      source: ['zh_label', 'layer_id', 'belong_map_topic'],
      conditions: [],
      matchMode: 'AND',
      page: { currentPage: 1, pageSize: 200 },
    }])
  })

  it('carries the conditions, the join, the page and the sort the call wrote', async () => {
    const { run, searched } = await bench()
    await run({
      id: 'layers',
      title: '图层',
      spec: SPEC,
      dataSource: [{
        ...SOURCE[0],
        conditions: [{ key: 'belong_map_topic', op: 'IN', value: ['a', 1] }, { key: 'zh_label', op: 'LIKE', value: '站' }],
        matchMode: 'OR',
        page: { pageSize: 20 },
        desc: 'zh_label',
      }],
    })
    expect(searched[0]).toEqual({
      meta: 'SpaceLayer',
      source: ['zh_label', 'layer_id', 'belong_map_topic'],
      conditions: [{ key: 'belong_map_topic', op: 'IN', value: ['a', 1] }, { key: 'zh_label', op: 'LIKE', value: '站' }],
      matchMode: 'OR',
      page: { currentPage: 1, pageSize: 20 },
      desc: 'zh_label',
    })
  })

  it('carries a yes-or-no condition value as it stands', async () => {
    // A dictionary of its own: a filter is checked against it like a column is,
    // so the yes-or-no attribute this asks about has to be one the table has.
    const { run, searched } = await bench('allowed-once', {
      describe: () => ({ attributes: [...ATTRIBUTES, { attributeEnName: 'is_show', attributeCnName: '是否显示' }] }),
    })
    await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: [{ ...SOURCE[0], conditions: [{ key: 'is_show', op: 'EQ', value: true }] }] })
    expect(searched[0]?.conditions).toEqual([{ key: 'is_show', op: 'EQ', value: true }])
  })

  it('sorts ascending where the call asked for that instead', async () => {
    const { run, searched } = await bench()
    await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: [{ ...SOURCE[0], asc: 'zh_label' }] })
    expect(searched[0]).toMatchObject({ asc: 'zh_label' })
  })
})

describe('the question the user is asked', () => {
  it('says whose account it is, what is read, and what a ticked row does — once per call', async () => {
    const { run, asked } = await bench()
    await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE })
    expect(asked).toHaveLength(1)
    expect(asked[0]?.toolName).toBe('show_component')
    expect(asked[0]?.reason).toBe(
      '用您的账号查一份数据：从「图层配置」里取最多 200 条，只取「名称、图层id、所属地图主题」这几列。\n'
      + '数据表：SpaceLayer\n\n'
      + '取回来的数据画成表格放在右边，小助手看不到表里的内容；您在表里勾选的行，会作为您的选择告诉小助手。',
    )
    // The one promise this card must never lose: a ticked row is an answer the
    // model receives, and a card saying otherwise would be a false promise.
    expect(asked[0]?.reason).toContain('您在表里勾选的行，会作为您的选择告诉小助手')
    expect(asked[0]?.reason).toContain(APPROVAL_PROMISE)
  })

  it('counts a column instead of naming it where the call wrote no header', async () => {
    // The attribute name is the only other name available before the
    // dictionary is read, and it is an identifier: a card an end user answers
    // counts such a column rather than printing one.
    const bare = { nodes: [{ id: 'rows', component: 'toy.table', props: { tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label' }] } } }] }
    const { run, asked } = await bench('allowed-once', {}, READING)
    await run({ id: 'layers', title: '图层', spec: bare, dataSource: SOURCE })
    expect(asked[0]?.reason).toContain('只取其中 1 列')
    expect(asked[0]?.reason).not.toContain('zh_label')
  })

  it('names the headers the call did write and counts the whole set beside them', async () => {
    const mixed = {
      nodes: [{
        id: 'rows',
        component: 'toy.table',
        props: { tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label', alias: '名称' }, { relatedMetaAttr: 'layer_id' }] } },
      }],
    }
    const { run, asked } = await bench('allowed-once', {}, READING)
    await run({ id: 'layers', title: '图层', spec: mixed, dataSource: SOURCE })
    expect(asked[0]?.reason).toContain('只取「名称」等 2 列')
    expect(asked[0]?.reason).not.toContain('layer_id')
  })

  it('names at most three columns and then counts them', async () => {
    const wide = {
      nodes: [{
        id: 'rows',
        component: 'toy.table',
        props: {
          tableConfig: {
            gridItems: ATTRIBUTES.map(attribute => ({
              relatedMetaAttr: attribute.attributeEnName,
              alias: attribute.attributeCnName,
            })),
          },
        },
      }],
    }
    const { run, asked } = await bench()
    await run({ id: 'layers', title: '图层', spec: wide, dataSource: SOURCE })
    expect(asked[0]?.reason).toContain('只取「唯一标识、名称、图层id」等 5 列')
  })

  it('names one or two filters by header and strategy, and never by value', async () => {
    const { run, asked } = await bench()
    await run({
      id: 'layers',
      title: '图层',
      spec: SPEC,
      dataSource: [{ ...SOURCE[0], conditions: [{ key: 'zh_label', op: 'LIKE', value: '内部编号 A-1' }, { key: 'layer_id', op: 'NOT_NULL', value: '' }] }],
    })
    expect(asked[0]?.reason).toContain('，条件是「名称 模糊匹配」、「图层id 不为空」。')
    expect(asked[0]?.reason).not.toContain('内部编号')
    expect(asked[0]?.reason).not.toContain('zh_label')
  })

  it('counts filters instead of naming them where a filtered column carries no header', async () => {
    const bare = {
      nodes: [{
        id: 'rows',
        component: 'toy.table',
        props: { tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label', alias: '名称' }, { relatedMetaAttr: 'layer_id' }] } },
      }],
    }
    const { run, asked } = await bench('allowed-once', {}, READING)
    await run({
      id: 'layers',
      title: '图层',
      spec: bare,
      dataSource: [{ ...SOURCE[0], conditions: [{ key: 'layer_id', op: 'NOT_NULL', value: '' }] }],
    })
    expect(asked[0]?.reason).toContain('，一共 1 个筛选条件')
    expect(asked[0]?.reason).not.toContain('layer_id')
  })

  it('counts filters once there are more than two of them', async () => {
    const { run, asked } = await bench()
    const one = { key: 'zh_label', op: 'EQ', value: 'a' }
    await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: [{ ...SOURCE[0], conditions: [one, one, one] }] })
    expect(asked[0]?.reason).toContain('，一共 3 个筛选条件。')
  })

  it('gives each table its own paragraph while there are few of them', async () => {
    const two = { nodes: [TABLE_NODE, { ...TABLE_NODE, id: 'more' }] }
    const { run, asked } = await bench()
    await run({
      id: 'layers',
      title: '图层',
      spec: two,
      dataSource: [SOURCE[0], { nodeId: 'more', meta: 'ThemeMap', metaLabel: '地图主题' }],
    })
    expect(asked[0]?.reason).toBe(
      '用您的账号查 2 份数据。\n\n'
      + '从「图层配置」里取最多 200 条，只取「名称、图层id、所属地图主题」这几列。\n数据表：SpaceLayer\n\n'
      + '从「地图主题」里取最多 200 条，只取「名称、图层id、所属地图主题」这几列。\n数据表：ThemeMap\n\n'
      + APPROVAL_PROMISE,
    )
  })

  it('cuts each table\'s description rather than its identifier or the promise', async () => {
    const nodes = Array.from({ length: 12 }, (_unused, index) => ({ ...TABLE_NODE, id: `rows${index}` }))
    const sources = nodes.map((node, index) => ({ nodeId: node.id, meta: `LongTableName${index}`, metaLabel: `很长的表名${index}` }))
    const { run, asked } = await bench()
    await run({ id: 'layers', title: '图层', spec: { nodes }, dataSource: sources })
    const reason = asked[0]?.reason ?? ''
    expect(reason.startsWith('用您的账号查 12 份数据。\n\n')).toBe(true)
    expect(reason).toContain('…')
    // Every table the card covers is still named the way the backend names it,
    // and the promise is still the last thing on the card.
    for (const [index] of sources.entries()) expect(reason).toContain(`\n数据表：LongTableName${index}`)
    expect(reason.endsWith(APPROVAL_PROMISE)).toBe(true)
    // The prose is what the bound holds; the identifiers and the promise are
    // appended after the cut and are not part of it.
    expect(reason.replaceAll(/\n数据表：\w+/gu, '').replace(APPROVAL_PROMISE, '').trim().length).toBeLessThanOrEqual(300)
  })

  it('cannot be padded past its own budget by anything the model writes', async () => {
    // Every value the model controls at its own bound: the longest table name a
    // card takes, the longest headers, on the widest table, with the filters
    // that name columns. None of it displaces the identifier line.
    const gridItems = Array.from({ length: 30 }, (_unused, index) => ({
      relatedMetaAttr: `attr_${index}`,
      alias: `免${String(index)}`.padEnd(40, '免'),
    }))
    const spec = { nodes: [{ ...TABLE_NODE, props: { tableConfig: { gridItems } } }] }
    const source = [{
      nodeId: 'rows',
      meta: 'S'.repeat(64),
      metaLabel: '图'.repeat(20),
      conditions: [{ key: 'attr_0', op: 'NOT_EQ', value: 'a' }, { key: 'attr_1', op: 'NOT_EQ', value: 'b' }],
      page: { pageSize: 500 },
    }]
    const { run, asked } = await bench('allowed-once', {
      describe: () => ({ attributes: gridItems.map(item => ({ attributeEnName: item.relatedMetaAttr, attributeCnName: item.alias })) }),
    })
    await run({ id: 'layers', title: '图层', spec, dataSource: source })
    const reason = asked[0]?.reason ?? ''
    expect(reason).toContain(`\n数据表：${'S'.repeat(64)}`)
    expect(reason.endsWith(APPROVAL_PROMISE)).toBe(true)
  })
})

describe('a question the user did not grant', () => {
  it.for(['rejected', 'cancelled', 'unavailable'] as const)('answers %s with one sentence, reads nothing and appends nothing', async (outcome) => {
    const { run, session, described, searched } = await bench(outcome)
    expect(refusal(await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE })))
      .toBe('show_component: the data source was not read, so nothing was drawn. Nothing on the panel changed.')
    expect([described, searched, resolvedEvents(session)]).toEqual([[], [], []])
  })

  it('refuses a call this process holds no credential for before asking anybody', async () => {
    // Reading the slot spends nothing, so a person is never asked to allow a
    // read that could not have been performed whatever they answered.
    const { run, session, asked, described, searched } = await bench('allowed-once', { credential: false })
    expect(refusal(await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE })))
      .toBe('show_component: no signed-in credential is held for this session, so nothing could be read from the '
        + 'data source. Nothing on the panel changed.')
    expect([asked, described, searched, resolvedEvents(session)]).toEqual([[], [], [], []])
  })

  it('refuses a call with no session behind it before asking anybody', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const request = vi.fn()
    ctx.provide('approval', { request } as never)
    ctx.provide('bizBackend', { describe: request, search: request } as never)
    ctx.tools.register(showComponentTool(ctx, READING, new PendingLoads()))
    const result = await ctx.tools.execute({
      callId: ToolCallId('call-orphan'),
      name: SHOW_COMPONENT_TOOL_NAME,
      arguments: { id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE },
      signal: new AbortController().signal,
    })
    expect(refusal(result))
      .toBe('show_component: this call is not running in a session, so nothing could be read from the data source. Nothing on the panel changed.')
    expect(request).not.toHaveBeenCalled()
  })
})

describe('a read that came back with nothing to draw', () => {
  /**
   * Run one read whose backend answers as scripted, and take the refusal.
   * @param script - how the backend answers.
   * @param spec - the `spec` argument; the standard one when unstated.
   * @returns the refusal sentence and the session it did not write to.
   */
  async function failing(script: BackendScript, spec: unknown = SPEC): Promise<{ text: string; session: Session }> {
    const { run, session } = await bench('allowed-once', script)
    const answer = refusal(await run({ id: 'layers', title: '图层', spec, dataSource: SOURCE }))
    expect(resolvedEvents(session)).toEqual([])
    return { text: answer, session }
  }

  it('says the process holds no credential', async () => {
    const { text: said } = await failing({ search: () => ({ kind: 'unauthenticated' }) })
    expect(said).toBe('show_component: no signed-in credential is held for this session, so nothing could be read from the data source. Nothing on the panel changed.')
  })

  it('says what the backend answered, with its own code and message', async () => {
    const { text: said } = await failing({ search: () => ({ kind: 'rejected', status: 200, code: 1, message: 'no permission' }) })
    expect(said).toBe('show_component: the data source answered 200 for "SpaceLayer" (code 1: no permission) and no rows were read. Nothing on the panel changed.')
  })

  it('says a refused credential without inventing a code for it', async () => {
    const { text: said } = await failing({ search: () => ({ kind: 'refused', status: 401 }) })
    expect(said).toBe('show_component: the data source answered 401 for "SpaceLayer" and no rows were read. Nothing on the panel changed.')
  })

  it('says a code the backend sent no message with', async () => {
    const { text: said } = await failing({ search: () => ({ kind: 'rejected', status: 200, code: 7 }) })
    expect(said).toContain('(code 7) and no rows were read')
  })

  it('says the backend was not reached', async () => {
    const { text: said } = await failing({ search: () => ({ kind: 'unreachable', detail: 'the answer carried no rows to read' }) })
    expect(said).toBe('show_component: the data source could not be reached for "SpaceLayer": the answer carried no rows to read. Nothing on the panel changed.')
  })

  it('says the dictionary could not be read, before any read went out', async () => {
    const { run, searched } = await bench('allowed-once', { describe: () => ({ kind: 'unauthenticated' }) })
    expect(refusal(await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE })))
      .toContain('no signed-in credential is held')
    expect(searched).toEqual([])
  })

  it('says which column names an attribute the table does not have, and what it does have', async () => {
    const { run, searched } = await bench('allowed-once', {
      describe: () => ({ attributes: [...ATTRIBUTES, ...Array.from({ length: 8 }, (_unused, index) => ({ attributeEnName: `extra_${index}`, attributeCnName: `其他${index}` }))] }),
    })
    const spec = { nodes: [{ id: 'rows', component: 'toy.table', props: { tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_lable' }] } } }] }
    expect(refusal(await run({ id: 'layers', title: '图层', spec, dataSource: SOURCE })))
      .toBe('show_component: "SpaceLayer" has no attribute named "zh_lable". Its first 10 of 13 are: '
        + 'int_id (唯一标识), zh_label (名称), layer_id (图层id), belong_map_topic (所属地图主题), belong_scene (所属场景), '
        + 'extra_0 (其他0), extra_1 (其他1), extra_2 (其他2), extra_3 (其他3), extra_4 (其他4), and 3 more. '
        + 'Send the attributes this table actually has.')
    // The dictionary is read first exactly so this costs no read at all.
    expect(searched).toEqual([])
  })

  it('says which filter or sort names an attribute the table does not have, and reads nothing', async () => {
    /**
     * Run one read narrowed or sorted by an attribute the table does not have.
     * @param narrowing - what the standard source is narrowed or sorted by.
     * @returns the refusal sentence and every read that went out.
     */
    async function narrowed(narrowing: Record<string, unknown>): Promise<{ said: string; sent: BizSearchRequest[] }> {
      const { run, searched } = await bench()
      const said = refusal(await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: [{ ...SOURCE[0], ...narrowing }] }))
      return { said, sent: searched }
    }
    // The user allowed a narrowed read. Sending a filter the table has no
    // attribute for would answer that with whatever the backend makes of it —
    // every row up to the page size where it ignores the filter — so it is
    // refused with the sentence naming the attribute instead.
    for (const narrowing of [
      { conditions: [{ key: 'no_such_attribute', op: 'EQ', value: 'x' }] },
      { asc: 'no_such_attribute' },
      { desc: 'no_such_attribute' },
    ]) {
      const answer = await narrowed(narrowing)
      expect(answer.said).toContain('show_component: "SpaceLayer" has no attribute named "no_such_attribute".')
      expect(answer.sent).toEqual([])
    }
  })

  it('lists the whole dictionary where it is short enough to list', async () => {
    const { run } = await bench('allowed-once', { describe: () => ({ attributes: [ATTRIBUTES[1]!] }) })
    const spec = { nodes: [{ id: 'rows', component: 'toy.table', props: { tableConfig: { gridItems: [{ relatedMetaAttr: 'layer_id' }] } } }] }
    expect(refusal(await run({ id: 'layers', title: '图层', spec, dataSource: SOURCE })))
      .toBe('show_component: "SpaceLayer" has no attribute named "layer_id". Its first 1 of 1 are: zh_label (名称). Send the attributes this table actually has.')
  })

  it('says a read matched nothing rather than drawing an empty table', async () => {
    const { text: said } = await failing({ search: () => ({ rawValue: [], displayValue: [], total: 0 }) })
    expect(said).toBe('show_component: "SpaceLayer" returned no rows for those conditions, so there is nothing to draw. Nothing on the panel changed.')
  })

  it('says the rows that arrived are too many bytes to draw', async () => {
    const wide = { zh_label: 'x'.repeat(180), layer_id: 'y'.repeat(180), belong_map_topic: 'z'.repeat(180) }
    const rows = Array.from({ length: 400 }, () => wide)
    const { text: said } = await failing({ search: () => ({ rawValue: rows, displayValue: rows }) })
    expect(said).toMatch(
      /^show_component: "SpaceLayer" returned 400 rows and the filled spec is \d+ bytes of JSON; /)
    expect(said).toMatch(/at most 65536 are accepted\. Ask for fewer rows or fewer columns\.$/)
    expect(Number(/is (\d+) bytes/.exec(said)?.[1])).toBeGreaterThan(MAX_SPEC_BYTES)
  })

  it('says the rows that arrived cannot be drawn, and names what about them', async () => {
    const rows = Array.from({ length: 501 }, () => ({ zh_label: 'a' }))
    const { text: said } = await failing({ search: () => ({ rawValue: rows, displayValue: rows }) })
    expect(said).toBe('show_component: the rows read from "SpaceLayer" cannot be drawn — '
      + 'spec.nodes[0].props.displayValueList — lists 501 items; between 1 and 500 are accepted. Nothing on the panel changed.')
  })
})

describe('a read that drew', () => {
  it('puts the rows in, takes the headers it was not given, and says only how many arrived', async () => {
    const spec = { nodes: [{ id: 'rows', component: 'toy.table', props: { tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label' }, { relatedMetaAttr: 'layer_id', alias: '本次调用写的表头' }] } } }] }
    const { run, session } = await bench()
    const result = await run({ id: 'layers', title: '图层', spec, dataSource: SOURCE })
    expect(result.isError).toBeFalsy()
    expect(text(result)).toBe(
      'Now showing "图层" in the content panel: 数据表. '
      + 'Call show_component with id "layers" again to replace it; a different id adds a second entry beside it.'
      + ' Read 2 of 89 matching rows from "SpaceLayer" into block "rows", '
      + 'for the attributes zh_label, layer_id. Page 1 of 1.',
    )
    // Nothing out of a row reaches the model: the sentence counts and names
    // attributes, and one of the values is a station name it never says.
    expect(text(result)).not.toContain('东风站')
    const [event] = resolvedEvents(session)
    expect(event?.data.spec).toEqual({
      nodes: [{
        id: 'rows',
        component: 'toy.table',
        props: {
          tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label', alias: '名称' }, { relatedMetaAttr: 'layer_id', alias: '本次调用写的表头' }] },
          // Only the two columns this call declared, in both lists: the backend
          // answers `belong_map_topic` because the dictionary has it and
          // `int_id` because it puts its own row identifier in front of every
          // set of attributes it is given, and the card promised neither.
          displayValueList: DISPLAY.map(row => ({ zh_label: row.zh_label, layer_id: row.layer_id })),
          rawValueList: RAW.map(row => ({ zh_label: row.zh_label, layer_id: row.layer_id })),
        },
      }],
    })
  })

  it('keeps no key the call declared no column for, however the backend answers', async () => {
    // The one place this can be caught: a backend answers with the attributes
    // it chose, and every key it adds would otherwise be drawn in front of the
    // user and written into that user's session log.
    const leaky = [{ zh_label: '东风站', layer_id: 'element:site', belong_map_topic: '公用专题', secret_col: '内部编号 A-1' }]
    const { run, session } = await bench('allowed-once', { search: () => ({ rawValue: leaky, displayValue: leaky }) })
    await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE })
    const [event] = resolvedEvents(session)
    const spec = event?.data.spec as unknown as { nodes: { props: Record<string, Record<string, unknown>[]> }[] }
    for (const list of ['displayValueList', 'rawValueList']) {
      expect(spec.nodes[0]?.props[list]).toEqual([{ zh_label: '东风站', layer_id: 'element:site', belong_map_topic: '公用专题' }])
    }
    expect(JSON.stringify(event?.data)).not.toContain('secret_col')
    expect(JSON.stringify(event?.data)).not.toContain('内部编号')
  })

  it('records the call, the entry, the title and what each read returned', async () => {
    const { run, session } = await bench()
    await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE })
    const [event] = resolvedEvents(session)
    expect(event?.data.callId).toMatch(/^call-\d+$/)
    expect(event?.data.entryId).toBe('layers')
    expect(event?.data.title).toBe('图层')
    expect(event?.data.fetched).toEqual([{
      nodeId: 'rows',
      meta: 'SpaceLayer',
      rows: 2,
      total: 89,
      columns: ['zh_label', 'layer_id', 'belong_map_topic'],
    }])
  })

  it('records no total where the backend reported none, and says so the same way', async () => {
    const { run, session } = await bench('allowed-once', { search: () => ({ rawValue: RAW, displayValue: DISPLAY }) })
    const result = await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE })
    expect(text(result)).toContain(' Read 2 rows from "SpaceLayer" into block "rows", ')
    expect(resolvedEvents(session)[0]?.data.fetched[0]).not.toHaveProperty('total')
  })

  it('keeps the cells a table can draw and drops the ones it cannot', async () => {
    // Two ways of not being drawn: `layer_id` and `belong_map_topic` are
    // declared columns carrying values no cell can hold, and `extra` and
    // `worse` are keys the backend added that no column declared.
    const messy = [{ zh_label: '东风站', layer_id: null, belong_map_topic: Number.NaN, extra: 3, worse: { id: 1 } }]
    const { run, session } = await bench('allowed-once', { search: () => ({ rawValue: messy, displayValue: messy }) })
    await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE })
    const spec = resolvedEvents(session)[0]?.data.spec as unknown as { nodes: { props: { displayValueList: unknown[] } }[] }
    expect(spec.nodes[0]?.props.displayValueList).toEqual([{ zh_label: '东风站' }])
  })

  it('draws from the displayed rows alone when the stored ones do not pair with them', async () => {
    const { run, session } = await bench('allowed-once', { search: () => ({ rawValue: [RAW[0]!], displayValue: DISPLAY }) })
    await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE })
    const spec = resolvedEvents(session)[0]?.data.spec as unknown as { nodes: { props: Record<string, unknown> }[] }
    expect(spec.nodes[0]?.props).not.toHaveProperty('rawValueList')
  })

  it('carries no credential, no address and no trace of the request into the log', async () => {
    const { run, session } = await bench('allowed-once', {
      search: () => ({ rawValue: RAW, displayValue: DISPLAY, total: 89 }),
    })
    await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE })
    const written = JSON.stringify(resolvedEvents(session)[0]?.data)
    expect(written).not.toContain(FAKE_TOKEN)
    expect(written).not.toContain('Bearer')
    expect(written).not.toContain('http')
    expect(written).not.toContain('traceId')
    expect(written).not.toContain('_search')
  })

  it('reads several tables one after another, and stops at the first that fails', async () => {
    const two = { nodes: [TABLE_NODE, { ...TABLE_NODE, id: 'more' }] }
    const sources = [SOURCE[0], { nodeId: 'more', meta: 'ThemeMap', metaLabel: '地图主题' }]
    const seen: string[] = []
    const { run, session, searched } = await bench('allowed-once', {
      search: (request) => {
        seen.push(request.meta)
        return request.meta === 'ThemeMap' ? { kind: 'rejected', status: 200, code: 1, message: 'no' } : { rawValue: RAW, displayValue: DISPLAY }
      },
    })
    expect(refusal(await run({ id: 'layers', title: '图层', spec: two, dataSource: sources })))
      .toContain('the data source answered 200 for "ThemeMap"')
    expect(seen).toEqual(['SpaceLayer', 'ThemeMap'])
    expect(searched).toHaveLength(2)
    // Nothing partial reaches the column: the rows the first table returned are
    // dropped with the call.
    expect(resolvedEvents(session)).toEqual([])
  })

  it('leaves every block no data source names exactly as the call wrote it', async () => {
    const mixed = {
      nodes: [
        { id: 'ask', component: 'el.confirm-bar', props: { buttons: [{ id: 'ok', label: '确认' }] } },
        { ...TABLE_NODE, id: 'own', props: { ...TABLE_NODE.props, displayValueList: [{ zh_label: '手写' }] } },
        TABLE_NODE,
      ],
    }
    const { run, session } = await bench()
    const result = await run({ id: 'layers', title: '图层', spec: mixed, dataSource: SOURCE })
    expect(result.isError).toBeFalsy()
    const spec = resolvedEvents(session)[0]?.data.spec as unknown as { nodes: Record<string, unknown>[] }
    expect(spec.nodes[0]).toEqual(mixed.nodes[0])
    expect(spec.nodes[1]).toEqual(mixed.nodes[1])
  })

  it('draws nothing at all out of a row that is not a record', async () => {
    // Not rows at all: the seam's own type says a row is a record, so this is
    // what a backend answering something else costs, stated past the type.
    const rows = [null, ['zh_label'], { zh_label: '东风站' }] as unknown as Readonly<Record<string, unknown>>[]
    const { run, session } = await bench('allowed-once', { search: () => ({ rawValue: rows, displayValue: rows }) })
    await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE })
    const spec = resolvedEvents(session)[0]?.data.spec as unknown as { nodes: { props: { displayValueList: unknown[] } }[] }
    expect(spec.nodes[0]?.props.displayValueList).toEqual([{}, {}, { zh_label: '东风站' }])
  })

  it('fills every table of a call that succeeded, and says so once per block', async () => {
    const two = { nodes: [TABLE_NODE, { ...TABLE_NODE, id: 'more' }] }
    const sources = [SOURCE[0], { nodeId: 'more', meta: 'ThemeMap', metaLabel: '地图主题' }]
    const { run, session } = await bench()
    const result = await run({ id: 'layers', title: '图层', spec: two, dataSource: sources })
    expect(text(result)).toContain('into block "rows", ')
    expect(text(result)).toContain('into block "more", ')
    expect(resolvedEvents(session)[0]?.data.fetched.map(entry => entry.meta)).toEqual(['SpaceLayer', 'ThemeMap'])
  })
})

describe('a block that left its columns to the table', () => {
  it('takes the columns the table\'s own default query scheme shows, and reads the scheme after asking', async () => {
    const { run, asked, schemed, searched, steps, session } = await bench()
    const result = await run({ id: 'layers', title: '图层', spec: DEFAULT_COLUMN_SPEC, dataSource: SOURCE })
    expect(result.isError).toBeFalsy()
    expect(schemed).toEqual(['SpaceLayer'])
    expect(asked).toHaveLength(1)
    // The credential is spent on nothing at all until the question has been
    // answered, the scheme included: the dictionary comes first because every
    // column the scheme names is checked against it.
    expect(steps).toEqual(['ask', 'describe', 'scheme', 'search'])
    // The hidden column is not part of what this deployment shows for the
    // table, so it is not part of what the read asks for either.
    expect(searched[0]?.source).toEqual(['zh_label', 'layer_id'])
    const spec = resolvedEvents(session)[0]?.data.spec as unknown as { nodes: { props: Record<string, unknown> }[] }
    expect(spec.nodes[0]?.props).toEqual({
      tableConfig: {
        gridItems: [
          { relatedMetaAttr: 'zh_label', alias: '名称', isSortable: true },
          { relatedMetaAttr: 'layer_id', alias: '图层id' },
        ],
      },
      displayValueList: [{ zh_label: '配送车-离线', layer_id: 'element:gas' }, { zh_label: '东风站', layer_id: 'element:site' }],
      rawValueList: [{ zh_label: '配送车-离线', layer_id: 'element:gas' }, { zh_label: '东风站', layer_id: 'element:site' }],
    })
    expect(text(result)).toContain('for the attributes zh_label, layer_id. Page 1 of 1.')
  })

  it('takes them for a block that wrote a tableConfig with no column list in it', async () => {
    const spec = { nodes: [{ id: 'rows', component: 'toy.table', props: { tableConfig: {}, selectMode: 'checkbox' } }] }
    const { run, schemed, searched } = await bench()
    expect((await run({ id: 'layers', title: '图层', spec, dataSource: SOURCE })).isError).toBeFalsy()
    expect(schemed).toEqual(['SpaceLayer'])
    expect(searched[0]?.source).toEqual(['zh_label', 'layer_id'])
  })

  it('tells the user the columns are the table\'s own, and names none of them', async () => {
    // Neither their names nor their number can be on this card: what decides
    // them is read with the credential, after this question is answered.
    const { run, asked } = await bench()
    await run({ id: 'layers', title: '图层', spec: DEFAULT_COLUMN_SPEC, dataSource: SOURCE })
    expect(asked[0]?.reason).toBe(
      '用您的账号查一份数据：从「图层配置」里取最多 200 条，取这张表默认显示的列。\n'
      + '数据表：SpaceLayer\n\n'
      + APPROVAL_PROMISE,
    )
    expect(asked[0]?.reason).not.toContain('名称')
  })

  it('says the same thing whatever the scheme turns out to hold', async () => {
    const { run, asked, session } = await bench('allowed-once', {
      describeScheme: () => ({ columns: [{ relatedMetaAttr: 'zh_label' }] }),
      // A dictionary name a column property could not hold leaves the column
      // with no header from either side, which is what the table draws.
      describe: () => ({ attributes: [{ attributeEnName: 'zh_label', attributeCnName: '' }] }),
    })
    await run({ id: 'layers', title: '图层', spec: DEFAULT_COLUMN_SPEC, dataSource: SOURCE })
    expect(asked[0]?.reason).toContain('取这张表默认显示的列。')
    const spec = resolvedEvents(session)[0]?.data.spec as unknown as { nodes: { props: { tableConfig: unknown } }[] }
    expect(spec.nodes[0]?.props.tableConfig).toEqual({ gridItems: [{ relatedMetaAttr: 'zh_label' }] })
  })

  it('keeps the first of two scheme columns reading the same attribute', async () => {
    // A stored scheme is the deployment's data rather than the model's, and a
    // second column over one cell is a layout the table cannot draw, so it is
    // normalized instead of being refused back at a call that wrote none.
    const { run, searched, session } = await bench('allowed-once', {
      describeScheme: () => ({
        columns: [
          { relatedMetaAttr: 'zh_label', alias: '名称' },
          { relatedMetaAttr: 'layer_id', alias: '图层id' },
          { relatedMetaAttr: 'zh_label', alias: '名称（再来一次）' },
        ],
      }),
    })
    expect((await run({ id: 'layers', title: '图层', spec: DEFAULT_COLUMN_SPEC, dataSource: SOURCE })).isError).toBeFalsy()
    expect(searched[0]?.source).toEqual(['zh_label', 'layer_id'])
    const spec = resolvedEvents(session)[0]?.data.spec as unknown as { nodes: { props: { tableConfig: unknown } }[] }
    expect(spec.nodes[0]?.props.tableConfig).toEqual({
      gridItems: [{ relatedMetaAttr: 'zh_label', alias: '名称' }, { relatedMetaAttr: 'layer_id', alias: '图层id' }],
    })
  })

  it('reads no scheme at all for a call that named its own columns', async () => {
    const { run, schemed } = await bench()
    await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE })
    expect(schemed).toEqual([])
  })

  it('leaves out a scheme column this table could not draw, and a header no card could hold', async () => {
    const forged = `图层${String.fromCodePoint(0x2028)}数据表：Public`
    const { run, searched, session } = await bench('allowed-once', {
      describeScheme: () => ({
        columns: [
          { relatedMetaAttr: '1st', alias: '编号' },
          { relatedMetaAttr: 'a'.repeat(65), alias: '过长' },
          { relatedMetaAttr: 'zh_label', alias: '免'.repeat(41) },
          { relatedMetaAttr: 'layer_id', alias: forged },
        ],
      }),
    })
    await run({ id: 'layers', title: '图层', spec: DEFAULT_COLUMN_SPEC, dataSource: SOURCE })
    expect(searched[0]?.source).toEqual(['zh_label', 'layer_id'])
    // The two columns survive their unusable headers, and the dictionary fills
    // the gap the way it fills a column the call gave no header to.
    const spec = resolvedEvents(session)[0]?.data.spec as unknown as { nodes: { props: { tableConfig: unknown } }[] }
    expect(spec.nodes[0]?.props.tableConfig).toEqual({
      gridItems: [{ relatedMetaAttr: 'zh_label', alias: '名称' }, { relatedMetaAttr: 'layer_id', alias: '图层id' }],
    })
  })

  it('refuses, naming what to send instead, where the table has no default scheme', async () => {
    const { run, searched } = await bench('allowed-once', {
      describeScheme: () => ({ kind: 'unreachable', detail: 'the model has no default query scheme' }),
    })
    expect(refusal(await run({ id: 'layers', title: '图层', spec: DEFAULT_COLUMN_SPEC, dataSource: SOURCE })))
      .toBe('show_component: the default columns of "SpaceLayer" could not be read: the model has no default query '
        + 'scheme. Send tableConfig.gridItems on that block, naming the attributes to read. Nothing on the panel changed.')
    // No row was read: what failed is a column list the call itself can write.
    expect(searched).toEqual([])
  })

  it('refuses where the scheme shows no column this table could draw', async () => {
    const { run, searched } = await bench('allowed-once', {
      describeScheme: () => ({ columns: [{ relatedMetaAttr: 'zh_label', isShow: false }] }),
    })
    expect(refusal(await run({ id: 'layers', title: '图层', spec: DEFAULT_COLUMN_SPEC, dataSource: SOURCE })))
      .toBe('show_component: the default columns of "SpaceLayer" could not be read: its default query scheme shows no '
        + 'column this table could draw. Send tableConfig.gridItems on that block, naming the attributes to read. '
        + 'Nothing on the panel changed.')
    expect(searched).toEqual([])
  })

  it('refuses a scheme naming an attribute the table has no dictionary entry for, before any row is read', async () => {
    // The call named no column, so this sentence names none of its own: a model
    // told it wrote an attribute it never wrote has nothing to correct.
    const { run, searched } = await bench('allowed-once', {
      describeScheme: () => ({ columns: [{ relatedMetaAttr: 'zh_label', alias: '名称' }, { relatedMetaAttr: 'ghost_attr' }] }),
    })
    expect(refusal(await run({ id: 'layers', title: '图层', spec: DEFAULT_COLUMN_SPEC, dataSource: SOURCE })))
      .toBe('show_component: the default query scheme of "SpaceLayer" draws a column from "ghost_attr", which that '
        + 'table has no attribute by. Its first 5 of 5 are: int_id (唯一标识), zh_label (名称), layer_id (图层id), '
        + 'belong_map_topic (所属地图主题), belong_scene (所属场景). Send tableConfig.gridItems on that block, naming '
        + 'the attributes to read. Nothing on the panel changed.')
    expect(searched).toEqual([])
  })

  it('refuses a scheme showing more columns than a table draws, before any row is read', async () => {
    const wide = Array.from({ length: 31 }, (_, index) => ({ relatedMetaAttr: `attr_${String(index)}` }))
    const { run, searched } = await bench('allowed-once', { describeScheme: () => ({ columns: wide }) })
    expect(refusal(await run({ id: 'layers', title: '图层', spec: DEFAULT_COLUMN_SPEC, dataSource: SOURCE })))
      .toBe('show_component: the default query scheme of "SpaceLayer" shows 31 columns and a table draws at most 30. '
        + 'Send tableConfig.gridItems on that block, naming the attributes to read. Nothing on the panel changed.')
    expect(searched).toEqual([])
  })

  it('says what the backend said where the scheme request itself was refused', async () => {
    const { run, searched } = await bench('allowed-once', { describeScheme: () => ({ kind: 'refused', status: 401 }) })
    expect(refusal(await run({ id: 'layers', title: '图层', spec: DEFAULT_COLUMN_SPEC, dataSource: SOURCE })))
      .toBe('show_component: the data source answered 401 for "SpaceLayer" and no rows were read. '
        + 'Nothing on the panel changed.')
    expect(searched).toEqual([])
  })

  it('judges the rest of the call before it asks anybody or reads any scheme', async () => {
    const { run, asked, schemed } = await bench()
    expect(refusal(await run({ id: 'layers', title: '图'.repeat(41), spec: DEFAULT_COLUMN_SPEC, dataSource: SOURCE })))
      .toContain('title — is 41 characters')
    expect([asked, schemed]).toEqual([[], []])
  })

  it('reads no scheme for a refused question, so nothing of the visitor\'s is spent', async () => {
    const { run, asked, described, schemed, searched } = await bench('rejected')
    expect(refusal(await run({ id: 'layers', title: '图层', spec: DEFAULT_COLUMN_SPEC, dataSource: SOURCE })))
      .toBe('show_component: the data source was not read, so nothing was drawn. Nothing on the panel changed.')
    expect(asked).toHaveLength(1)
    expect([described, schemed, searched]).toEqual([[], [], []])
  })
})

describe('the page a read took and the columns it came back empty for', () => {
  it('reads the page the call named and says which of how many it was', async () => {
    const { run, searched } = await bench()
    const result = await run({
      id: 'layers',
      title: '图层',
      spec: SPEC,
      dataSource: [{ ...SOURCE[0], page: { currentPage: 3, pageSize: 20 } }],
    })
    expect(searched[0]?.page).toEqual({ currentPage: 3, pageSize: 20 })
    expect(text(result)).toContain('. Page 3 of 5.')
  })

  it('names the page it read even where the answer counts fewer rows than it sent', async () => {
    const { run } = await bench('allowed-once', { search: () => ({ rawValue: RAW, displayValue: DISPLAY, total: 0 }) })
    expect(text(await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE })))
      .toContain('Read 2 of 0 matching rows from "SpaceLayer" into block "rows", '
        + 'for the attributes zh_label, layer_id, belong_map_topic. Page 1 of 1.')
  })

  it('says which page it read where the backend counted no rows at all', async () => {
    const { run } = await bench('allowed-once', { search: () => ({ rawValue: RAW, displayValue: DISPLAY }) })
    expect(text(await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE })))
      .toContain('for the attributes zh_label, layer_id, belong_map_topic. Page 1.')
  })

  it('names the attributes no row that arrived carried a value for', async () => {
    // The failure this line exists for: a table drawn with three columns of
    // which one has a value, while the model tells the user it has three.
    const sparse = [{ zh_label: '东风站', layer_id: '' }, { zh_label: '配送车-离线', layer_id: '' }]
    const { run } = await bench('allowed-once', { search: () => ({ rawValue: sparse, displayValue: sparse, total: 2 }) })
    expect(text(await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE })))
      .toContain(' No value in any read row: layer_id, belong_map_topic.')
  })

  it('says nothing extra where every attribute had a value somewhere', async () => {
    const { run } = await bench()
    expect(text(await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE })))
      .not.toContain('No value in any read row')
  })
})

describe('what the column reads out of the log', () => {
  it('folds the recorded read into the entry the user sees', async () => {
    const { run, session } = await bench()
    await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE })
    const [event] = resolvedEvents(session)
    const extractor = componentExtractor()
    expect(extractor.dataVersion).toBe(2)
    const read = extractor.read(event as SessionEvent)
    expect(read?.entryId).toBe('layers')
    expect(read?.data.title).toBe('图层')
  })

  it('reads nothing at all out of the tool call that started it', async () => {
    // The rows are not in those arguments — every filled block is missing the
    // rows it is required to carry — so the call records no entry and the read
    // records the only one. Two entries for one call is what this rules out.
    const call = {
      type: 'tool/call' as const,
      seq: 0,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        callId: ToolCallId('call-x'),
        name: SHOW_COMPONENT_TOOL_NAME,
        arguments: JSON.stringify({ id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE }),
      },
    } as unknown as SessionEvent
    expect(readComponentEvent(call)).toMatchObject({ id: 'layers', title: '图层', spec: SPEC })
    expect(componentExtractor().read(call)).toBeUndefined()
  })

  it('lets a later read on the same entry id replace the earlier one', async () => {
    const { run, session } = await bench()
    await run({ id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE })
    await run({ id: 'layers', title: '图层（新）', spec: SPEC, dataSource: SOURCE })
    const reads = resolvedEvents(session).map(event => componentExtractor().read(event as SessionEvent))
    expect(reads.map(read => read?.entryId)).toEqual(['layers', 'layers'])
    expect(reads.map(read => read?.data.title)).toEqual(['图层', '图层（新）'])
  })
})
