/**
 * Every sentence a model reads out of this package: the three descriptions, the
 * parameter descriptions, the headings that say how a listing is written, the
 * lines themselves, and every refusal.
 *
 * Each description states what its own tool answers with and what its own
 * parameters take, and names no other tool: a description that pointed at a
 * sibling would be read as an instruction to call that sibling, and a model
 * that has decided what a tool is for does not read the text again. Each
 * refusal states why the call was refused and names the parameter that would
 * fix it, and names no tool to recover with, so what to do next is the model's
 * own decision rather than a script this package wrote for it.
 *
 * The listings are written as `key=value` fields because that is what a
 * deployment of a thousand models costs least to read: a heading says once what
 * every key means, and a field this deployment states nothing for is left out
 * rather than carried as a placeholder.
 * @module @deepseek-ai/dsh-experimental-system-map/text
 */

import type {
  AttributeEntry,
  DomainEntry,
  DomainModelsValue,
  DomainsValue,
  ModelEntry,
  ModelValue,
} from './types.ts'

/** Wire name of the subject-area listing. */
export const DOMAINS_TOOL_NAME = 'system_map_domains'

/** Wire name of the model listing. */
export const DOMAIN_MODELS_TOOL_NAME = 'system_map_domain_models'

/** Wire name of the one-model read. */
export const MODEL_TOOL_NAME = 'system_map_model'

/**
 * Characters of a refused parameter value repeated back.
 *
 * A copy decision rather than a deployment one: the value is echoed so the
 * model can see which of its own strings was refused, and a model argument has
 * no length of its own to trust.
 */
const MAX_ECHO_CHARS = 80

/**
 * Subject areas named in the refusal for one this deployment does not have.
 *
 * Enough for a model to correct itself from, and few enough that a refusal
 * stays a sentence: a deployment with a hundred subject areas would otherwise
 * answer a mistyped code with the whole listing.
 */
const MAX_SUGGESTED_DOMAINS = 24

/** What `system_map_domains` tells a model it is for. */
export const DOMAINS_DESCRIPTION = 'List the subject areas this deployment divides its business data into, '
  + 'and how many data models each one holds, counting only the data models the signed-in person may look at: '
  + 'a subject area holding none of those is not listed. Start here whenever somebody names something in their own words '
  + '— a kind of record, a form they fill in, a screen they work in — and which of this deployment\'s data models '
  + 'they mean is not settled yet: the subject areas are the deployment\'s own top-level division of its business, '
  + 'so the area a request belongs to is usually plain from its name. '
  + 'What comes back is this deployment\'s own configuration, never the values in any row and never what is on screen.'

/** What `system_map_domain_models` tells a model it is for. */
export const DOMAIN_MODELS_DESCRIPTION = 'List the data models one subject area of this deployment holds that the '
  + 'signed-in person may look at: '
  + 'each model\'s English name, the name a person is shown for it, the table its rows are stored in, '
  + 'what this deployment records about it, and which operations the signed-in person may perform on it. '
  + 'Reach for it once a subject area is settled and the task is to find which model a request is really about, '
  + 'and reach for it before proposing any step that needs the signed-in person to be allowed to read or change '
  + 'a model — the answer says what they may do, so a step nobody may take is one to drop before suggesting it. '
  + 'What comes back is this deployment\'s own configuration, never the values in any row and never what is on screen.'

/** What `system_map_model` tells a model it is for. */
export const MODEL_DESCRIPTION = 'Read one data model of this deployment in full: every attribute with the type '
  + 'and length it stores, whether a row may leave it empty, whether it is part of what identifies a row, '
  + 'the value used when none is given, the group this deployment\'s own forms file it under, the fixed values '
  + 'it offers, the model it takes a row of, which of this deployment\'s own forms draw it, which of them refuse '
  + 'to save without it, and whether they let the signed-in person change it — then which operations that person '
  + 'may perform on the model. Reach for it before writing about a model\'s fields, before telling somebody what '
  + 'a form of it will ask them for, and before proposing anything that depends on what one of its values may be. '
  + 'What comes back is this deployment\'s own configuration and this person\'s rights, never the values in any '
  + 'row and never what is on screen.'

/** What the `may` field of a listed or read model holds. */
export const MAY_DESCRIPTION = 'The operations the signed-in person may perform on the model, '
  + 'from read, metadata_read, create, update, delete, import and export.'

/** What the `domain` parameter takes. */
export const DOMAIN_PARAMETER_DESCRIPTION = 'The subject area to list, by either the code this deployment files '
  + 'models under or the name it shows for that code.'

/** What the `model` parameter takes. */
export const MODEL_PARAMETER_DESCRIPTION = 'The data model to read, by either the English name this deployment '
  + 'keys it by or the name it shows a person for it.'

/** What the `after` parameter takes on a listing of subject areas or models. */
export const AFTER_PARAMETER_DESCRIPTION = 'Continue a listing that was cut short, by passing back the cursor '
  + 'that listing ended with. Leave it out for the first listing.'

/** What the `after` parameter takes on a read of one model. */
export const AFTER_ATTRIBUTES_PARAMETER_DESCRIPTION = 'Continue an attribute listing that was cut short, by '
  + 'passing back the cursor that listing ended with. Leave it out to start at the first attribute.'

/**
 * One rejected value, made fit to repeat back.
 * @param value - the value the request carried.
 * @returns the value, cut to the echo bound.
 */
function echo(value: string): string {
  return value.length <= MAX_ECHO_CHARS ? value : value.slice(0, MAX_ECHO_CHARS)
}

/**
 * Refuse a parameter that carried nothing.
 * @param parameter - the parameter's name.
 * @returns the sentence the model reads.
 */
export function emptyRefusal(parameter: string): string {
  return `\`${parameter}\` was empty. Pass the value this deployment uses, spelled exactly as this deployment spells it.`
}

/** Refuse every read while nobody is signed in. */
export const UNAUTHENTICATED_REFUSAL = 'Nobody is signed in to this deployment, '
  + 'so nothing about its business system could be read.'

/**
 * Refuse a call made outside any session. The session is what names the person
 * a read spends the credential of, so a call with none reads for nobody.
 */
export const NO_SESSION_REFUSAL = 'This call is not running in a session, '
  + 'so nothing about this deployment\'s business system could be read.'

/**
 * Refuse a read whose credential this deployment would not take.
 * @param status - the status the deployment answered with.
 * @returns the sentence the model reads.
 */
export function refusedRefusal(status: number): string {
  return `This deployment refused the signed-in person's credential (HTTP ${String(status)}), `
    + 'so nothing about its business system could be read.'
}

/**
 * Refuse a read this deployment answered by refusing the request.
 * @param status - the status the deployment answered with.
 * @param code - the result code its answer carried, where it carried one.
 * @param message - its own message, where it gave one.
 * @returns the sentence the model reads.
 */
export function rejectedRefusal(status: number, code: number | undefined, message: string | undefined): string {
  const said = message === undefined ? '' : `: ${message}`
  const coded = code === undefined ? '' : `, code ${String(code)}`
  return `This deployment refused the request (HTTP ${String(status)}${coded})${said}.`
}

/**
 * Refuse a read this deployment did not answer at all.
 * @param detail - what stopped it, as the read reported it.
 * @returns the sentence the model reads.
 */
export function unreachableRefusal(detail: string): string {
  return `This deployment's business system did not answer: ${detail}.`
}

/**
 * Refuse a subject area this deployment does not have, naming the ones it does.
 *
 * The listing is in the refusal because a model correcting itself from the
 * answer it already has spends one call instead of two.
 * @param wanted - what the request named.
 * @param domains - the subject areas this deployment has, in code order.
 * @returns the sentence the model reads.
 */
export function unknownDomainRefusal(wanted: string, domains: readonly DomainEntry[]): string {
  const named = domains.slice(0, MAX_SUGGESTED_DOMAINS)
  const rest = domains.length - named.length
  const more = rest === 0 ? '' : `, and ${String(rest)} more`
  const listed = named.map(entry => `${entry.domain} (${entry.name})`).join(', ')
  return `No subject area the signed-in person may look at is called "${echo(wanted)}". `
    + `Pass \`domain\` as one of those: ${listed}${more}.`
}

/**
 * Refuse a model the signed-in person may not look at, whether or not this
 * deployment has one of that name.
 *
 * One sentence for both, so a refusal says nothing about a model this person
 * may not look at — not even that it exists. No listing here: a deployment
 * keeps more data models than a refusal could carry, and the two names the
 * parameter accepts are what a model needs to try again.
 * @param wanted - what the request named.
 * @returns the sentence the model reads.
 */
export function unknownModelRefusal(wanted: string): string {
  return `No data model the signed-in person may look at is called "${echo(wanted)}". `
    + 'Pass `model` as either the English name this deployment keys a model by '
    + 'or the name it shows a person for one.'
}

/**
 * The line telling a model a listing stopped short and how to go on.
 * @param to - how far into the whole listing this answer reaches.
 * @param total - how long the whole listing is.
 * @param cursor - the key to pass back.
 * @returns the line.
 */
export function cutLine(to: number, total: number, cursor: string): string {
  return `Cut after ${String(to)} of ${String(total)}; pass "${cursor}" as \`after\` to continue.`
}

/**
 * The heading of a subject-area listing.
 * @param total - how many subject areas this deployment has.
 * @returns the heading.
 */
export function domainsHeading(total: number): string {
  return `The data models the signed-in person may look at are sorted into ${String(total)} subject areas. `
    + 'Each line is a subject area\'s code, then `name=` the name shown for it '
    + 'and `models=` how many data models it holds.'
}

/**
 * One subject area's line.
 * @param entry - the subject area.
 * @returns the line.
 */
export function domainLine(entry: DomainEntry): string {
  return `${entry.domain} name=${entry.name} models=${String(entry.models)}`
}

/**
 * The heading of a model listing.
 * @param domain - the subject area's code.
 * @param name - the name shown for it.
 * @param total - how many models it holds.
 * @returns the heading.
 */
export function modelsHeading(domain: string, name: string, total: number): string {
  return `Subject area ${domain} (${name}) holds ${String(total)} data models the signed-in person may look at. `
    + 'Each line is a model\'s English name, then, where this deployment states them, `name=` the name shown '
    + 'and `table=` where its rows are stored, then `may=` the operations the signed-in person may perform on it '
    + '(from read, metadata_read, create, update, delete, import and export), and, where this deployment records '
    + 'one, `note=` what it records about it.'
}

/**
 * One model's line in a listing.
 * @param entry - the model.
 * @returns the line.
 */
export function modelLine(entry: ModelEntry): string {
  return [
    entry.model,
    ...entry.name === undefined ? [] : [`name=${entry.name}`],
    ...entry.table === undefined ? [] : [`table=${entry.table}`],
    `may=${entry.may.join(',')}`,
    ...entry.note === undefined ? [] : [`note=${entry.note}`],
  ].join(' ')
}

/**
 * One attribute's line in a model read.
 * @param entry - the attribute.
 * @returns the line.
 */
export function attributeLine(entry: AttributeEntry): string {
  const values = entry.values === undefined
    ? []
    : [`values=${entry.values.map(value => `${value.stored}=${value.shown}`).join('|')}`
      + (entry.moreValues === undefined ? '' : `|+${String(entry.moreValues)} more`)]
  return [
    entry.attribute,
    ...entry.name === undefined ? [] : [`name=${entry.name}`],
    ...entry.type === undefined ? [] : [`type=${entry.type}`],
    ...entry.length === undefined ? [] : [`len=${String(entry.length)}`],
    ...entry.key === true ? ['key=yes'] : [],
    ...entry.nullable === true ? ['null=yes'] : [],
    ...entry.default === undefined ? [] : [`default=${entry.default}`],
    ...entry.group === undefined ? [] : [`group=${entry.group}`],
    ...entry.required === true ? ['req=yes'] : [],
    ...entry.editable === false ? ['edit=no'] : [],
    ...entry.forms === undefined ? [] : [`forms=${entry.forms.join(',')}`],
    ...entry.picks === undefined ? [] : [`picks=${entry.picks}`],
    ...values,
  ].join(' ')
}

/**
 * The heading of a model read: what the model is, followed by how its attribute
 * lines are written and what the signed-in person may do with it.
 * @param value - the answer being rendered.
 * @returns the heading, one fact per line.
 */
export function modelHeading(value: ModelValue): string {
  const shown = value.name === undefined ? '' : ` (${value.name})`
  const filed = `filed under ${value.domain} (${value.domainName})`
  const stored = value.table === undefined ? '' : `, rows stored in ${value.table}`
  const extends_ = value.parent === undefined ? '' : `, extending ${value.parent}`
  const note = value.note === undefined ? '' : ` ${value.note}`
  const may = `The signed-in person may perform these operations on this model: ${value.may.join(', ')}.`
  const narrowed = value.editableColumns === undefined
    ? ''
    : `\nEditing is narrowed to these attributes: ${value.editableColumns.join(', ')}.`
  return `Data model ${value.model}${shown}, ${filed}${stored}${extends_}.${note}\n`
    + `${String(value.total)} attributes. Each line is an attribute's English name, then, where this deployment `
    + 'states them: `name=` the name shown, `type=` the stored type, `len=` the longest stored value, '
    + '`key=yes` when it is part of what identifies a row, `null=yes` when a row may leave it empty, '
    + '`default=` the value used when none is given, `group=` the group the forms file it under, '
    + '`req=yes` when a form refuses to save without it, `edit=no` when the forms will not let this person '
    + 'change it, `forms=` which of this deployment\'s own forms draw it, `picks=` the model it takes a row of, '
    + 'and `values=` the fixed values it offers as stored=shown pairs separated by `|`.\n'
    + `${may}${narrowed}`
}

/**
 * Join one heading, its lines, and the cut line where the listing stopped short.
 * @param heading - the heading.
 * @param lines - the rendered lines.
 * @param cut - the cut line, where the listing stopped short.
 * @returns the whole answer a model reads.
 */
function listing(heading: string, lines: readonly string[], cut: string | undefined): string {
  return [heading, ...lines, ...cut === undefined ? [] : [cut]].join('\n')
}

/**
 * The cut line one answer ends with, where it ends with one.
 * @param value - how far the answer reaches and how it is continued.
 * @returns the line, or `undefined` where the answer carries the whole listing.
 */
function cutOf(
  value: { readonly from: number; readonly shown: number; readonly total: number; readonly cursor?: string },
): string | undefined {
  return value.cursor === undefined ? undefined : cutLine(value.from + value.shown, value.total, value.cursor)
}

/**
 * Render one subject-area listing.
 * @param value - the answer.
 * @returns the text a model reads.
 */
export function renderDomains(value: DomainsValue): string {
  return listing(domainsHeading(value.total), value.domains.map(domainLine), cutOf(value))
}

/**
 * Render one model listing.
 * @param value - the answer.
 * @returns the text a model reads.
 */
export function renderDomainModels(value: DomainModelsValue): string {
  return listing(modelsHeading(value.domain, value.name, value.total), value.models.map(modelLine), cutOf(value))
}

/**
 * Render one model read.
 * @param value - the answer.
 * @returns the text a model reads.
 */
export function renderModel(value: ModelValue): string {
  return listing(modelHeading(value), value.attributes.map(attributeLine), cutOf(value))
}
