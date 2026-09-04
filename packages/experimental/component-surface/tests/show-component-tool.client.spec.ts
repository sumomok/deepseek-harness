/**
 * `show_component` against the real tool runtime: the model-visible surface —
 * name, description, parameter schema, and every result line — pinned verbatim,
 * and the two outcomes a call has.
 *
 * The description is pinned rather than sampled because it carries the whole
 * catalog: it is the only place a model learns which components exist, so a
 * component added without its line reaching the description is a component no
 * model will ever place.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { SHOW_COMPONENT_TOOL_NAME } from '../src/component-call.ts'
import { describeShowComponent, showComponentTool } from '../src/tool.ts'

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
  const definition = showComponentTool()
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
    expect(definition.description).toBe(
      'Put a block of interface in the content panel beside the conversation — the area the user sees '
      + 'without opening or scrolling anything. Use it to place a choice or a summary in front of the user '
      + 'while you talk about it.\n\nComponents:\n'
      + '- el.confirm-bar — 确认条 — A short prompt above a row of buttons, for putting one decision in front of the user.'
      + '\n\nEach call owns the entry its `id` names: calling again with the same id replaces what that entry '
      + 'shows, and a new id adds a second entry beside it. When the user asks to change something already on '
      + 'display, reuse that entry\'s id.\n\n'
      + 'A call places between 1 and 8 blocks, and `spec` is at most 65536 bytes of JSON. '
      + 'Each block carries only the properties its component declares above; anything else is refused, and the '
      + 'refusal names the property.\n\n'
      + 'The block is display only: what the user does with it does not come back to you. Ask for an answer in '
      + 'the conversation rather than waiting for one from the block.',
    )
    expect(describeShowComponent()).toBe(definition.description)
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
      spec: { nodes: [{ id: 'bar', component: 'toy.table', props: {} }] },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('show_component: spec.nodes[0].component — names no component of this deployment')
    expect(text(result)).toContain('- el.confirm-bar — 确认条 —')
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
