/**
 * `show_component` against the real tool runtime: the model-visible surface —
 * name, description, parameter schema, and every result line — pinned verbatim,
 * and the two outcomes a call has.
 *
 * The description is pinned rather than sampled because it carries the whole
 * catalog: it is the only place a model learns which components exist and which
 * properties each one takes, so a component added without its lines reaching the
 * description is a component no model will ever place, and a property missing
 * from them is one no model will ever send.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { COMPONENT_CATALOG, describeCatalog, SHOW_COMPONENT_TOOL_NAME } from '../src/component-call.ts'
import { describeShowComponent, showComponentTool, type ShowComponentOptions } from '../src/tool.ts'

/** The offer of a deployment that composed no data backend, which is what this suite pins. */
const PLAIN: ShowComponentOptions = { dataSource: false, defaultPageSize: 200 }

let calls = 0

/** One booted deployment: the registered definition, and a runner over the real registry. */
interface Bench {
  definition: ToolDefinition
  run: (args: Record<string, unknown>) => Promise<ToolExecutionResult>
}

/** Boot the tool over a real tool registry. */
async function bench(): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const definition = showComponentTool(ctx, PLAIN)
  ctx.tools.register(definition)
  return {
    definition,
    run: args => ctx.tools.execute({
      callId: `call-${++calls}` as ToolExecutionInput['callId'],
      name: SHOW_COMPONENT_TOOL_NAME,
      arguments: args,
      signal: new AbortController().signal,
    }),
  }
}

/** The model-facing text of one settled execution. */
function text(result: ToolExecutionResult): string {
  return result.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

/** One accepted confirmation-bar spec. */
const SPEC = { nodes: [{ id: 'bar', component: 'el.confirm-bar', props: { title: '本月预算', buttons: [{ id: 'ok', label: '确认', tone: 'primary' }] } }] }

describe('show_component model-visible surface', () => {
  it('offers one tool whose description carries the whole catalog', async () => {
    const { definition } = await bench()
    expect(definition.name).toBe('show_component')
    // The catalog lines themselves are pinned verbatim where they are built, in
    // `component-call.client.spec.ts`; what this file owns is the frame around
    // them and the fact that the whole catalog goes inside it.
    expect(definition.description).toBe(
      'Put a block of interface in the content panel beside the conversation — the area the user sees '
      + 'without opening or scrolling anything. Use it to place a choice or a summary in front of the user '
      + 'while you talk about it.\n\nComponents:\n'
      + describeCatalog(COMPONENT_CATALOG)
      + '\n\nEach call owns the entry its `id` names: calling again with the same id replaces what that entry '
      + 'shows, and a new id adds a second entry beside it. When the user asks to change something already on '
      + 'display, reuse that entry\'s id.\n\n'
      + 'A call places between 1 and 12 blocks, and `spec` is at most 65536 bytes of JSON. '
      + 'A block carries the properties listed under its component and no others — a `props:` line names each one, '
      + 'marks the ones a call may leave out with `?`, writes a list as `[what one item is] (fewest–most)`, and '
      + 'writes an object you choose the field names of as `{<field>: text|number|boolean}`. Anything else is '
      + 'refused, and the refusal names what you sent and lists the properties that component accepts.\n\n'
      + 'By default the blocks are stacked top to bottom. To arrange them, send `layout`: '
      + '{"node": "stack", "dir": "row" or "col", "gap"?: "sm"|"md"|"lg", "wrap"?: true|false, "children": [...]}, '
      + 'whose children are either a further stack or {"node": "component", "id": "<one of your node ids>"}. '
      + 'A child of either kind may carry "flex": 1–12, the share of its row or column it takes. '
      + 'A layout places every node exactly once, and stacks nest at most 4 deep.\n\n'
      + 'A block can also read what another block of the same call reports. Where a component has an `outputs:` line, '
      + 'write {"$from": "node:<the other block\'s id>.<output name>"} — with [index] after it to take one '
      + 'item — as the whole value of a property that accepts what that output is, and that property then follows what '
      + 'the user does, with no further call from you. Until there is something to read, the block says it is waiting.\n\n'
      + 'What the user does inside a block comes back to you, naming the entry and the block it happened in, '
      + 'unless the list above says nothing comes back from that component. Do not also ask in the conversation '
      + 'for an answer a block is already asking for, and do not place a block that sends nothing back to ask a '
      + 'question with.',
    )
    expect(describeShowComponent(PLAIN)).toBe(definition.description)
    expect(definition.description).toContain('- toy.table — 数据表 —')
    expect(definition.description).toContain('- el.filter-bar — 筛选条件 —')
    expect(definition.description).toContain('- el.metric — 指标球 — ')
  })

  it('requires an id, a title, and a spec carrying nodes', async () => {
    const { definition } = await bench()
    expect(definition.parameters).toEqual({
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Stable id of the entry this call owns, at most 64 letters, digits, underscores and hyphens, '
            + 'such as '
            + '"budget-confirm". Reuse it to replace what the entry shows; a new id adds a second '
            + 'entry beside it.',
        },
        title: {
          type: 'string',
          description: 'Short phrase naming the entry for the user, at most 24 characters. '
            + 'Write it in the language the user is writing in; it is read by the user, not by you.',
        },
        spec: {
          type: 'object',
          additionalProperties: false,
          description: 'What to put in the panel.',
          properties: {
            nodes: {
              type: 'array',
              description: 'The blocks to draw, top to bottom. Each entry is '
                + '{"id": "<name unique in this call>", "component": "<id from the list above>", "props": {…}}.',
              items: {},
            },
            layout: {
              description: 'How the blocks are arranged, as nested stacks; leave it out to stack them top to bottom.',
            },
          },
          required: ['nodes'],
        },
      },
      required: ['id', 'title', 'spec'],
    })
  })

  it('titles the call card with what the user will read', async () => {
    const { definition } = await bench()
    expect(definition.presentCall?.({ id: 'budget', title: '预算确认', spec: SPEC })).toEqual({
      card: 'generic',
      title: 'Show 预算确认 in the content panel',
      kind: 'other',
      rawInput: 'budget',
    })
  })
})

describe('one show_component call', () => {
  it('answers with the entry it now owns and how to replace it', async () => {
    const { run } = await bench()
    const result = await run({ id: 'budget', title: '预算确认', spec: SPEC })
    expect(result.isError).toBeFalsy()
    expect(text(result)).toBe(
      'Now showing "预算确认" in the content panel: 确认条. '
      + 'Call show_component with id "budget" again to replace it; a different id adds a second entry beside it.',
    )
  })

  it('answers a second call on the same id the same way, because that call replaces the first', async () => {
    const { run } = await bench()
    await run({ id: 'budget', title: '预算确认', spec: SPEC })
    // Nothing here tracks the first call: the entry the two share is derived
    // from the log by the content-surface extractor, and the tool is stateless.
    expect(text(await run({ id: 'budget', title: '预算再确认', spec: SPEC }))).toBe(
      'Now showing "预算再确认" in the content panel: 确认条. '
      + 'Call show_component with id "budget" again to replace it; a different id adds a second entry beside it.',
    )
  })

  it('names every block it placed, in the wording the user reads', async () => {
    const { run } = await bench()
    const two = { nodes: [...SPEC.nodes, { id: 'bar2', component: 'el.confirm-bar', props: { buttons: [{ id: 'no', label: '取消' }] } }] }
    expect(text(await run({ id: 'budget', title: '预算确认', spec: two }))).toContain('the content panel: 确认条、确认条.')
  })

  it('denies a call naming a component this deployment does not have, and hands back the catalog', async () => {
    const { run } = await bench()
    const result = await run({
      id: 'budget',
      title: '预算确认',
      spec: { nodes: [{ id: 'bar', component: 'toy.chart', props: {} }] },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('show_component: spec.nodes[0].component — names no component of this deployment')
    expect(text(result)).toContain('- el.confirm-bar — 确认条 —')
    expect(text(result)).toContain('- toy.record — 记录详情 —')
    // The properties come back with the list, so the corrected call needs no
    // second refusal to learn what the component it picks instead accepts.
    expect(text(result)).toContain('props: dataList[{label, display}] (1–60), labelWidth? (40–240), columnNum? (1|2|3)')
  })

  it('places a record detail, and answers naming it the way the user reads it', async () => {
    const { run } = await bench()
    const result = await run({
      id: 'device',
      title: '设备详情',
      spec: { nodes: [{ id: 'detail', component: 'toy.record', props: { dataList: [{ label: '编号', display: 'A-1' }], columnNum: 2 } }] },
    })
    expect(result.isError).toBeFalsy()
    expect(text(result)).toContain('the content panel: 记录详情.')
  })

  it('places a filter bar, a table and a metric ball in one call, naming each the way the user reads it', async () => {
    const { run } = await bench()
    const result = await run({
      id: 'devices',
      title: '设备列表',
      spec: {
        nodes: [
          { id: 'filter', component: 'el.filter-bar', props: { relatedMeta: 'device', metaConfig: { attributes: [{ attributeEnName: 'zh_label', alias: '名称' }] } } },
          { id: 'table', component: 'toy.table', props: { tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label', alias: '名称' }] }, displayValueList: [{ zh_label: 'A-1' }] } },
          { id: 'rate', component: 'el.metric', props: { process: 72, text: '在用率' } },
        ],
      },
    })
    expect(result.isError).toBeFalsy()
    expect(text(result)).toContain('the content panel: 筛选条件、数据表、指标球.')
  })

  it('denies a record detail carrying a formatter, and names the parameter to drop', async () => {
    const { run } = await bench()
    const result = await run({
      id: 'device',
      title: '设备详情',
      spec: {
        nodes: [{
          id: 'detail',
          component: 'toy.record',
          props: { dataList: [{ label: '编号', display: 'A-1' }], formatter: 'function(row){ return row.name }' },
        }],
      },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(
      'Error: show_component: spec.nodes[0].props.formatter — is not accepted here. '
      + 'Accepted properties: dataList, labelWidth, columnNum.',
    )
  })

  it('denies a call whose block carries a property the component does not declare', async () => {
    const { run } = await bench()
    const result = await run({
      id: 'budget',
      title: '预算确认',
      spec: { nodes: [{ id: 'bar', component: 'el.confirm-bar', props: { onClick: 'function(){}' , buttons: [{ id: 'ok', label: '确认' }] } }] },
    })
    expect(result.isError).toBe(true)
    // The property schema cannot express a function at all, so the refusal is a
    // schema refusal rather than a sanitizer's — there is nothing to sanitize.
    expect(text(result)).toContain('show_component: spec.nodes[0].props.onClick — is not accepted here.')
  })

  it('rejects a call with no spec before the tool body runs', async () => {
    const { run } = await bench()
    const result = await run({ id: 'budget', title: '预算确认' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('spec')
  })
})
