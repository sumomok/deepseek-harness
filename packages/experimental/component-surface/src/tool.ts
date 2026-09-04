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
  catalogLabels,
  describeCatalog,
  MAX_ENTRY_ID_LENGTH,
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
 * placed a block knows the whole choice from the tool list alone and needs no
 * system-prompt section of its own.
 * @returns the complete description.
 */
export function describeShowComponent(): string {
  return 'Put a block of interface in the content panel beside the conversation — the area the user sees '
    + 'without opening or scrolling anything. Use it to place a choice or a summary in front of the user '
    + 'while you talk about it.\n\nComponents:\n'
    + describeCatalog()
    + '\n\nEach call owns the entry its `id` names: calling again with the same id replaces what that entry '
    + 'shows, and a new id adds a second entry beside it. When the user asks to change something already on '
    + 'display, reuse that entry\'s id.\n\n'
    + `A call places between 1 and ${MAX_NODES} blocks, and \`spec\` is at most ${MAX_SPEC_BYTES} bytes of JSON. `
    + 'Each block carries only the properties its component declares above; anything else is refused, and the '
    + 'refusal names the property.\n\n'
    + 'The block is display only: what the user does with it does not come back to you. Ask for an answer in '
    + 'the conversation rather than waiting for one from the block.'
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
