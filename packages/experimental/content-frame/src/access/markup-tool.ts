/**
 * The three reads of the page as it was written: `content_read_dom` prints one
 * subtree's markup, `content_read_attrs` one element's attributes, and
 * `content_read_dom_content` one element's whole text.
 *
 * None of them makes anything of a page. Each registers a wait on the channel
 * `content_read` already uses, a browser seat showing this session claims it and
 * reads the frame's own document, and what comes back is printed as it stands —
 * a class token, an attribute value and a run of text reach the model as the
 * page spelled them. What any of it means is a skill's to know, and this
 * package never guesses. That division is the whole reason the three exist
 * beside `content_read`: the listing answers what HTML and ARIA say the page is,
 * and these answer what it is written as, for the rows the listing can name
 * nothing.
 *
 * They share one output schema, one reading of the settlement and one pair of
 * presenters, because they differ in what the seat walks and in nothing this
 * side does.
 * @module @deepseek-ai/dsh-experimental-content-frame/access/markup-tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, GenericResultView, ToolDefinition, ToolResult } from '@deepseek-ai/dsh-tools'
import {
  CONTENT_READ_ATTRS_DESCRIPTION, CONTENT_READ_DOM_CONTENT_DESCRIPTION, CONTENT_READ_DOM_DESCRIPTION,
  DOM_AFTER_DESCRIPTION, DOM_AFTER_REFUSAL, DOM_SCOPE_DESCRIPTION, DOM_SCOPE_REFUSAL,
  ELEMENT_REF_DESCRIPTION, ELEMENT_REF_REFUSAL, failureRefusal, markupHeaderText, MISREPORTED_REFUSAL,
} from './text.ts'
import { awaitRead, PAGE_VALUE_SCHEMA, pathOf, readBody, type ReadWait } from './read-value.ts'
import {
  CONTENT_READ_ATTRS_TOOL_NAME, CONTENT_READ_DOM_CONTENT_TOOL_NAME, CONTENT_READ_DOM_TOOL_NAME, REF_PATTERN,
  type ReadKind, type ReadOutcome,
} from './wire.ts'

/** Which of the three markup reads a call is; the kind its answer must come back under. */
type MarkupKind = Extract<ReadKind, 'dom' | 'attrs' | 'content'>

/** Title of the element tree's call card, in the pending and the settled state alike. */
const DOM_CALL_TITLE = 'Read the markup of the page in the content column'

/** Title of the attribute read's call card. */
const ATTRS_CALL_TITLE = 'Read one element\'s attributes in the content column'

/** Title of the whole-text read's call card. */
const CONTENT_CALL_TITLE = 'Read one element\'s text in the content column'

/** The canonical outcome declared by all three markup reads' output schema. */
export interface ContentMarkupValue {
  /** Discriminant; a read that found no page throws instead of answering. */
  status: 'ok'
  /** The page the column had in front, as the deployment names it. */
  page: { id: string; title: string }
  /** The path the frame is at, origin dropped. */
  url: string
  /** Which of the three reads answered. */
  kind: MarkupKind
  /** The markup, the attributes, or the text. */
  text: string
  /** True when the answer stops short of everything the read would have shown. */
  truncated: boolean
  /** How many rows the answer prints. */
  shown: number
  /** How many rows the answer has in full. */
  total: number
  /** The ref to pass back as `after`; present only on a tree cut short. */
  cursor?: string
  /** False when the page was still changing when the read ran. */
  settled: boolean
}

/**
 * The value all three reads answer with.
 *
 * One schema for three tools, because the three answers differ in what a row is
 * and in nothing a schema can state: a line of markup, an attribute and a line
 * of text are all rows of an answer the model reads whole.
 */
const MARKUP_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['ok'], required: true, description: 'Always "ok"; every other ending rejects.' },
    page: PAGE_VALUE_SCHEMA,
    url: { type: 'string', required: true, description: 'The path inside the application the frame is at.' },
    kind: {
      type: 'string',
      enum: ['dom', 'attrs', 'content'],
      required: true,
      description: 'Which of the three markup reads this answer is.',
    },
    text: { type: 'string', required: true, description: 'The markup, the attributes, or the text.' },
    truncated: { type: 'boolean', required: true, description: 'Whether a cut stopped this answer short.' },
    shown: { type: 'integer', required: true, description: 'How many rows this answer prints.' },
    total: { type: 'integer', required: true, description: 'How many rows the whole answer has.' },
    cursor: { type: 'string', description: 'Pass as `after`, with the same scope, to continue a cut tree.' },
    settled: { type: 'boolean', required: true, description: 'Whether the page had stopped changing when it was read.' },
  },
} as const

/**
 * Turn one posted outcome into a markup read's answer.
 * @param outcome - what the claiming seat reported.
 * @param kind - which of the three reads asked, which is the kind its answer comes back under.
 * @returns the canonical value.
 * @throws {Error} for every outcome that is not this read's own answer.
 */
function markupValue(outcome: ReadOutcome, kind: MarkupKind): ContentMarkupValue {
  if (outcome.status === 'error') throw new Error(failureRefusal(outcome))
  const { snapshot } = outcome
  // One channel carries five tools' answers, so a document arriving under
  // another read's kind answers a call this one did not make.
  if (snapshot.kind !== kind) throw new Error(MISREPORTED_REFUSAL)
  return { status: 'ok', page: outcome.page, url: pathOf(snapshot.url), kind, ...readBody(snapshot) }
}

/**
 * The model-facing block one markup read answers with. The block type is spelled
 * structurally rather than imported: this package depends on the tool runtime,
 * not on the LLM vocabulary the runtime's own content type belongs to.
 * @param _args - the call's arguments, which the body does not repeat.
 * @param value - the canonical value.
 * @returns the one text block.
 */
function renderMarkup(_args: unknown, value: ContentMarkupValue): { type: 'text'; text: string }[] {
  const header = markupHeaderText({ page: value.page.title, url: value.url, settled: value.settled })
  return [{ type: 'text', text: `${header}\n${value.text}` }]
}

/**
 * What the UI keeps beside a settled markup read: the page it looked at. The
 * body itself is written for the model rather than for a reader.
 * @param _args - the call's arguments.
 * @param value - the canonical value.
 * @returns the persisted presentation payload.
 */
function markupMeta(_args: unknown, value: ContentMarkupValue): { page: string } {
  return { page: value.page.title }
}

/**
 * The settled card's title: the first line of what the model was told, which
 * names the page, and the call's own title where the result carries no text.
 * @param result - the final model-facing tool result.
 * @param title - the call card's title, as the fallback.
 * @returns the card.
 */
function markupResultView(result: ToolResult, title: string): GenericResultView {
  return { card: 'generic', title: result.content.find(block => block.type === 'text')?.text.split('\n')[0] ?? title }
}

/** What one of the two single-element reads differs in. */
interface ElementReadSpec {
  /** The tool's wire name. */
  readonly name: string
  /** The description the model chooses it from. */
  readonly description: string
  /** The kind its answer comes back under. */
  readonly kind: Extract<MarkupKind, 'attrs' | 'content'>
  /** The call card's title. */
  readonly title: string
}

/**
 * Build one of the two reads that answer about a single element.
 *
 * Both take one ref and refuse the same way, so what they differ in is what the
 * seat prints for that element — which is the seat's business and not this
 * side's.
 * @param wait - the channel this tool waits on.
 * @param spec - the tool's name, description, kind and card title.
 * @returns the definition to hand to `ctx.tools.register`.
 */
function elementReadTool(wait: ReadWait, spec: ElementReadSpec): ToolDefinition {
  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: {
      ref: { type: 'string', required: true, description: ELEMENT_REF_DESCRIPTION },
    },
    output: { schema: MARKUP_OUTPUT, render: renderMarkup, presentationMeta: markupMeta },
    // The read writes nothing and only waits on a browser, so two reads in one
    // step are answered by the same seat one after the other.
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<ContentMarkupValue> {
      if (!REF_PATTERN.test(args.ref)) throw new Error(ELEMENT_REF_REFUSAL)
      return await awaitRead(wait, exec, outcome => markupValue(outcome, spec.kind))
    },
    presentCall: (args): GenericCallView => ({
      card: 'generic',
      title: spec.title,
      kind: 'other',
      rawInput: `ref ${args.ref}`,
    }),
    presentResult: (_args, result): GenericResultView => markupResultView(result, spec.title),
  })
}

/**
 * Build the `content_read_dom` tool for one deployment.
 * @param wait - the channel this tool waits on.
 * @returns the definition to hand to `ctx.tools.register`.
 */
export function contentReadDomTool(wait: ReadWait): ToolDefinition {
  return defineTool({
    name: CONTENT_READ_DOM_TOOL_NAME,
    description: CONTENT_READ_DOM_DESCRIPTION,
    parameters: {
      scope: { type: 'string', required: true, description: DOM_SCOPE_DESCRIPTION },
      after: { type: 'string', description: DOM_AFTER_DESCRIPTION },
    },
    output: { schema: MARKUP_OUTPUT, render: renderMarkup, presentationMeta: markupMeta },
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<ContentMarkupValue> {
      if (!REF_PATTERN.test(args.scope)) throw new Error(DOM_SCOPE_REFUSAL)
      if (args.after !== undefined && !REF_PATTERN.test(args.after)) throw new Error(DOM_AFTER_REFUSAL)
      return await awaitRead(wait, exec, outcome => markupValue(outcome, 'dom'))
    },
    presentCall: (args): GenericCallView => ({
      card: 'generic',
      title: DOM_CALL_TITLE,
      kind: 'other',
      rawInput: `scope ${args.scope}${args.after === undefined ? '' : `, after ${args.after}`}`,
    }),
    presentResult: (_args, result): GenericResultView => markupResultView(result, DOM_CALL_TITLE),
  })
}

/**
 * Build the `content_read_attrs` tool for one deployment.
 * @param wait - the channel this tool waits on.
 * @returns the definition to hand to `ctx.tools.register`.
 */
export function contentReadAttrsTool(wait: ReadWait): ToolDefinition {
  return elementReadTool(wait, {
    name: CONTENT_READ_ATTRS_TOOL_NAME,
    description: CONTENT_READ_ATTRS_DESCRIPTION,
    kind: 'attrs',
    title: ATTRS_CALL_TITLE,
  })
}

/**
 * Build the `content_read_dom_content` tool for one deployment.
 * @param wait - the channel this tool waits on.
 * @returns the definition to hand to `ctx.tools.register`.
 */
export function contentReadDomContentTool(wait: ReadWait): ToolDefinition {
  return elementReadTool(wait, {
    name: CONTENT_READ_DOM_CONTENT_TOOL_NAME,
    description: CONTENT_READ_DOM_CONTENT_DESCRIPTION,
    kind: 'content',
    title: CONTENT_CALL_TITLE,
  })
}
