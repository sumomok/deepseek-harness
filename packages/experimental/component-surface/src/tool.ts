/**
 * `show_component` — the agent puts a block of interface in the panel beside
 * the conversation.
 *
 * One tool for every component the deployment offers, rather than one tool per
 * component: which blocks exist is a deployment's catalog, and a catalog is
 * cheaper to state once inside a description than to spread across a growing
 * tool list the model has to read on every request.
 *
 * Execution does nothing but judge the call. The record the column folds is the
 * `tool/call` the loop already writes, so the entry a call produces is
 * reconstructable from the log alone and a refusal leaves the column exactly as
 * it was.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  BINDING_KEY,
  catalogLabels,
  COMPONENT_CATALOG,
  describeCatalog,
  MAX_ENTRY_ID_LENGTH,
  MAX_FLEX,
  MAX_LAYOUT_DEPTH,
  MAX_NODES,
  MAX_SPEC_BYTES,
  MAX_TITLE_LENGTH,
  SHOW_COMPONENT_TOOL_NAME,
  TOKEN_HINT,
} from './component-call.ts'
import { validateComponentCall } from './validate.ts'

/** The canonical outcome declared by the `show_component` output schema. */
export interface ShowComponentValue {
  /** The entry the call now owns in the panel. */
  entryId: string
  /** The model-facing result line. */
  text: string
}

/**
 * Build the model-facing description of the offer.
 *
 * The catalog is spliced in rather than summarized, so a model that has never
 * placed a block knows the whole choice — which components exist, which
 * properties each one takes, and which of them answer back — from the tool list
 * alone and needs no system-prompt section of its own. Which components answer
 * back matters on its own line, because a model told a block reports what the
 * user did would otherwise place a display-only one and wait for an answer that
 * is not coming.
 *
 * The arrangement and the bindings are one short paragraph each, because both
 * are the same offer stated once: what a stack holds, and what one block may
 * read from another. Which values can be read is not in the paragraph — it is
 * the `outputs:` line of the component that reports them, beside the properties
 * that accept them.
 * @returns the complete description.
 */
export function describeShowComponent(): string {
  return 'Put a block of interface in the content panel beside the conversation — the area the user sees '
    + 'without opening or scrolling anything. Use it to place a choice or a summary in front of the user '
    + 'while you talk about it.\n\nComponents:\n'
    + describeCatalog(COMPONENT_CATALOG)
    + '\n\nEach call owns the entry its `id` names: calling again with the same id replaces what that entry '
    + 'shows, and a new id adds a second entry beside it. When the user asks to change something already on '
    + 'display, reuse that entry\'s id.\n\n'
    + `A call places between 1 and ${MAX_NODES} blocks, and \`spec\` is at most ${MAX_SPEC_BYTES} bytes of JSON. `
    + 'A block carries the properties listed under its component and no others — a `props:` line names each one, '
    + 'marks the ones a call may leave out with `?`, writes a list as `[what one item is] (fewest–most)`, and '
    + 'writes an object you choose the field names of as `{<field>: text|number|boolean}`. Anything else is '
    + 'refused, and the refusal names what you sent and lists the properties that component accepts.\n\n'
    + 'By default the blocks are stacked top to bottom. To arrange them, send `layout`: '
    + '{"node": "stack", "dir": "row" or "col", "gap"?: "sm"|"md"|"lg", "wrap"?: true|false, "children": [...]}, '
    + 'whose children are either a further stack or {"node": "component", "id": "<one of your node ids>"}. '
    + `A child of either kind may carry "flex": 1–${MAX_FLEX}, the share of its row or column it takes. `
    + `A layout places every node exactly once, and stacks nest at most ${MAX_LAYOUT_DEPTH} deep.\n\n`
    + 'A block can also read what another block of the same call reports. Where a component has an `outputs:` line, '
    + `write {"${BINDING_KEY}": "node:<the other block\'s id>.<output name>"} — with [index] after it to take one `
    + 'item — as the whole value of a property that accepts what that output is, and that property then follows what '
    + 'the user does, with no further call from you. Until there is something to read, the block says it is waiting.\n\n'
    + 'What the user does inside a block comes back to you, naming the entry and the block it happened in, '
    + 'unless the list above says nothing comes back from that component. Do not also ask in the conversation '
    + 'for an answer a block is already asking for, and do not place a block that sends nothing back to ask a '
    + 'question with.'
}

/**
 * Build the `show_component` tool.
 * @returns the definition to hand to `ctx.tools.register`.
 */
export function showComponentTool(): ToolDefinition {
  return defineTool({
    name: SHOW_COMPONENT_TOOL_NAME,
    description: describeShowComponent(),
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Stable id of the entry this call owns, at most '
          + `${MAX_ENTRY_ID_LENGTH} ${TOKEN_HINT}, such as "budget-confirm". Reuse it to replace what the entry `
          + 'shows; a new id adds a second entry beside it.',
      },
      title: {
        type: 'string',
        required: true,
        description: `Short phrase naming the entry for the user, at most ${MAX_TITLE_LENGTH} characters. `
          + 'Write it in the language the user is writing in; it is read by the user, not by you.',
      },
      spec: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: 'What to put in the panel.',
        properties: {
          nodes: {
            type: 'array',
            required: true,
            description: 'The blocks to draw, top to bottom. Each entry is '
              + '{"id": "<name unique in this call>", "component": "<id from the list above>", "props": {…}}.',
            items: { type: 'json' },
          },
          layout: {
            type: 'json',
            description: 'How the blocks are arranged, as nested stacks; leave it out to stack them top to bottom.',
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entryId: { type: 'string', required: true, description: 'The entry the call now owns.' },
          text: { type: 'string', required: true, description: 'The result line.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args): Promise<ShowComponentValue> {
      const result = validateComponentCall(args)
      // A refusal changes nothing: the panel keeps showing whatever it showed,
      // and the model gets the offending path back to correct itself.
      if (!result.ok) throw new Error(result.failure.text)
      const text = `Now showing "${result.call.title}" in the content panel: ${catalogLabels(result.call.spec.nodes)}. `
        + `Call show_component with id "${result.call.id}" again to replace it; a different id adds a second entry beside it.`
      return Promise.resolve({ entryId: result.call.id, text })
    },
    presentCall: (args): GenericCallView => ({
      card: 'generic',
      title: `Show ${args.title} in the content panel`,
      kind: 'other',
      rawInput: args.id,
    }),
  })
}
