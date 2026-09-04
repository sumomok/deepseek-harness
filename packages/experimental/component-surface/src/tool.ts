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
  COMPONENT_CATALOG,
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
 * placed a block knows the whole choice — which components exist, which
 * properties each one takes, and which of them answer back — from the tool list
 * alone and needs no system-prompt section of its own. Which components answer
 * back matters on its own line, because a model told a block reports what the
 * user did would otherwise place a display-only one and wait for an answer that
 * is not coming.
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
    + 'marks the ones a call may leave out with `?`, and writes a list as `[{item properties}]`. Anything else is '
    + 'refused, and the refusal names what you sent and lists the properties that component accepts.\n\n'
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
