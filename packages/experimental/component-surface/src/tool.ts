/**
 * `show_component` — the agent puts a block of interface in the panel beside
 * the conversation.
 *
 * One tool for every component the deployment offers, rather than one tool per
 * component: which blocks exist is a deployment's catalog, and a catalog is
 * cheaper to state once inside a description than to spread across a growing
 * tool list the model has to read on every request.
 *
 * A call that writes its own rows does nothing but get judged. The record the
 * column folds is the `tool/call` the loop already writes, so the entry such a
 * call produces is reconstructable from the log alone and a refusal leaves the
 * column exactly as it was.
 *
 * A call that names a `dataSource` is the other half, and it exists only where
 * the deployment composed both a data backend and an approval answerer. It asks
 * the user once, reads the rows with that user's own credential, puts them in,
 * and appends the filled result as `content-component/resolved` — because the
 * rows are not in the `tool/call` and there is nothing else for the column to
 * replay from. Anything that goes wrong after the question is asked leaves the
 * column untouched and answers the model with one sentence.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {
  BizBackendFailure,
  BizCondition,
  BizMetaResult,
  BizSearchResult,
} from '@deepseek-ai/dsh-experimental-biz-backend'
// Type-only: resolves ctx.approval, the question one read is asked through.
import type {} from '@deepseek-ai/dsh-user-approval'
import {
  BINDING_KEY,
  catalogLabels,
  COMPONENT_CATALOG,
  describeCatalog,
  MATCH_OPERATOR_IDS,
  MAX_COLUMN_ALIAS_LENGTH,
  MAX_ENTRY_ID_LENGTH,
  MAX_FLEX,
  MAX_LAYOUT_DEPTH,
  MAX_NODES,
  MAX_SPEC_BYTES,
  MAX_TABLE_ROWS,
  MAX_TITLE_LENGTH,
  SHOW_COMPONENT_TOOL_NAME,
  TABLE_ID,
  TOKEN_HINT,
  type ComponentCall,
} from './component-call.ts'
import {
  applyDataSourceRows,
  dataSourceApprovalReason,
  dataSourceEmpty,
  dataSourceOversize,
  dataSourceRejected,
  dataSourceUndrawable,
  dataSourceUnknownAttribute,
  dataSourceUnreachable,
  DATA_SOURCE_NOT_APPROVED,
  DATA_SOURCE_NO_SESSION,
  DATA_SOURCE_UNAUTHENTICATED,
  normalizeRow,
  probeDataSourceSpec,
  readDataSourceBlocks,
  resolveDataSourceTargets,
  type DataSourceFill,
  type DataSourceTarget,
} from './data-source.ts'
// Type-only: this package's own `content-component/resolved` SessionEventMap merge.
import type {} from './types.ts'
import { validateComponentCall } from './validate.ts'

/**
 * The `dataSource` parameter as the schema declares it.
 *
 * One list of opaque documents, like `spec.nodes` beside it: what an entry
 * carries is stated once in the description, where the vocabulary it shares
 * with the catalog can be stated in prose rather than repeated as a nested
 * JSON Schema the model reads on every request.
 */
const DATA_SOURCE_PARAMETER = {
  type: 'array',
  description: `What to read from the data source, one entry per ${TABLE_ID} block to fill. `
    + 'Leave it out to write the rows yourself.',
  items: { type: 'json' },
} as const

/** The canonical outcome declared by the `show_component` output schema. */
export interface ShowComponentValue {
  /** The entry the call now owns in the panel. */
  entryId: string
  /** The model-facing result line. */
  text: string
}

/** What one composition's `show_component` offers, decided when the row loads. */
export interface ShowComponentOptions {
  /**
   * Whether a call may fill a table from the deployment's own data backend.
   * False wherever the deployment composed no backend or no approval answerer,
   * and the parameter is then absent from both the schema and the description —
   * an offer nothing can honour is worse than no offer.
   */
  readonly dataSource: boolean
  /** Rows one read asks for when the call names no count of its own. */
  readonly defaultPageSize: number
}

/** What one table's read returned, as the model is told it and the log records it. */
interface FetchSummary {
  /** The block the rows went into. */
  readonly nodeId: string
  /** The table they were read from. */
  readonly meta: string
  /** How many rows arrived. */
  readonly rows: number
  /** How many rows match across every page, where the backend reported it. */
  readonly total?: number
  /** The attributes this read asked for, which is the columns the call declared. */
  readonly columns: readonly string[]
}

/** Every table read for one call: the rows to put in, and what to say about them. */
interface FetchOutcome {
  /** One entry per filled block, in the order the call wrote them. */
  readonly fills: readonly DataSourceFill[]
  /** One entry per filled block, in the same order. */
  readonly summaries: readonly FetchSummary[]
}

/**
 * Build the paragraph describing the `dataSource` parameter.
 *
 * Split out because it is the whole of what a data-reading composition says
 * more than a plain one: the two descriptions are otherwise the same bytes, and
 * a composition without a backend must not be told about a parameter it cannot
 * use.
 * @param defaultPageSize - what a read asks for when the call names no count.
 * @returns the paragraph.
 */
function describeDataSource(defaultPageSize: number): string {
  return `\n\nA ${TABLE_ID} block can be filled from this deployment's own data instead of by you. Send `
    + `\`dataSource\`: a list of {"nodeId": "<one of your ${TABLE_ID} block ids>", `
    + '"meta": "<the table\'s name in the data source>", "metaLabel": "<that same table\'s name in the user\'s '
    + 'language, which is what the user is shown when asked>", "conditions"?: [{"key": "<attribute>", "op": "<one of '
    + `${MATCH_OPERATOR_IDS.join(', ')}>", "value": text, a number, a yes-or-no, or a list of those}], `
    + `"matchMode"?: "AND" or "OR", "page"?: {"pageSize": 1–${MAX_TABLE_ROWS}}, "asc"? or "desc"?: "<attribute>"}. `
    + `A read asks for ${defaultPageSize} rows where it names no count, and there is no way to ask for a second `
    + 'page — to see rows a first page did not reach, narrow the conditions. '
    + 'A block named here sends no '
    + '`displayValueList` and no `rawValueList` — the rows are read for you and put in — while its '
    + '`tableConfig.gridItems` still says which attributes to read and what to head each column with. '
    + 'The user is asked once per call before anything is read, and an unanswered or refused question draws '
    + 'nothing at all. What comes back to you is how many rows arrived and which attributes they carry; the rows '
    + 'themselves go to the panel and not into this conversation.'
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
 * @param options - what this composition offers.
 * @returns the complete description.
 */
export function describeShowComponent(options: ShowComponentOptions): string {
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
    + (options.dataSource ? describeDataSource(options.defaultPageSize) : '')
}

/**
 * The sentence an accepted call answers with.
 * @param call - the call as validation accepted it.
 * @returns the sentence.
 */
function acceptedText(call: ComponentCall): string {
  return `Now showing "${call.title}" in the content panel: ${catalogLabels(call.spec.nodes)}. `
    + `Call ${SHOW_COMPONENT_TOOL_NAME} with id "${call.id}" again to replace it; `
    + 'a different id adds a second entry beside it.'
}

/**
 * The account of one call's reads the model is given: a count and a list of
 * attribute names, and nothing out of any row.
 * @param summaries - one entry per filled block.
 * @returns the sentences, one per block.
 */
function fetchedText(summaries: readonly FetchSummary[]): string {
  return summaries.map((summary) => {
    const of = summary.total === undefined ? '' : ` of ${summary.total} matching`
    return ` Read ${summary.rows}${of} rows from "${summary.meta}" into block "${summary.nodeId}", `
      + `for the attributes ${summary.columns.join(', ')}.`
  }).join('')
}

/**
 * Say why one backend call returned nothing.
 * @param meta - the table that was asked for.
 * @param failure - the classified failure.
 * @returns the model-facing sentence.
 */
function failureText(meta: string, failure: BizBackendFailure): string {
  switch (failure.kind) {
    case 'unauthenticated': return DATA_SOURCE_UNAUTHENTICATED
    case 'refused': return dataSourceRejected(meta, failure.status)
    case 'rejected': return dataSourceRejected(meta, failure.status, failure.code, failure.message)
    case 'unreachable': return dataSourceUnreachable(meta, failure.detail)
    /* v8 ignore start -- BizBackendFailure is closed and every member returns above. */
    default: {
      // Not `assertNever` from dsh-llm: this row's judgement modules avoid that
      // import, and one host module reaching for it would be its only user.
      const unhandled: never = failure
      throw new Error(`component-surface: unhandled data-source failure ${JSON.stringify(unhandled)}`)
    }
    /* v8 ignore stop */
  }
}

/**
 * Whether one answer is a failure rather than what was asked for.
 * @param answer - what the seam returned.
 * @returns true when it is a classified failure.
 */
function isFailure(answer: BizSearchResult | BizMetaResult | BizBackendFailure): answer is BizBackendFailure {
  return 'kind' in answer
}

/**
 * Check every attribute one read names against the backend's own dictionary,
 * and take the headers the call left out from it.
 *
 * Before the rows rather than after, because none of the three ways of naming
 * an attribute fails loudly downstream. A column the table does not have
 * arrives without its key and draws blank in front of the user. A filter or a
 * sort on one is the backend's to interpret, and the two readings it can take
 * are both wrong here: ignoring the filter answers a read the user consented to
 * as a narrowed one with everything up to the page size, and refusing it
 * answers the model with the backend's rejection instead of the sentence that
 * names the attribute to fix. The dictionary that settles all three is already
 * in hand.
 * @param target - the resolved read.
 * @param described - the table's attributes as the backend lists them.
 * @returns the headers to write, or the sentence naming the attribute that does not exist.
 */
function checkColumns(
  target: DataSourceTarget,
  described: BizMetaResult,
): { readonly ok: true; readonly aliases: ReadonlyMap<string, string> } | { readonly ok: false; readonly text: string } {
  const known = new Map(described.attributes.map(attribute => [attribute.attributeEnName, attribute.attributeCnName]))
  const aliases = new Map<string, string>()
  for (const column of target.columns) {
    const named = known.get(column.attr)
    if (named === undefined) {
      return { ok: false, text: dataSourceUnknownAttribute(target.block.meta, column.attr, described.attributes) }
    }
    // A header the call wrote stands; the dictionary only fills the gaps, and
    // only with a name the column property accepts.
    if (column.alias === undefined && named.length > 0 && named.length <= MAX_COLUMN_ALIAS_LENGTH) aliases.set(column.attr, named)
  }
  const narrowed = [
    ...target.block.conditions.map(condition => condition.key),
    ...target.block.asc === undefined ? [] : [target.block.asc],
    ...target.block.desc === undefined ? [] : [target.block.desc],
  ]
  for (const attr of narrowed) {
    if (!known.has(attr)) {
      return { ok: false, text: dataSourceUnknownAttribute(target.block.meta, attr, described.attributes) }
    }
  }
  return { ok: true, aliases }
}

/**
 * Read one table.
 * @param ctx - the injected context carrying the data backend.
 * @param target - the resolved read.
 * @param signal - the execution's own cancellation.
 * @returns the rows to put in and what to say about them, or the sentence to refuse with.
 */
async function readTarget(
  ctx: Context,
  target: DataSourceTarget,
  signal: AbortSignal,
): Promise<
  | { readonly ok: true; readonly fill: DataSourceFill; readonly summary: FetchSummary }
  | { readonly ok: false; readonly text: string }
> {
  const { block } = target
  const described = await ctx.bizBackend.describe(block.meta, signal)
  if (isFailure(described)) return { ok: false, text: failureText(block.meta, described) }
  const checked = checkColumns(target, described)
  if (!checked.ok) return checked
  const conditions: BizCondition[] = block.conditions.map(condition => ({
    key: condition.key,
    op: condition.op,
    value: condition.value,
  }))
  const answer = await ctx.bizBackend.search({
    meta: block.meta,
    source: target.columns.map(column => column.attr),
    conditions,
    matchMode: block.matchMode,
    page: { currentPage: 1, pageSize: block.pageSize },
    ...block.asc === undefined ? {} : { asc: block.asc },
    ...block.desc === undefined ? {} : { desc: block.desc },
  }, signal)
  if (isFailure(answer)) return { ok: false, text: failureText(block.meta, answer) }
  // Both lists are held to the columns this call declared, because those are
  // the columns the card named and the backend answers with the attributes it
  // chose: it puts its own row identifier in front of every `source` it is
  // given.
  const asked = new Set(target.columns.map(column => column.attr))
  const displayValueList = answer.displayValue.map(row => normalizeRow(row, asked))
  if (displayValueList.length === 0) return { ok: false, text: dataSourceEmpty(block.meta) }
  // The stored rows stand behind the drawn ones one for one, so a backend
  // answering a different number of them is a pairing the table cannot draw.
  // The property is optional and the drawn rows are what the user reads, so the
  // block is written without it rather than the whole read being refused.
  const stored = answer.rawValue.length === displayValueList.length
    ? answer.rawValue.map(row => normalizeRow(row, asked))
    : undefined
  return {
    ok: true,
    fill: {
      target,
      displayValueList,
      aliases: checked.aliases,
      ...stored === undefined ? {} : { rawValueList: stored },
    },
    summary: {
      nodeId: block.nodeId,
      meta: block.meta,
      rows: displayValueList.length,
      ...answer.total === undefined ? {} : { total: answer.total },
      columns: target.columns.map(column => column.attr),
    },
  }
}

/**
 * Read every table of one call, one after another.
 *
 * Serial rather than parallel, for the reason the user answered one question:
 * the backend sees the reads a person allowed in the order they were asked for,
 * and a failure names the table it happened on rather than whichever of several
 * concurrent requests lost the race.
 * @param ctx - the injected context carrying the data backend.
 * @param targets - the resolved reads, in the order they were written.
 * @param signal - the execution's own cancellation.
 * @returns every table's rows, or the sentence the first failure refuses with.
 */
async function readAll(
  ctx: Context,
  targets: readonly DataSourceTarget[],
  signal: AbortSignal,
): Promise<{ readonly ok: true; readonly outcome: FetchOutcome } | { readonly ok: false; readonly text: string }> {
  const fills: DataSourceFill[] = []
  const summaries: FetchSummary[] = []
  for (const target of targets) {
    const read = await readTarget(ctx, target, signal)
    if (!read.ok) return read
    fills.push(read.fill)
    summaries.push(read.summary)
  }
  return { ok: true, outcome: { fills, summaries } }
}

/**
 * Run one call that names a data source.
 *
 * The order is the whole design: everything judgeable without spending anything
 * is judged first, then the user is asked, then the credential is spent, then
 * the filled result is judged again by the pass a hand-written call gets.
 * Nothing is appended and nothing is drawn unless that last pass accepts.
 * @param ctx - the injected context carrying the data backend and the approval service.
 * @param options - what this composition offers.
 * @param args - the call's arguments, however malformed.
 * @param written - the `dataSource` argument, however malformed.
 * @param exec - the execution's identity, agent and cancellation.
 * @returns the accepted outcome.
 * @throws {Error} carrying the one model-facing sentence for whatever stopped the read.
 */
async function runDataSource(
  ctx: Context,
  options: ShowComponentOptions,
  args: { readonly id?: unknown; readonly title?: unknown; readonly spec?: unknown },
  written: unknown,
  exec: ToolRunContext,
): Promise<ShowComponentValue> {
  const blocks = readDataSourceBlocks(written, options.defaultPageSize)
  if (!blocks.ok) throw new Error(blocks.failure.text)
  const resolved = resolveDataSourceTargets(blocks.blocks, args.spec)
  if (!resolved.ok) throw new Error(resolved.failure.text)
  // The same pass a hand-written call gets, over this call with a stand-in row
  // in each table it wants read: everything a call can be refused for that the
  // rows have no part in is settled here, in one judgement rather than a list
  // of ceilings restated beside the read.
  const judged = validateComponentCall({
    id: args.id,
    title: args.title,
    spec: probeDataSourceSpec(args.spec, resolved.nodes, resolved.targets),
  })
  if (!judged.ok) throw new Error(judged.failure.text)
  const { agent } = exec
  // No session means neither half of this can happen: nobody to ask, and
  // nowhere to record what the rows became.
  if (agent === undefined) throw new Error(DATA_SOURCE_NO_SESSION)
  // Asked before the question rather than discovered after it: reading the
  // slot spends nothing, and a person who allows a read this process cannot
  // perform has answered for nothing.
  if (!ctx.bizBackend.holdsCredential()) throw new Error(DATA_SOURCE_UNAUTHENTICATED)
  const outcome = await ctx.approval.request({
    agent,
    toolName: SHOW_COMPONENT_TOOL_NAME,
    callId: exec.callId,
    reason: dataSourceApprovalReason(resolved.targets),
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') throw new Error(DATA_SOURCE_NOT_APPROVED)
  const read = await readAll(ctx, resolved.targets, exec.signal)
  if (!read.ok) throw new Error(read.text)
  const { fills, summaries } = read.outcome
  const spec = applyDataSourceRows(args.spec, resolved.nodes, fills)
  // Every read succeeded to get here, so there is at least one summary; the
  // first table's name is what an over-full or undrawable result is named by.
  const first = summaries[0] as FetchSummary
  const bytes = new TextEncoder().encode(JSON.stringify(spec)).length
  if (bytes > MAX_SPEC_BYTES) {
    throw new Error(dataSourceOversize(first.meta, summaries.reduce((count, summary) => count + summary.rows, 0), bytes))
  }
  const result = validateComponentCall({ id: args.id, title: args.title, spec })
  if (!result.ok) {
    const { failure } = result
    throw new Error(dataSourceUndrawable(first.meta, failure.text.slice(failure.text.indexOf(failure.path))))
  }
  agent.session.append('content-component/resolved', {
    callId: exec.callId,
    entryId: result.call.id,
    title: result.call.title,
    spec: result.call.spec,
    fetched: summaries.map(summary => ({
      nodeId: summary.nodeId,
      meta: summary.meta,
      rows: summary.rows,
      ...summary.total === undefined ? {} : { total: summary.total },
      columns: [...summary.columns],
    })),
  })
  return { entryId: result.call.id, text: acceptedText(result.call) + fetchedText(summaries) }
}

/**
 * Build the `show_component` tool.
 * @param ctx - the context the tool is registered on, carrying the data backend and the approval service wherever the offer includes them.
 * @param options - what this composition offers.
 * @returns the definition to hand to `ctx.tools.register`.
 */
export function showComponentTool(ctx: Context, options: ShowComponentOptions): ToolDefinition {
  return defineTool({
    name: SHOW_COMPONENT_TOOL_NAME,
    description: describeShowComponent(options),
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
      ...options.dataSource ? { dataSource: DATA_SOURCE_PARAMETER } : {},
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
    execute(args, exec): Promise<ShowComponentValue> {
      const written: unknown = (args as { dataSource?: unknown }).dataSource
      if (options.dataSource && written !== undefined) return runDataSource(ctx, options, args, written, exec)
      const result = validateComponentCall(args)
      // A refusal changes nothing: the panel keeps showing whatever it showed,
      // and the model gets the offending path back to correct itself.
      if (!result.ok) throw new Error(result.failure.text)
      return Promise.resolve({ entryId: result.call.id, text: acceptedText(result.call) })
    },
    presentCall: (args): GenericCallView => ({
      card: 'generic',
      title: `Show ${args.title} in the content panel`,
      kind: 'other',
      rawInput: args.id,
    }),
  })
}
