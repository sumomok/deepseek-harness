// @vitest-environment jsdom
/**
 * The gate on the rule
 * [the self-contained-copy Agent Note](../../../../.agents/notes/implemented/feature/2026-09-04-self-contained-tool-copy.md)
 * records: no tool description, parameter description, refusal, result hint or
 * output-schema field description of this package names a tool of this package
 * — not a sibling, and not the tool that produced it. The request-context lines
 * in `src/perception/text.ts` are outside the rule and outside this walk; the
 * Note's "Where the rules do not reach"
 * [section](../../../../.agents/notes/implemented/feature/2026-09-04-self-contained-tool-copy.md#where-the-rules-do-not-reach)
 * owns them.
 *
 * This spec walks three surfaces. It reads the three text modules' whole export
 * surface rather than a list of strings, so a constant or a sentence added
 * later is covered the day it is written: an exported function with no
 * arguments recorded here fails, and so does an export that is neither a string
 * nor a function. `switch-text.ts` is walked with them although a person rather
 * than a model reads it: a tool name has no place in either audience's copy. It assembles all seven tool definitions and reads every
 * `description` each one carries — its own, its parameter schema's at any
 * depth, and its output schema's — which is what covers the descriptions
 * composed in `tool.ts`, `read-tool.ts`, `markup-tool.ts`, `image-tool.ts`,
 * `act-tool.ts` and `read-value.ts` rather than exported as sentences. And the
 * map listing's closing line is checked through a real read, because
 * `render.ts` composes it privately and the rendered listing is where the model
 * meets it.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import * as actText from '../src/access/act-text.ts'
import * as switchText from '../src/access/switch-text.ts'
import * as readText from '../src/access/text.ts'
import { contentActTool } from '../src/access/act-tool.ts'
import { DialogApprovals } from '../src/access/dialog-approvals.ts'
import { contentReadImageTool } from '../src/access/image-tool.ts'
import type { ModelRouteServices } from '../src/access/model-switch.ts'
import {
  contentReadAttrsTool, contentReadDomContentTool, contentReadDomTool,
} from '../src/access/markup-tool.ts'
import { PendingCalls, type CallTimeouts } from '../src/access/pending.ts'
import { contentReadTool } from '../src/access/read-tool.ts'
import type { FrontEntryLookup, ReadWait } from '../src/access/read-value.ts'
import { indexPages } from '../src/pages.ts'
import { CONTENT_SHOW_TOOL_NAME, contentShowTool } from '../src/tool.ts'
import type { ContentPage } from '../src/types.ts'
import {
  CONTENT_ACT_TOOL_NAME, CONTENT_READ_ATTRS_TOOL_NAME, CONTENT_READ_DOM_CONTENT_TOOL_NAME,
  CONTENT_READ_DOM_TOOL_NAME, CONTENT_READ_IMAGE_TOOL_NAME, CONTENT_READ_TOOL_NAME, MAX_EXPORT_BYTES,
  type ActStep, type ActStepRefusal, type ReadFailure,
} from '../src/access/wire.ts'
import { RefTable } from '../src/client/access/refs.ts'
import { snapshot } from '../src/client/access/snapshot.ts'

/** Every tool this package registers, by the name the model calls it. */
const TOOL_NAMES = [
  CONTENT_READ_TOOL_NAME,
  CONTENT_READ_DOM_TOOL_NAME,
  CONTENT_READ_ATTRS_TOOL_NAME,
  CONTENT_READ_DOM_CONTENT_TOOL_NAME,
  CONTENT_READ_IMAGE_TOOL_NAME,
  CONTENT_ACT_TOOL_NAME,
  CONTENT_SHOW_TOOL_NAME,
]

/** One step both the approval request and the answer are composed from. */
const CLICK: ActStep = { action: 'click', ref: 'e5', label: '查询' }

/** Every failure the seat can post, so each arm of the shared refusal is read. */
const FAILURES: ReadFailure[] = [
  { status: 'error', code: 'empty', message: 'the content column is empty' },
  { status: 'error', code: 'not-a-page', message: 'the entry in front is not a page', kind: 'chart', title: '黄金' },
  { status: 'error', code: 'engine', message: 'scope: "e12" names no element on the page now' },
  { status: 'error', code: 'frame', message: readText.FRAME_LOADING_MESSAGE },
  { status: 'error', code: 'front-changed', message: actText.frontChangedRefusal('报表', '点位信息') },
]

/** Every field one step can be refused over, keyed the way the wire names it. */
const STEP_REFUSALS: ActStepRefusal[] = [
  'action', 'ref', 'label', 'mark', 'mark-printed', 'mark-on-named', 'fill-text', 'wait-text', 'value',
  'key', 'label-length', 'text-length', 'value-length', 'key-length', 'mark-length',
]

/**
 * The arguments each exported text function is read with. Every function of the
 * two modules has an entry; one it does not have fails the walk, which is what
 * keeps a sentence added later from reaching the model unchecked.
 */
const ARGUMENTS: Record<string, readonly unknown[][]> = {
  unclaimedRefusal: [[3000, undefined], [3000, { entryId: 'home', kind: 'page', title: '点位信息' }]],
  unansweredRefusal: [[15000]],
  notAPageRefusal: [[{}], [{ kind: 'chart', title: '黄金走势' }]],
  stillLoadingLine: [[['表格', '侧栏']]],
  failureRefusal: FAILURES.map(failure => [failure]),
  readHeaderText: [[{
    page: 'Home', url: '/home', title: '站点管理', modal: '编辑设备',
    kind: 'map', truncated: true, total: 40, settled: false, busy: ['表格'],
  }]],
  wideAttrsMessage: [[9000, 'e12', 4000]],
  wideTextMessage: [[9000, 'e12', 4000]],
  markupHeaderText: [[{ page: 'Home', url: '/home', settled: false }]],
  noImageRouteRefusal: [['deepseek-v4-flash']],
  noImageAnywhereRefusal: [['deepseek-v4-flash']],
  routeSwitchRefusal: [['session/model-unavailable: no adapter registered for provider "none"']],
  routeLabel: [['DeepSeek', 'DeepSeek-V4-Flash-Vision-Exp']],
  distinctRouteLabel: [['DeepSeek：DeepSeek-V4-Flash-Vision-Exp', 'deepseek-v4-flash-vision-exp']],
  notAnImageRefusal: [['e12', 'div']],
  hiddenImageRefusal: [['e12']],
  unloadedImageRefusal: [['e12']],
  emptyImageRefusal: [['e12']],
  taintedImageRefusal: [['e12']],
  slowImageRefusal: [['e12', 1875]],
  wideImageRefusal: [['e12', 3_500_000, MAX_EXPORT_BYTES]],
  unexportableImageRefusal: [['e12', 'image/avif']],
  imageStoreRefusal: [['Image batch exceeds the configured image-count limit.']],
  imageHeaderText: [[{
    ref: 'e12',
    tag: 'img',
    natural: { width: 240, height: 240 },
    exported: { width: 240, height: 240 },
    mediaType: 'image/png',
    bytes: 3182,
  }]],
  stepRefusalText: STEP_REFUSALS.map(refusal => [refusal]),
  tooManyStepsRefusal: [[20]],
  stepRefusal: [[2, 'a "fill" step needs text, the value to type into the box']],
  unverifiedRefusal: [[60000]],
  approvalReason: [
    [{ steps: [CLICK] }],
    [{ steps: [{ action: 'fill', ref: 'e4', label: '', mark: 'el-input__inner', text: '东风' }], dialogs: 'accept' }],
  ],
  stepClause: [[CLICK, false], [{ action: 'fill', ref: 'e4', label: '名称', text: '东风' }, true]],
  ranSummary: [[0], [1], [3]],
  refGoneReason: [['e3']],
  hiddenReason: [['e3']],
  frontChangedRefusal: [['报表', '点位信息']],
  labelChangedReason: [['e5', '重置', '查询']],
  markChangedReason: [['e5', 'op op-b', 'op op-a']],
  occludedReason: [['e7', '编辑设备']],
  disabledReason: [['e4', '保存']],
  noOptionReason: [['e6', '东风']],
  outOfTimeReason: [[3]],
  waitedReason: [['保存成功', 5000]],
  cannotActReason: [['e2', 'fill']],
  dialogLine: [['confirm', '确定删除？', 'cancel']],
  navigationLine: [['/ini-web2/#/detail/8812']],
  windowLine: [['/ini-web2/#/detail/8812']],
  tooLongRefusal: [['key', 32]],
  actReportText: [[{
    page: 'Home',
    steps: [CLICK],
    results: [{ index: 1, status: 'failed', message: actText.refGoneReason('e5') }],
    redacted: [false],
    settledMs: 400,
    events: [{ kind: 'dialog', line: actText.dialogLine('confirm', '确定删除？', 'cancel') }],
    snapshot: 'e1 main "站点管理"',
  }]],
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
    if (typeof value !== 'function') throw new Error(`${name}.${key} is neither a sentence nor a way to compose one`)
    const args = ARGUMENTS[key]
    if (args === undefined) throw new Error(`${name}.${key} has no arguments recorded in this gate`)
    return args.map(one => (value as (...rest: unknown[]) => string)(...one))
  })
}

/** The deployment the `content_show` description is assembled over. */
const PAGES: ContentPage[] = [
  { id: 'dashboard', title: 'Fleet dashboard', description: 'Live status of every machine in the fleet.', url: '/content-app/' },
  { id: 'reports', title: 'Weekly reports', description: 'Published reports, newest first.', url: '/content-app/reports/' },
]

/** Deadlines the assembly carries into its refusals; nothing here waits on them. */
const TIMEOUTS: CallTimeouts = { claimTimeoutMs: 30, answerTimeoutMs: 60, pinMs: 5000 }

/** The steps bound the assembled `content_act` is built under. */
const MAX_STEPS = 20

/** A composition with no LLM registry; nothing here resolves a route. */
const NO_ROUTES: ModelRouteServices = { get: () => undefined }

/**
 * The seven tools a deployment registers, assembled the way it assembles them.
 *
 * Descriptions composed at assembly rather than exported as sentences — the
 * page catalogue `content_show` carries, the parameter lines the five reads and
 * `content_act` declare inline, the output-schema fields all seven declare —
 * reach the model only through these objects, which is why the walk builds them
 * instead of reading the modules' exports.
 * @returns the definitions, in the order a composition registers them.
 */
function toolDefinitions(): ToolDefinition[] {
  const pending = new PendingCalls()
  const front: FrontEntryLookup = () => undefined
  const wait: ReadWait = { pending, timeouts: TIMEOUTS, front }
  return [
    contentShowTool(indexPages(PAGES, undefined)),
    contentReadTool(pending, TIMEOUTS, front),
    contentReadDomTool(wait),
    contentReadAttrsTool(wait),
    contentReadDomContentTool(wait),
    contentReadImageTool(wait, NO_ROUTES),
    contentActTool(pending, TIMEOUTS, MAX_STEPS, front, new DialogApprovals()),
  ]
}

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

/** The one page the map listing is read off, small enough to skeletonize under a low budget. */
const PAGE = `
<main aria-label="站点管理">
  <nav><span>首页</span><span>站点管理</span></nav>
  <form aria-label="查询">
    <input type="text" aria-label="名称" value="东风">
    <select aria-label="状态"><option>启用</option></select>
    <button>查询</button>
  </form>
  <section aria-label="列表"><p>共 20 个站点。</p><button>导出</button><button>导入</button></section>
</main>`

describe('every sentence this package puts in front of the model', () => {
  it('names no tool of this package, in any of the three text modules', () => {
    const sentences = [
      ...sentencesOf(readText, 'text.ts'),
      ...sentencesOf(actText, 'act-text.ts'),
      ...sentencesOf(switchText, 'switch-text.ts'),
    ]
    // The walk is worthless if it found nothing to walk.
    expect(sentences.length).toBeGreaterThan(60)
    expect(sentences.filter(sentence => TOOL_NAMES.some(tool => sentence.includes(tool)))).toEqual([])
  })

  it('names no tool in any description of the seven tools the model is offered', () => {
    const tools = toolDefinitions()
    const descriptions = tools.flatMap(tool => [
      tool.description,
      ...descriptionsIn(tool.parameters),
      ...descriptionsIn(tool.output.schema),
    ])
    // The walk is worthless if a tool went missing or a schema read as empty.
    expect([...tools.map(tool => tool.name)].sort()).toEqual([...TOOL_NAMES].sort())
    expect(descriptions.length).toBeGreaterThan(60)
    expect(descriptions.filter(one => TOOL_NAMES.some(tool => one.includes(tool)))).toEqual([])
  })

  it('names no tool in the listing a read answers with, closing line included', () => {
    document.body.innerHTML = PAGE
    const listing = snapshot(document, { refs: new RefTable(), budgetChars: 200, isVisible: () => true })
    // The map is the one listing that closes with a line telling the model
    // where to read next, which is the line that named a tool.
    expect(listing.kind).toBe('map')
    expect(listing.text).toContain('Read a part with scope')
    expect(TOOL_NAMES.filter(tool => listing.text.includes(tool))).toEqual([])
  })
})
