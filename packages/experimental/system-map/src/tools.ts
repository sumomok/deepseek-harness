/**
 * The three reads, as the tools a model is offered.
 *
 * Each one asks the deployment's own backend through `ctx.bizBackend` and
 * nothing else: this package holds no credential, opens no socket and knows no
 * address, so the whole of what it can reach is the named reads that seam
 * publishes. A read that seam could not perform comes back as a value, and
 * every one of those values becomes a sentence saying why the call was refused.
 *
 * None of the three writes anything, asks anybody anything, or looks at a
 * screen. What they answer with is the deployment's stored configuration and
 * the signed-in person's own rights — never the values in a row.
 * @module @deepseek-ai/dsh-experimental-system-map/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type GenericCallView, type GenericResultView, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {
  BizBackendFailure,
  BizModelSummary,
  BizPermissions,
  BizUserRights,
} from '@deepseek-ai/dsh-experimental-biz-backend'
import {
  attributeEntries,
  compareNames,
  domainOf,
  editableColumns,
  groupDomains,
  modelEntries,
  noteOf,
  pageWithin,
  permittedOperations,
  resolveDomain,
  resolveModel,
  rightsByModel,
  visibleModels,
} from './reduce.ts'
import {
  AFTER_ATTRIBUTES_PARAMETER_DESCRIPTION,
  AFTER_PARAMETER_DESCRIPTION,
  attributeLine,
  DOMAIN_MODELS_DESCRIPTION,
  DOMAIN_MODELS_TOOL_NAME,
  DOMAIN_PARAMETER_DESCRIPTION,
  DOMAINS_DESCRIPTION,
  DOMAINS_TOOL_NAME,
  domainLine,
  MAY_DESCRIPTION,
  emptyRefusal,
  MODEL_DESCRIPTION,
  MODEL_PARAMETER_DESCRIPTION,
  MODEL_TOOL_NAME,
  modelLine,
  refusedRefusal,
  rejectedRefusal,
  renderDomainModels,
  renderDomains,
  renderModel,
  UNAUTHENTICATED_REFUSAL,
  unknownDomainRefusal,
  unknownModelRefusal,
  unreachableRefusal,
} from './text.ts'
import type { DomainModelsValue, DomainsValue, MapBounds, ModelValue } from './types.ts'

/** Title of the subject-area listing's card, in the pending and the settled state alike. */
const DOMAINS_CALL_TITLE = 'List this deployment\'s subject areas'

/** Title of the model listing's card. */
const DOMAIN_MODELS_CALL_TITLE = 'List a subject area\'s data models'

/** Title of the one-model read's card. */
const MODEL_CALL_TITLE = 'Read one data model'

/**
 * The sentence one failed read becomes.
 *
 * A closed union ending in `assertNever`, so a failure added to the seam later
 * fails this build rather than reaching a model as an empty answer.
 * @param failure - what the read answered instead of data.
 * @returns the sentence the model reads.
 */
function refusalFor(failure: BizBackendFailure): string {
  switch (failure.kind) {
    case 'unauthenticated': return UNAUTHENTICATED_REFUSAL
    case 'refused': return refusedRefusal(failure.status)
    case 'rejected': return rejectedRefusal(failure.status, failure.code, failure.message)
    case 'unreachable': return unreachableRefusal(failure.detail)
    /* v8 ignore next -- the failure union is closed and typed; the arm keeps a new member loud. */
    default: return assertNever(failure, 'BizBackendFailure')
  }
}

/**
 * The data one read answered with, or the refusal that ends the call.
 * @param result - what the read answered.
 * @returns the data.
 * @throws {Error} the sentence the model reads, for every answer that is not data.
 */
function read<T extends object>(result: T | BizBackendFailure): T {
  if ('kind' in result) throw new Error(refusalFor(result))
  return result
}

/**
 * The cursor one request continues from.
 * @param after - the argument as the model wrote it.
 * @param parameter - the parameter's name, for the refusal.
 * @returns the cursor, or `undefined` for a first listing.
 * @throws {Error} when the argument is present and empty.
 */
function cursorOf(after: string | undefined, parameter: string): string | undefined {
  if (after === undefined) return undefined
  if (after === '') throw new Error(emptyRefusal(parameter))
  return after
}

/**
 * The subject or model one request names.
 * @param named - the argument as the model wrote it.
 * @param parameter - the parameter's name, for the refusal.
 * @returns the name.
 * @throws {Error} when the argument is empty.
 */
function namedOf(named: string, parameter: string): string {
  if (named === '') throw new Error(emptyRefusal(parameter))
  return named
}

/** What one call knows once the catalog and the rights are both read. */
interface VisibleCatalog {
  /** The models the signed-in person may look at, in catalog order. */
  readonly models: readonly BizModelSummary[]
  /** What the rights read permits. */
  readonly permissions: BizPermissions
  /** The rights read itself, for what the permissions do not carry. */
  readonly rights: BizUserRights
}

/**
 * The part of this deployment's catalog the signed-in person may look at.
 *
 * Both reads run together and either failing ends the call with its refusal, so
 * a person whose rights cannot be read is shown nothing rather than everything.
 * @param ctx - the injected context carrying the backend seam.
 * @param signal - aborts both reads.
 * @returns the visible models, what the rights read permits, and the rights read itself.
 * @throws {Error} the sentence the model reads, when either read failed.
 */
async function visibleCatalog(ctx: Context, signal: AbortSignal): Promise<VisibleCatalog> {
  const [catalog, rights] = await Promise.all([
    ctx.bizBackend.listModels(signal),
    ctx.bizBackend.userRights(signal),
  ])
  const models = read(catalog).models
  const granted = read(rights)
  const permissions = ctx.bizBackend.judge(granted)
  return { models: visibleModels(models, permissions), permissions, rights: granted }
}

/** The two counts and the cursor every listing ends with. */
const PAGE_PROPERTIES = {
  from: { type: 'integer', required: true, description: 'How many entries of the whole listing come before the first one here.' },
  shown: { type: 'integer', required: true, description: 'How many entries this answer carries.' },
  total: { type: 'integer', required: true, description: 'How many the whole listing has.' },
  truncated: { type: 'boolean', required: true, description: 'Whether this answer stops short of the whole listing.' },
  cursor: { type: 'string', description: 'Pass as `after` to continue a listing that was cut short.' },
} as const

/**
 * Offer the subject-area listing.
 * @param ctx - the injected context carrying the backend seam.
 * @param bounds - the deployment's ceilings.
 * @returns the definition to hand to `ctx.tools.register`.
 */
export function domainsTool(ctx: Context, bounds: MapBounds): ToolDefinition {
  return defineTool({
    name: DOMAINS_TOOL_NAME,
    description: DOMAINS_DESCRIPTION,
    parameters: {
      after: { type: 'string', description: AFTER_PARAMETER_DESCRIPTION },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          domains: {
            type: 'array',
            required: true,
            description: 'The subject areas, in code order.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                domain: { type: 'string', required: true, description: 'The code this deployment files models under.' },
                name: { type: 'string', required: true, description: 'The name this deployment shows for that code.' },
                models: { type: 'integer', required: true, description: 'How many data models it holds that the signed-in person may look at.' },
              },
            },
          },
          ...PAGE_PROPERTIES,
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderDomains(value) }],
    },
    // The read spends a credential and changes nothing, so two of them in one
    // step are two requests rather than a queue.
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<DomainsValue> {
      const after = cursorOf(args.after, 'after')
      const { models } = await visibleCatalog(ctx, exec.signal)
      const domains = groupDomains(models)
      const page = pageWithin(domains, after, entry => entry.domain, domainLine, bounds.listingChars)
      return {
        domains: [...page.items],
        from: page.to - page.items.length,
        shown: page.items.length,
        total: domains.length,
        truncated: page.truncated,
        ...page.cursor === undefined ? {} : { cursor: page.cursor },
      }
    },
    presentCall: (args): GenericCallView => ({
      card: 'generic',
      title: DOMAINS_CALL_TITLE,
      kind: 'search',
      ...args.after === undefined ? {} : { rawInput: `after ${args.after}` },
    }),
    presentResult: (_args, result): GenericResultView => ({
      card: 'generic',
      title: DOMAINS_CALL_TITLE,
      content: result.content,
    }),
  })
}

/**
 * Offer the model listing.
 * @param ctx - the injected context carrying the backend seam.
 * @param bounds - the deployment's ceilings.
 * @returns the definition to hand to `ctx.tools.register`.
 */
export function domainModelsTool(ctx: Context, bounds: MapBounds): ToolDefinition {
  return defineTool({
    name: DOMAIN_MODELS_TOOL_NAME,
    description: DOMAIN_MODELS_DESCRIPTION,
    parameters: {
      domain: { type: 'string', required: true, description: DOMAIN_PARAMETER_DESCRIPTION },
      after: { type: 'string', description: AFTER_PARAMETER_DESCRIPTION },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          domain: { type: 'string', required: true, description: 'The subject area listed, by its code.' },
          name: { type: 'string', required: true, description: 'The name this deployment shows for that code.' },
          models: {
            type: 'array',
            required: true,
            description: 'The models, in English-name order.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                model: { type: 'string', required: true, description: 'The name this deployment keys the model by.' },
                name: { type: 'string', description: 'The name this deployment shows a person.' },
                table: { type: 'string', description: 'Where the model\'s rows are stored.' },
                may: {
                  type: 'array',
                  required: true,
                  items: { type: 'string' },
                  description: MAY_DESCRIPTION,
                },
                note: { type: 'string', description: 'What this deployment records about the model.' },
              },
            },
          },
          ...PAGE_PROPERTIES,
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderDomainModels(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<DomainModelsValue> {
      const wanted = namedOf(args.domain, 'domain')
      const after = cursorOf(args.after, 'after')
      const { models, permissions } = await visibleCatalog(ctx, exec.signal)
      const domains = groupDomains(models)
      const area = resolveDomain(domains, wanted)
      if (area === undefined) throw new Error(unknownDomainRefusal(wanted, domains))
      const held = modelEntries(
        models.filter(summary => domainOf(summary).domain === area.domain),
        permissions,
        bounds.noteChars,
      )
      const page = pageWithin(held, after, entry => entry.model, modelLine, bounds.listingChars)
      return {
        domain: area.domain,
        name: area.name,
        models: [...page.items],
        from: page.to - page.items.length,
        shown: page.items.length,
        total: held.length,
        truncated: page.truncated,
        ...page.cursor === undefined ? {} : { cursor: page.cursor },
      }
    },
    presentCall: (args): GenericCallView => ({
      card: 'generic',
      title: DOMAIN_MODELS_CALL_TITLE,
      kind: 'search',
      rawInput: args.after === undefined ? args.domain : `${args.domain}, after ${args.after}`,
    }),
    presentResult: (_args, result): GenericResultView => ({
      card: 'generic',
      title: DOMAIN_MODELS_CALL_TITLE,
      content: result.content,
    }),
  })
}

/**
 * Offer the one-model read.
 * @param ctx - the injected context carrying the backend seam.
 * @param bounds - the deployment's ceilings.
 * @returns the definition to hand to `ctx.tools.register`.
 */
export function modelTool(ctx: Context, bounds: MapBounds): ToolDefinition {
  return defineTool({
    name: MODEL_TOOL_NAME,
    description: MODEL_DESCRIPTION,
    parameters: {
      model: { type: 'string', required: true, description: MODEL_PARAMETER_DESCRIPTION },
      after: { type: 'string', description: AFTER_ATTRIBUTES_PARAMETER_DESCRIPTION },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string', required: true, description: 'The name this deployment keys the model by.' },
          name: { type: 'string', description: 'The name this deployment shows a person.' },
          domain: { type: 'string', required: true, description: 'The subject area it is filed under, by its code.' },
          domainName: { type: 'string', required: true, description: 'The name this deployment shows for that code.' },
          table: { type: 'string', description: 'Where the model\'s rows are stored.' },
          parent: { type: 'string', description: 'The model this one extends, by its English name.' },
          note: { type: 'string', description: 'What this deployment records about the model.' },
          attributes: {
            type: 'array',
            required: true,
            description: 'The attributes, in English-name order.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                attribute: { type: 'string', required: true, description: 'The name rows are keyed by.' },
                name: { type: 'string', description: 'The name this deployment shows a person.' },
                type: { type: 'string', description: 'The stored type, in this deployment\'s own type vocabulary.' },
                length: { type: 'integer', description: 'Longest stored value the model accepts.' },
                key: { type: 'boolean', description: 'Whether the attribute is part of what identifies a row.' },
                nullable: { type: 'boolean', description: 'Whether a row may leave the attribute empty.' },
                default: { type: 'string', description: 'The value stored when a person enters none.' },
                group: { type: 'string', description: 'The group this deployment\'s own forms file the attribute under.' },
                required: { type: 'boolean', description: 'Whether a form refuses to save without a value.' },
                editable: { type: 'boolean', description: 'Whether the forms let this person change the value.' },
                forms: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Which of this deployment\'s own forms draw the attribute.',
                },
                picks: { type: 'string', description: 'The model the attribute takes a row of, by its English name.' },
                values: {
                  type: 'array',
                  description: 'The fixed values it offers.',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      stored: { type: 'string', required: true, description: 'The value as a row stores it.' },
                      shown: { type: 'string', required: true, description: 'The text this deployment shows for it.' },
                    },
                  },
                },
                moreValues: { type: 'integer', description: 'How many further fixed values were left out.' },
              },
            },
          },
          may: {
            type: 'array',
            required: true,
            items: { type: 'string' },
            description: MAY_DESCRIPTION,
          },
          editableColumns: {
            type: 'array',
            items: { type: 'string' },
            description: 'The attributes editing is narrowed to, where this deployment narrows it.',
          },
          ...PAGE_PROPERTIES,
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderModel(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<ModelValue> {
      const wanted = namedOf(args.model, 'model')
      const after = cursorOf(args.after, 'after')
      const { models, permissions, rights } = await visibleCatalog(ctx, exec.signal)
      const summary = resolveModel(models, wanted)
      if (summary === undefined) throw new Error(unknownModelRefusal(wanted))
      const [described, schemes] = await Promise.all([
        ctx.bizBackend.describe(summary.resClassEnName, exec.signal),
        ctx.bizBackend.describeSchemes(summary.resClassEnName, exec.signal),
      ])
      const entries = attributeEntries(read(described).attributes, read(schemes).schemes, bounds)
      const row = rightsByModel(rights).get(summary.resClassEnName)
      const narrowed = editableColumns(row)
      const note = noteOf(summary, bounds.noteChars)
      const { domain, name } = domainOf(summary)
      const page = pageWithin(entries, after, entry => entry.attribute, attributeLine, bounds.listingChars)
      return {
        model: summary.resClassEnName,
        ...summary.resClassCnName === '' ? {} : { name: summary.resClassCnName },
        domain,
        domainName: name,
        ...summary.dsTableName === undefined ? {} : { table: summary.dsTableName },
        ...summary.parentClassEnName === undefined ? {} : { parent: summary.parentClassEnName },
        ...note === undefined ? {} : { note },
        attributes: [...page.items],
        may: permittedOperations(permissions, summary.resClassEnName),
        ...narrowed === undefined ? {} : { editableColumns: [...narrowed].sort(compareNames) },
        from: page.to - page.items.length,
        shown: page.items.length,
        total: entries.length,
        truncated: page.truncated,
        ...page.cursor === undefined ? {} : { cursor: page.cursor },
      }
    },
    presentCall: (args): GenericCallView => ({
      card: 'generic',
      title: MODEL_CALL_TITLE,
      kind: 'read',
      rawInput: args.after === undefined ? args.model : `${args.model}, after ${args.after}`,
    }),
    presentResult: (_args, result): GenericResultView => ({
      card: 'generic',
      title: MODEL_CALL_TITLE,
      content: result.content,
    }),
  })
}
