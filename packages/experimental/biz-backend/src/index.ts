/**
 * @deepseek-ai/dsh-experimental-biz-backend — reading this deployment's own
 * data backend with the access token of the person using it.
 *
 * Host-only, and it holds no credential of its own: whoever installs the
 * service passes the token in by reference, which in this fork is the sign-on
 * gate that took it from the visitor's browser. The three reads below are the
 * same three requests the deployment's own web page makes when a person opens
 * a resource list, minus three things that page adds for itself: no cache-busting
 * query parameter (nothing here caches), no expansion of the browser's stored
 * profile into request headers, and no activity record posted afterwards —
 * writing one would put an operation into the deployment's audit trail that its
 * user never performed.
 *
 * A capability, not a pipe. The same URL prefix also carries
 * `PUT /api/resources/{model}/{id}`, `DELETE /api/resources/{model}/{id}`, and
 * `POST /api/batchresources/delete/{model}`. A general `fetch(path, init)`
 * service would hand every plugin sharing this process the visitor's credential
 * and those endpoints along with it, so the three reads below name what they do
 * and can reach nothing else.
 *
 * Whether the signed-in person may do something with a model is judged here
 * too, once, out of one rights read and one deployment-written rule table, so
 * every consumer that hides or refuses on that person's behalf applies the same
 * rules and none of them keeps a copy.
 *
 * Failures are values, never exceptions: every call answers with its result or
 * with one member of {@link BizBackendFailure}, so a consumer switches on the
 * tag and the compiler names the case it forgot.
 * @module @deepseek-ai/dsh-experimental-biz-backend
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    bizBackend: BizBackendService
  }
}

/**
 * Path of the resource-read service under the deployment's API prefix.
 *
 * Fixed by the deployment's own frontend, which writes it into its HTTP client
 * rather than into configuration: an external specification here, not a
 * deployment choice, so it is a constant and not a `Config` field.
 */
const SEARCH_SERVICE_PATH = 'nrms-datamanagement/api/resources'

/** Path of the schema service one model's attribute names are read from; fixed for the same reason. */
const META_SERVICE_PATH = 'nrms-schema-manage/api/meta/resclass'

/** Path of the schema service the deployment's own list of resource models is read from; fixed for the same reason. */
const MODEL_LIST_SERVICE_PATH = 'nrms-schema-manage/api/meta/resclassname'

/** Path of the schema service one model's stored schemes are read from; fixed for the same reason. */
const SCHEME_SERVICE_PATH = 'nrms-schema-manage/api/schema/schema'

/** Path of the sign-on service the signed-in person's own rights are read from; fixed for the same reason. */
const RIGHTS_SERVICE_PATH = 'nrms-auth/api/auth/userinfo'

/**
 * The resource-class kind that means a model the deployment stores rows of, in
 * the schema service's own numbering. Its two siblings — the kinds a
 * deployment composes out of stored models rather than storing — answer this
 * endpoint with nothing, so the stored kind is the whole catalog and is written
 * here as the external specification it is rather than as a deployment choice.
 */
const STORED_RESOURCE_CLASS_TYPE = 1

/**
 * The scheme kind that describes a resource list, in the schema service's own
 * numbering. The deployment's frontend writes the same literal when it opens
 * one, so it is an external specification here rather than a deployment choice.
 */
const QUERY_SCHEME_TYPE = 1

/** The flag selecting the one scheme of that kind a resource list opens with. */
const DEFAULT_SCHEME_FLAG = 1

/**
 * Rows one read asks for when the request names no page of its own.
 *
 * Not a deployment knob: every caller that cares about page size states one,
 * and the value below only bounds a caller that states none, so that an
 * unstated page cannot become "every row this model has".
 */
const DEFAULT_PAGE_SIZE = 200

/** Page number an unstated page starts at. */
const DEFAULT_CURRENT_PAGE = 1

/** Characters of the backend's own message this seam repeats to its caller. */
const MAX_MESSAGE_CHARS = 120

/** What the presented credential is replaced by wherever the backend says it back. */
const REDACTED_CREDENTIAL = '<token>'

/** Characters of a diagnostic detail this seam repeats to its caller. */
const MAX_DETAIL_CHARS = 200

/**
 * A resource model name that can stand as one path segment.
 *
 * Checked before the name reaches a URL, because the request it is built into
 * carries the visitor's credential: a name holding `/` or `..` would send that
 * credential to a different endpoint under the same prefix than the one this
 * seam offers.
 */
const MODEL_NAME = /^[A-Za-z_]\w*$/

/**
 * Envelope codes that mean the credential itself no longer counts, on an answer
 * whose HTTP status already says the request failed.
 *
 * Both halves of that test are required, because the deployment's own client
 * treats them separately: its error interceptor gives the stored token up on
 * these two codes, while its success interceptor reports a non-zero code on an
 * HTTP 200 and keeps the token. So a 200 carrying either code is one request
 * refused, and a failing status carrying either is this credential refused.
 *
 * This is the only route by which an HTTP 403 gives the credential up. That
 * status on its own is the deployment's "access refused" for one request, and
 * its client keeps the stored token through it.
 */
const CREDENTIAL_REFUSAL_CODES: readonly number[] = [2, 3]

/** The two events that make the process give up the token it holds. */
export type CredentialDropReason = 'sign-out' | 'refused-by-backend'

/**
 * The process's whole memory of the visitor's access token, as the three
 * operations anything is allowed to perform on it.
 *
 * A closure passed by reference rather than a service, and the reason is the
 * cost of the alternative: a service named on the context is a credential every
 * plugin sharing this process can read, and this fork's own audit found that
 * third-party plugins declare no approval gates by default. Two holders are the
 * whole list — whoever takes the token in and gives it up, and
 * {@link BizBackendService}, which spends it and drops it when the backend
 * refuses it — and a seam this narrow is worth one hand-written indirection.
 */
export interface HeldCredential {
  /**
   * The token as it stands.
   * @returns the bare JWT, or `undefined` while none is held.
   */
  read(): string | undefined
  /**
   * Replace the held token with a newer one.
   * @param token - the bare JWT the browser half posted.
   */
  set(token: string): void
  /**
   * Give the held token up. Both reasons reach the same terminal state: every
   * MCP forwarding route answers 503 and every read answers `unauthenticated`
   * until a browser posts a new token.
   * @param reason - which of the two events dropped it.
   */
  drop(reason: CredentialDropReason): void
}

/** One filter on a read. `op` is carried into the request body as it stands. */
export interface BizCondition {
  /** Attribute the filter applies to, by its English name. */
  readonly key: string
  /** Comparison the backend applies, in its own operator vocabulary. */
  readonly op: string
  /** Value compared against; a list for the set comparisons. */
  readonly value: string | number | boolean | readonly (string | number)[]
}

/** What one read asks for. Only the model name is required; everything else is defaulted by the provider. */
export interface BizSearchRequest {
  /** Resource model to read, by its English name. */
  readonly meta: string
  /** Filters to apply; none means every row the backend shows this visitor. */
  readonly conditions?: readonly BizCondition[]
  /** How the filters combine; `AND` when unstated. */
  readonly matchMode?: 'AND' | 'OR'
  /** Attributes to return, by English name; the backend picks its own set when unstated. */
  readonly source?: readonly string[]
  /** Which page to read; one page of {@link DEFAULT_PAGE_SIZE} rows when unstated. */
  readonly page?: { readonly currentPage: number; readonly pageSize: number }
  /** Attribute to sort ascending by. */
  readonly asc?: string
  /** Attribute to sort descending by. */
  readonly desc?: string
}

/** What one read returned: the rows twice over, as stored and as displayed, plus how many exist. */
export interface BizSearchResult {
  /** One object per row, keyed by attribute English name, holding stored values. */
  readonly rawValue: readonly Readonly<Record<string, unknown>>[]
  /** The same rows and keys, holding the text the deployment displays for those values. */
  readonly displayValue: readonly Readonly<Record<string, unknown>>[]
  /** Rows matching the filters across every page, when the backend reported it. */
  readonly total?: number
}

/**
 * One attribute of a resource model, under both of its names and with whatever
 * the model states about the value it stores.
 *
 * Every field after the two names is absent wherever the description carries
 * neither reading of it, so a caller distinguishes "the model says this
 * attribute takes no value" from "the model says nothing about it".
 */
export interface BizMetaAttribute {
  /** The name rows are keyed by. */
  readonly attributeEnName: string
  /** The name the deployment shows a person. */
  readonly attributeCnName: string
  /** The stored value's type, in the deployment's own type vocabulary. */
  readonly dataType?: string
  /** Longest stored value the model accepts, where it states a length. */
  readonly dataLength?: number
  /** Whether a row may leave the attribute empty, where the model states it. */
  readonly isNull?: boolean
  /** Whether the attribute is part of what identifies a row, where the model states it. */
  readonly isPrimaryKey?: boolean
  /** The value stored when a person enters none, where the model states one. */
  readonly defaultValue?: string
  /** The group the deployment files the attribute under on its own forms. */
  readonly attrGrpName?: string
  /** What the deployment records about the attribute for a person to read. */
  readonly remark?: string
}

/** What one model description returned. */
export interface BizMetaResult {
  /** Every attribute the model declares, in the order the backend lists them. */
  readonly attributes: readonly BizMetaAttribute[]
}

/**
 * One column of a model's default query scheme, reduced to the four fields a
 * caller drawing that scheme's table needs.
 *
 * The three optional fields are absent wherever the stored scheme carries
 * neither reading of them, so a caller distinguishes "the scheme hid this
 * column" from "the scheme said nothing about it".
 */
export interface BizSchemeColumn {
  /** The attribute the column reads its cell out of, by its English name. */
  readonly relatedMetaAttr: string
  /** The header the scheme gives the column, where it gives one. */
  readonly alias?: string
  /** Whether the resource list draws the column, where the scheme states it. */
  readonly isShow?: boolean
  /** Whether the resource list lets a person sort by the column, where the scheme states it. */
  readonly isSortable?: boolean
}

/** What one default-query-scheme read returned. */
export interface BizSchemeResult {
  /** The scheme's columns, in the order it lists them. */
  readonly columns: readonly BizSchemeColumn[]
}

/** One value a dictionary attribute may hold, as the deployment stores it and as it shows it. */
export interface BizDictionaryValue {
  /** The value as a row stores it. */
  readonly key: string
  /** The text the deployment shows for that stored value. */
  readonly value: string
}

/**
 * One form item of a stored scheme: an attribute as one of the deployment's own
 * forms offers it.
 *
 * A dictionary and a related model are carried here and nowhere else, because
 * this is where the deployment's own frontend reads them: the values a person
 * may pick belong to the form drawing the attribute, not to the model
 * describing it.
 */
export interface BizSchemeFormItem {
  /** The attribute the item edits, by its English name. */
  readonly relatedMetaAttr: string
  /** The label the scheme gives the item, where it gives one. */
  readonly alias?: string
  /** Whether the form refuses to save without a value, where the scheme states it. */
  readonly isRequired?: boolean
  /** Whether the form lets a person change the value, where the scheme states it. */
  readonly isEditable?: boolean
  /** Whether the form draws the item at all, where the scheme states it. */
  readonly isShow?: boolean
  /** The values the item offers, where it offers a fixed set. */
  readonly relatedDict?: readonly BizDictionaryValue[]
  /** The model the item picks a row of, by its English name, where it picks one. */
  readonly relatedMeta?: string
}

/** One of a model's stored schemes, reduced to the attributes it draws and the columns it lists. */
export interface BizScheme {
  /** Which kind of scheme it is, in the schema service's own numbering. */
  readonly schemaType: number
  /** Every attribute the scheme's forms draw, across all of its form groups. */
  readonly formItems: readonly BizSchemeFormItem[]
  /** The columns the scheme's table lists, in the order it lists them. */
  readonly columns: readonly BizSchemeColumn[]
}

/** What one all-schemes read returned. */
export interface BizModelSchemes {
  /** The model's default schemes, in the order the backend lists them. */
  readonly schemes: readonly BizScheme[]
}

/** One resource model as the deployment's own catalog lists it. */
export interface BizModelSummary {
  /** The name rows, schemes and rights all key the model by. */
  readonly resClassEnName: string
  /** The name the deployment shows a person; empty where the catalog carries none. */
  readonly resClassCnName: string
  /** The subject area the deployment files the model under, by its code. */
  readonly classDiagramType?: string
  /** The name the deployment shows for that subject area. */
  readonly classDiagramTypeCnName?: string
  /** The stored table the model's rows live in. */
  readonly dsTableName?: string
  /** The model this one extends, by its English name. */
  readonly parentClassEnName?: string
  /** What the deployment records about the model for a person to read. */
  readonly remark?: string
  /** The deployment's longer description of the model, where it keeps one. */
  readonly resClassDescription?: string
}

/** What one catalog read returned. */
export interface BizModelListResult {
  /** Every model the catalog lists, in the order the backend lists them. */
  readonly models: readonly BizModelSummary[]
}

/** What the signed-in person may do with one resource model. */
export interface BizModelRights {
  /** The model the row is about, by its English name. */
  readonly resclassenname: string
  /** The operations the row grants, by the deployment's own operation names, in code-unit order. */
  readonly operations: readonly string[]
  /** The attributes the row narrows editing to, as the row writes them; absent where it narrows none. */
  readonly columns?: string
}

/** One narrowing of the values the signed-in person may pick for one attribute. */
export interface BizRowRight {
  /** The attribute the narrowing applies to, as the rights table names it. */
  readonly resourceName: string
  /** The values it leaves available, as the rights table writes them. */
  readonly resourceValue: string
}

/**
 * What one rights read returned.
 *
 * The person's own rights and nothing else about them. The endpoint answers
 * with a profile as well — account name, employee number, telephone, mail — and
 * none of it is read here, so no later caller has it to hand to a model, write
 * into a session log, or repeat in a failure.
 */
export interface BizUserRights {
  /** One row per model the rights table names, in the order it lists them. */
  readonly resclass: readonly BizModelRights[]
  /** Every value narrowing the rights table states. */
  readonly rows: readonly BizRowRight[]
}

/**
 * One thing a person can do with a resource model, under the operation code the
 * backend plans to enforce it by.
 *
 * Fixed by that plan rather than by a deployment: which of these a person may
 * perform is deployment-varying and lives in {@link BizOperationRules}, and the
 * set itself is what every rule table and every consumer names.
 */
export type BizOperation = 'read' | 'metadata_read' | 'create' | 'update' | 'delete' | 'import' | 'export'

/** Every {@link BizOperation}, in the order the backend's plan lists them. */
export const BIZ_OPERATIONS: readonly BizOperation[] = [
  'read',
  'metadata_read',
  'create',
  'update',
  'delete',
  'import',
  'export',
]

/**
 * What one operation requires of the signed-in person's rights row for a model.
 *
 * `'row'`: the rights table holds a row for the model at all. A list: it holds
 * one, and that row grants at least one of the named flags, by the rights
 * table's own flag names (`add`, `update`, `delete`, `exp`, …).
 */
export type BizOperationRule = 'row' | readonly string[]

/** One {@link BizOperationRule} per {@link BizOperation}: the whole of how rights become permissions. */
export type BizOperationRules = { readonly [K in BizOperation]: BizOperationRule }

/** One rights-table flag name, as a rule may name it. */
const RIGHTS_FLAG_NAME = /^[A-Za-z_]\w*$/

/**
 * One operation's rule, with the default a deployment starts from.
 * @param fallback - the rule a deployment that writes none gets.
 * @returns the schema for one rule.
 */
function operationRule(fallback: BizOperationRule): z<BizOperationRule> {
  return z.union([z.const('row' as const), z.array(z.string().pattern(RIGHTS_FLAG_NAME)).min(1)])
    // Schemastery types a default as the mutable form; the rule is never mutated.
    .default(fallback as 'row' | string[]) as z<BizOperationRule>
}

/**
 * How rights become permissions, as a deployment writes it into the row that
 * constructs {@link BizBackendService}.
 *
 * The defaults are the rules this deployment's backend enforces today. It
 * writes `null` for `search`, `imp`, `exp` and `gridexp` on every account,
 * administrators included, and checks only `add`, `update` and `delete`; so
 * reading, reading a model's description and exporting require only that the
 * model has a row, and importing requires either write flag. A deployment whose
 * backend starts enforcing a flag — `export: [exp]` once exports are checked —
 * changes that one entry here and nothing else.
 */
export const BizOperationRules: z<Partial<BizOperationRules>, BizOperationRules> = z.object({
  read: operationRule('row').description('What reading a model\'s rows requires.'),
  metadata_read: operationRule('row').description('What reading a model\'s description requires.'),
  create: operationRule(['add']).description('What creating a row requires.'),
  update: operationRule(['update']).description('What changing a row requires.'),
  delete: operationRule(['delete']).description('What deleting a row requires.'),
  import: operationRule(['add', 'update']).description('What importing rows requires.'),
  export: operationRule('row').description('What exporting rows requires.'),
})

/**
 * Refuse a rule table naming an operation there is no rule for.
 *
 * The schema keeps a key it does not declare rather than dropping it, so a
 * misspelled operation would otherwise leave the rule it meant to change at its
 * default with nothing said. Whoever configures the table calls this at load.
 * @param rules - the table as the schema resolved it.
 * @returns the same table.
 * @throws {Error} naming every key that is not a {@link BizOperation}.
 */
export function requireBizOperationRules(rules: BizOperationRules): BizOperationRules {
  const unknown = Object.keys(rules).filter(key => !(BIZ_OPERATIONS as readonly string[]).includes(key))
  if (unknown.length > 0) {
    throw new Error(`biz-backend: no operation is called ${unknown.map(key => `"${key}"`).join(', ')}; `
      + `the rule table names ${BIZ_OPERATIONS.join(', ')}`)
  }
  return rules
}

/**
 * What one rights read permits, judged by one deployment's rules.
 *
 * Fail closed: a judgement made from a failed read, or from a rights table that
 * names no model at all, permits nothing.
 */
export interface BizPermissions {
  /**
   * Whether the signed-in person may perform one operation on one model.
   * @param model - the resource model, by its English name.
   * @param operation - the operation.
   * @returns true only when the rights read succeeded, holds a row for the model, and that row meets the operation's rule.
   */
  may(model: string, operation: BizOperation): boolean
}

/**
 * Judge one rights read by one rule table.
 * @param rights - the rights read, or why it failed.
 * @param rules - the deployment's rule table.
 * @returns the permissions that read grants.
 */
function judgeRights(rights: BizUserRights | BizBackendFailure, rules: BizOperationRules): BizPermissions {
  const rows = new Map<string, BizModelRights>('kind' in rights ? [] : rights.resclass.map(row => [row.resclassenname, row]))
  return {
    may: (model, operation) => {
      const row = rows.get(model)
      if (row === undefined) return false
      const rule = rules[operation]
      return rule === 'row' || rule.some(flag => row.operations.includes(flag))
    },
  }
}

/**
 * Why one call returned no data. A closed union: a consumer switches on `kind`
 * and ends in `assertNever`, so a member added later fails its build rather
 * than falling through.
 *
 * No member carries the credential, the full request URL, or the backend's
 * trace identifier — a failure is reported to a model and written into a
 * session log, and none of the three belongs in either.
 */
export type BizBackendFailure =
  /** No browser has posted a token, so nothing was requested. */
  | { readonly kind: 'unauthenticated' }
  /** The backend refused the credential itself; the process has given it up. */
  | { readonly kind: 'refused'; readonly status: number }
  /** The backend answered, and its answer was a refusal of this request. */
  | { readonly kind: 'rejected'; readonly status: number; readonly code?: number; readonly message?: string }
  /** No answer this seam could read: the request never went out, never arrived, or came back as something else. */
  | { readonly kind: 'unreachable'; readonly detail: string }

/** The document one read posts, and the address it posts to. */
interface BizSearchSpec {
  /** Absolute URL of the read. */
  readonly url: string
  /** The request document, with every default already filled in. */
  readonly body: BizSearchBody
}

/** The request document the backend's read endpoint takes. */
interface BizSearchBody {
  readonly resclassenname: string
  readonly source?: readonly string[]
  readonly conditions: readonly BizCondition[]
  readonly asc: string | null
  readonly desc: string | null
  readonly matchMode: 'AND' | 'OR'
  readonly page: { readonly currentPage: number; readonly pageSize: number }
}

/** One exchange that reached the backend's envelope, or the failure that stopped it. */
type BizExchange = { readonly kind: 'answered'; readonly data: unknown } | BizBackendFailure

/** What one call needs before it may spend the credential. */
interface BizCallSubject {
  /** The token to spend. */
  readonly token: string
  /** The model name, checked to be one path segment. */
  readonly meta: string
}

/**
 * Join one relative path onto the configured base the way the deployment's own
 * HTTP client does.
 *
 * Deliberately not `new URL(relative, base)`: that resolves the relative
 * address against the base, so any leading `/` on the relative half replaces
 * the deployment's API prefix outright and the request silently lands at the
 * server root. This form keeps every segment of the base.
 * @param base - the configured upstream, ending in `/`.
 * @param relative - the path under it.
 * @returns the absolute URL.
 */
function combineUrls(base: string, relative: string): string {
  return `${base.replace(/\/+$/, '')}/${relative.replace(/^\/+/, '')}`
}

/**
 * One piece of free text made fit to hand back.
 *
 * Everything this seam returns reaches a model and a session log, so the two
 * things that must not travel that far are taken out here: the credential the
 * request presented, wherever it is said back, and any length past the bound.
 * Bounding alone would not do — a backend saying the token inside its first
 * hundred characters would pass — so the removal comes first.
 * @param text - the text to report.
 * @param presented - the credential the request carried.
 * @param limit - largest accepted length, in characters.
 * @returns the text with the credential removed, cut to the bound.
 */
function reportable(text: string, presented: string, limit: number): string {
  const scrubbed = text.replaceAll(presented, REDACTED_CREDENTIAL)
  return scrubbed.length <= limit ? scrubbed : scrubbed.slice(0, limit)
}

/**
 * The two headers this backend reads a bearer token out of.
 *
 * Both carry the same value the deployment's own page sends. That page stores
 * `"Bearer <jwt>"` and puts the stored value into both headers verbatim, while
 * the gate holds the bare JWT — the browser half strips the scheme once, where
 * a stored value enters — so the scheme is added back here, and the bytes on
 * the wire match what the page sends. `CertificationToken` is simply how this
 * backend reads it; it is not a second credential.
 * @param token - the held bare JWT.
 * @returns the header table for one request.
 */
function credentialHeaders(token: string): Record<string, string> {
  const presented = `Bearer ${token}`
  return { accept: 'application/json', authorization: presented, CertificationToken: presented }
}

/**
 * Fill one read request out into the document the backend takes.
 *
 * Defaulting happens here and nowhere else — an explicit step between the
 * request a consumer states and the specification that goes on the wire — so
 * what an unstated field becomes is readable in one place instead of hidden
 * behind `??` at the point of use.
 *
 * `sourceName` is not sent although the page sends it: it is the page's own
 * column headings echoed back for its renderer, and a consumer here names its
 * columns itself.
 * @param request - what the consumer asked for.
 * @param meta - the model name, already checked as one path segment.
 * @param url - the address the read posts to.
 * @returns the resolved specification.
 */
function resolveSearch(request: BizSearchRequest, meta: string, url: string): BizSearchSpec {
  return {
    url,
    body: {
      resclassenname: meta,
      ...request.source === undefined ? {} : { source: request.source },
      conditions: request.conditions ?? [],
      asc: request.asc ?? null,
      desc: request.desc ?? null,
      matchMode: request.matchMode ?? 'AND',
      page: request.page ?? { currentPage: DEFAULT_CURRENT_PAGE, pageSize: DEFAULT_PAGE_SIZE },
    },
  }
}

/**
 * Decode one answered body.
 *
 * A body that does not parse carries nothing further to report, and the caller
 * already says what an unreadable answer means, so the parser's own message is
 * not passed on.
 * @param text - the body as it arrived.
 * @returns the decoded value, or `undefined` when the text is not JSON.
 */
function decodeEnvelope(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (_answerIsNotJson) {
    return undefined
  }
}

/**
 * The result code one envelope carries.
 * @param envelope - the decoded answer.
 * @returns the code, or `undefined` when the answer is not this backend's envelope.
 */
function envelopeCode(envelope: unknown): number | undefined {
  if (typeof envelope !== 'object' || envelope === null) return undefined
  const code = (envelope as { code?: unknown }).code
  return typeof code === 'number' ? code : undefined
}

/**
 * The backend's own message for a refused request, made fit to hand back.
 * @param envelope - the decoded answer.
 * @param presented - the credential this request carried.
 * @returns the message, or `undefined` when the answer carries none.
 */
function envelopeMessage(envelope: unknown, presented: string): string | undefined {
  const message = (envelope as { msg?: unknown }).msg
  if (typeof message !== 'string' || message === '') return undefined
  return reportable(message, presented, MAX_MESSAGE_CHARS)
}

/**
 * The payload one envelope carries.
 * @param envelope - the decoded answer, already known to be an envelope.
 * @returns the payload, whatever shape it has.
 */
function envelopeData(envelope: unknown): unknown {
  return (envelope as { data?: unknown }).data
}

/**
 * Whether one value is a list of row objects.
 * @param value - the candidate list.
 * @returns true when it is an array of non-null objects.
 */
function isRowList(value: unknown): value is readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(value)
    && (value as readonly unknown[]).every(row => typeof row === 'object' && row !== null)
}

/**
 * The row count one page descriptor reports.
 * @param page - the answer's page descriptor.
 * @returns the total, or `undefined` when it reports none.
 */
function readTotal(page: unknown): number | undefined {
  if (typeof page !== 'object' || page === null) return undefined
  const total = (page as { total?: unknown }).total
  return typeof total === 'number' ? total : undefined
}

/**
 * Read the two row lists and the total out of one read's payload.
 *
 * A payload carrying both row lists as an explicit null is zero rows, not an
 * unreadable answer: that is the answer this backend was measured giving a read
 * whose conditions matched nothing, and its page descriptor carries a null
 * total beside them. A payload that carries neither key is not that answer and
 * stays unreadable, because an envelope this seam has never seen is not one to
 * report a row count out of.
 * @param data - the envelope's payload.
 * @returns the result, or `undefined` when the payload is not one this seam reads.
 */
function readSearchData(data: unknown): BizSearchResult | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const payload = data as { rawValue?: unknown; displayValue?: unknown; page?: unknown }
  // Reading the measured empty answer as one this seam could not parse would
  // tell a caller its data source is broken when what happened is that its
  // filters matched no row.
  if (payload.rawValue === null && payload.displayValue === null) {
    return { rawValue: [], displayValue: [], total: 0 }
  }
  if (!isRowList(payload.rawValue) || !isRowList(payload.displayValue)) return undefined
  const total = readTotal(payload.page)
  return {
    rawValue: payload.rawValue,
    displayValue: payload.displayValue,
    ...total === undefined ? {} : { total },
  }
}

/**
 * Read one of this backend's yes-or-no fields.
 *
 * It writes them either way round: the characters `'0'` and `'1'` on some
 * answers and JSON booleans on others, and the deployment's own frontend reads
 * both. So both readings are accepted here, and a value that is neither is
 * treated as unstated rather than guessed at.
 * @param value - the field as the answer carries it.
 * @returns the flag, or `undefined` when the field carries neither reading.
 */
function readBackendFlag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === '1') return true
  if (value === '0') return false
  return undefined
}

/**
 * Read one of this backend's text fields.
 * @param value - the field as the answer carries it.
 * @returns the text, or `undefined` when the field carries none or carries it empty.
 */
function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Read one list of answered elements, leaving out every element the reader
 * could not make a published value out of.
 *
 * Every list this seam publishes drops rather than fails, for the reason each
 * reader states: an answer carries fields this seam never reads, and an element
 * with nothing to read is not one a caller could use.
 * @param value - the field as the answer carries it.
 * @param read - the reader for one element.
 * @returns the elements read, empty where the field is not a list.
 */
function readList<T>(value: unknown, read: (entry: unknown) => T | undefined): readonly T[] {
  if (!Array.isArray(value)) return []
  const items: T[] = []
  for (const entry of value as readonly unknown[]) {
    const item = read(entry)
    if (item !== undefined) items.push(item)
  }
  return items
}

/**
 * Read the named text fields of one answered element.
 * @param item - the element as the answer carries it.
 * @param keys - the fields to read, named as the backend names them.
 * @returns the fields that carry text, each under its own name.
 */
function readTextFields<K extends string>(
  item: Record<string, unknown>,
  keys: readonly K[],
): Partial<Record<K, string>> {
  const fields: Partial<Record<K, string>> = {}
  for (const key of keys) {
    const text = readText(item[key])
    if (text !== undefined) fields[key] = text
  }
  return fields
}

/** The text fields one catalog entry carries beyond the two names. */
const SUMMARY_TEXT_KEYS = [
  'classDiagramType',
  'classDiagramTypeCnName',
  'dsTableName',
  'parentClassEnName',
  'remark',
  'resClassDescription',
] as const

/** The text fields one described attribute carries beyond its two names. */
const ATTRIBUTE_TEXT_KEYS = ['dataType', 'defaultValue', 'attrGrpName', 'remark'] as const

/**
 * The two fields of a rights row that are not operations.
 *
 * Every other field of that row is one, because the row is an open table: the
 * deployment adds an operation by adding a key, and reading the keys is what
 * keeps a later one from being silently dropped.
 */
const RIGHTS_NON_OPERATION_KEYS: ReadonlySet<string> = new Set(['resclassenname', 'columns'])

/**
 * Reduce one scheme column to the four fields this seam publishes.
 *
 * A column naming no attribute is dropped rather than failing the call, for the
 * reason an attribute carrying neither name is: a stored scheme carries layout
 * fields this seam never reads, and an entry with nothing to read a cell out of
 * is not a column a caller could draw.
 * @param entry - one element of the scheme's column list.
 * @returns the column, or `undefined` when the element names no attribute.
 */
function readSchemeColumn(entry: unknown): BizSchemeColumn | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const item = entry as { relatedMetaAttr?: unknown; alias?: unknown; isShow?: unknown; isSortable?: unknown }
  const relatedMetaAttr = readText(item.relatedMetaAttr)
  if (relatedMetaAttr === undefined) return undefined
  const alias = readText(item.alias)
  const isShow = readBackendFlag(item.isShow)
  const isSortable = readBackendFlag(item.isSortable)
  return {
    relatedMetaAttr,
    ...alias === undefined ? {} : { alias },
    ...isShow === undefined ? {} : { isShow },
    ...isSortable === undefined ? {} : { isSortable },
  }
}

/**
 * Read the column list out of one stored scheme's table.
 * @param grid - the scheme's table, as the answer carries it.
 * @returns the columns, empty where the scheme lists none this seam can read.
 */
function readGridColumns(grid: unknown): readonly BizSchemeColumn[] {
  if (typeof grid !== 'object' || grid === null) return []
  return readList((grid as { gridItems?: unknown }).gridItems, readSchemeColumn)
}

/**
 * Reduce one dictionary entry to the stored value and the text shown for it.
 *
 * A stored value of `'0'` is a value like any other, so the key is read as text
 * of any length while the shown text is required to be non-empty: an entry with
 * nothing to show is not one a person could be offered.
 * @param entry - one element of a form item's value list.
 * @returns the entry, or `undefined` when it carries no stored value or no text.
 */
function readDictionaryValue(entry: unknown): BizDictionaryValue | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const item = entry as { key?: unknown; value?: unknown }
  const value = readText(item.value)
  if (value === undefined) return undefined
  if (typeof item.key === 'string') return { key: item.key, value }
  return typeof item.key === 'number' ? { key: String(item.key), value } : undefined
}

/**
 * The model one form item picks a row of.
 * @param relatedTrans - the item's translation record, as the answer carries it.
 * @returns the model's English name, or `undefined` when the item picks no row.
 */
function readRelatedMeta(relatedTrans: unknown): string | undefined {
  if (typeof relatedTrans !== 'object' || relatedTrans === null) return undefined
  return readText((relatedTrans as { relatedMeta?: unknown }).relatedMeta)
}

/**
 * Reduce one form item to the fields this seam publishes.
 * @param entry - one element of a form group's item list.
 * @returns the item, or `undefined` when the element names no attribute.
 */
function readSchemeFormItem(entry: unknown): BizSchemeFormItem | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const item = entry as Record<string, unknown>
  const relatedMetaAttr = readText(item.relatedMetaAttr)
  if (relatedMetaAttr === undefined) return undefined
  const alias = readText(item.alias)
  const isRequired = readBackendFlag(item.isRequired)
  const isEditable = readBackendFlag(item.isEditable)
  const isShow = readBackendFlag(item.isShow)
  const relatedDict = readList(item.relatedDict, readDictionaryValue)
  const relatedMeta = readRelatedMeta(item.relatedTrans)
  return {
    relatedMetaAttr,
    ...alias === undefined ? {} : { alias },
    ...isRequired === undefined ? {} : { isRequired },
    ...isEditable === undefined ? {} : { isEditable },
    ...isShow === undefined ? {} : { isShow },
    ...relatedDict.length === 0 ? {} : { relatedDict },
    ...relatedMeta === undefined ? {} : { relatedMeta },
  }
}

/**
 * Read every attribute one scheme's forms draw.
 *
 * A stored scheme keeps its items in groups, each a section of the form a
 * person fills in. The groups are a layout this seam does not publish, so their
 * items are read into one list in the order the scheme lists them.
 * @param form - the scheme's form groups, as the answer carries them.
 * @returns the items, empty where the scheme draws none.
 */
function readSchemeFormItems(form: unknown): readonly BizSchemeFormItem[] {
  if (!Array.isArray(form)) return []
  const items: BizSchemeFormItem[] = []
  for (const group of form as readonly unknown[]) {
    if (typeof group !== 'object' || group === null) continue
    items.push(...readList((group as { formItems?: unknown }).formItems, readSchemeFormItem))
  }
  return items
}

/**
 * Reduce one stored scheme to its kind, the attributes it draws, and the
 * columns it lists.
 * @param entry - one element of the schemes answer.
 * @returns the scheme, or `undefined` when the element states no kind.
 */
function readScheme(entry: unknown): BizScheme | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const item = entry as { schemaType?: unknown; form?: unknown; grid?: unknown }
  if (typeof item.schemaType !== 'number') return undefined
  return {
    schemaType: item.schemaType,
    formItems: readSchemeFormItems(item.form),
    columns: readGridColumns(item.grid),
  }
}

/**
 * Read the scheme list out of one all-schemes answer.
 *
 * A model with no stored scheme of a kind is an ordinary state of this
 * deployment — the frontend turns its own buttons off over it — so an empty
 * list is an answer rather than a failure. An answer that is not a list at all
 * is not this endpoint's, and stays unreadable.
 * @param data - the envelope's payload.
 * @returns the schemes, or `undefined` when the payload is not a scheme list.
 */
function readSchemes(data: unknown): readonly BizScheme[] | undefined {
  return Array.isArray(data) ? readList(data, readScheme) : undefined
}

/**
 * Reduce one catalog entry to the names and the filing this seam publishes.
 *
 * The catalog answers with every model's whole description attached, most of it
 * empty in a listing, and none of it is read: reducing here is what keeps a
 * catalog of over a thousand models from being carried around as the megabytes
 * it arrives as.
 * @param entry - one element of the catalog answer.
 * @returns the model, or `undefined` when the element carries no English name.
 */
function readModelSummary(entry: unknown): BizModelSummary | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const item = entry as Record<string, unknown>
  const resClassEnName = readText(item.resClassEnName)
  if (resClassEnName === undefined) return undefined
  return {
    resClassEnName,
    resClassCnName: readText(item.resClassCnName) ?? '',
    ...readTextFields(item, SUMMARY_TEXT_KEYS),
  }
}

/**
 * Read the model list out of one catalog answer.
 *
 * An empty list is an answer: this endpoint answers that way for the resource
 * kinds a deployment stores no rows of.
 * @param data - the envelope's payload.
 * @returns the models, or `undefined` when the payload is not a model list.
 */
function readModelList(data: unknown): readonly BizModelSummary[] | undefined {
  return Array.isArray(data) ? readList(data, readModelSummary) : undefined
}

/**
 * Reduce one rights row to the model it is about and the operations it grants.
 *
 * The row is read key by key rather than against a fixed list of operations,
 * because the deployment grows the table by adding a key: a fixed list would
 * drop a later operation without saying so.
 * @param entry - one element of the rights table.
 * @returns the row, or `undefined` when the element names no model.
 */
function readModelRights(entry: unknown): BizModelRights | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const item = entry as Record<string, unknown>
  const resclassenname = readText(item.resclassenname)
  if (resclassenname === undefined) return undefined
  const operations: string[] = []
  for (const key of Object.keys(item)) {
    if (RIGHTS_NON_OPERATION_KEYS.has(key)) continue
    if (readBackendFlag(item[key]) === true) operations.push(key)
  }
  // By code unit rather than by locale, so one rights row reduces to the same
  // order on every host. The keys of one object are distinct, so no comparison
  // here is ever between two equal names.
  operations.sort((left, right) => left < right ? -1 : 1)
  const columns = readText(item.columns)
  return { resclassenname, operations, ...columns === undefined ? {} : { columns } }
}

/**
 * Reduce one value narrowing to the attribute it applies to and what it leaves.
 * @param entry - one element of the narrowing table.
 * @returns the narrowing, or `undefined` when the element carries neither field.
 */
function readRowRight(entry: unknown): BizRowRight | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const item = entry as { resourceName?: unknown; resourceValue?: unknown }
  const resourceName = readText(item.resourceName)
  const resourceValue = readText(item.resourceValue)
  if (resourceName === undefined || resourceValue === undefined) return undefined
  return { resourceName, resourceValue }
}

/**
 * Read the signed-in person's rights out of one sign-on answer.
 *
 * Only the rights subtree is reached, and only its two tables are read out of
 * it. The profile beside it — account name, employee number, telephone, mail —
 * is never copied into a published value, so nothing downstream has it to put
 * in front of a model or into a session log.
 * @param data - the envelope's payload.
 * @returns the rights, or `undefined` when the payload carries no rights subtree.
 */
function readUserRights(data: unknown): BizUserRights | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const auth = (data as { auth?: unknown }).auth
  if (typeof auth !== 'object' || auth === null) return undefined
  const table = auth as { resclass?: unknown; rows?: unknown }
  return {
    resclass: readList(table.resclass, readModelRights),
    rows: readList(table.rows, readRowRight),
  }
}

/**
 * Read the column list out of one default-query-scheme answer.
 *
 * The payload is the list of schemes matching the query, and the query names
 * exactly one: the model's default scheme of the resource-list kind. Its first
 * element is therefore the scheme, which is also what the deployment's own
 * frontend reads.
 *
 * A list whose every element names no attribute reads the same as no scheme at
 * all, because both leave a caller with nothing to draw.
 * @param data - the envelope's payload.
 * @returns the columns, or `undefined` when the answer carries no scheme this seam can read columns out of.
 */
function readSchemeColumns(data: unknown): readonly BizSchemeColumn[] | undefined {
  if (!Array.isArray(data)) return undefined
  const [scheme] = data as readonly unknown[]
  if (typeof scheme !== 'object' || scheme === null) return undefined
  const columns = readGridColumns((scheme as { grid?: unknown }).grid)
  return columns.length === 0 ? undefined : columns
}

/**
 * Reduce one described attribute to the two names this seam publishes.
 * @param entry - one element of the description's attribute list.
 * @returns the two names, or `undefined` when the element carries neither.
 */
function readAttribute(entry: unknown): BizMetaAttribute | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const item = entry as Record<string, unknown>
  const { attributeEnName, attributeCnName } = item
  if (typeof attributeEnName !== 'string' || typeof attributeCnName !== 'string') return undefined
  const dataLength = typeof item.dataLength === 'number' ? item.dataLength : undefined
  const isNull = readBackendFlag(item.isNull)
  const isPrimaryKey = readBackendFlag(item.isPrimaryKey)
  return {
    attributeEnName,
    attributeCnName,
    ...readTextFields(item, ATTRIBUTE_TEXT_KEYS),
    ...dataLength === undefined ? {} : { dataLength },
    ...isNull === undefined ? {} : { isNull },
    ...isPrimaryKey === undefined ? {} : { isPrimaryKey },
  }
}

/**
 * Read the attribute list out of one model description.
 *
 * An element that does not carry both names is left out rather than failing the
 * call: the description carries dozens of fields per attribute that this seam
 * never reads, and the two it does read are what a consumer checks its column
 * names against.
 * @param data - the envelope's payload.
 * @returns the attributes, or `undefined` when the payload lists none.
 */
function readAttributes(data: unknown): readonly BizMetaAttribute[] | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const listed = (data as { attributes?: unknown }).attributes
  return Array.isArray(listed) ? readList(listed, readAttribute) : undefined
}

/**
 * `ctx.bizBackend`: the three reads this deployment's data backend serves,
 * performed with the access token its caller holds for the signed-in visitor.
 *
 * Nothing here registers the service: it is constructed by the row that holds
 * the visitor's token, and only when that row was configured with a backend to
 * read. A deployment that configures none installs no such service at all, so a
 * consumer's `ctx.inject(['bizBackend'])` stays pending and Cordis names the
 * missing service, rather than a service that exists and fails every call.
 */
export class BizBackendService extends Service {
  /** Base every request is built onto; validated by the caller and always ending in `/`. */
  private readonly upstream: string

  /** The credential these reads spend, and give up when the backend refuses it. */
  private readonly credential: HeldCredential

  /** How rights become permissions in this deployment. */
  private readonly rules: BizOperationRules

  /**
   * Create and install the service as `ctx.bizBackend`.
   * @param ctx - Cordis context that owns the service.
   * @param upstream - base URL every read is built onto. Required to be an
   * absolute http(s) address with no query string, fragment, or credentials of
   * its own, and a path ending in `/`; the caller validates it at load, because
   * an address rejected here would be rejected once per read instead of once
   * per composition.
   * @param credential - the access token these reads spend.
   * @param rules - how {@link BizBackendService.judge} turns rights into
   * permissions, as the {@link BizOperationRules} schema validated them.
   */
  constructor(ctx: Context, upstream: string, credential: HeldCredential, rules: BizOperationRules) {
    super(ctx, 'bizBackend')
    this.upstream = upstream
    this.credential = credential
    this.rules = rules
  }

  /**
   * Judge one rights read by this deployment's rules.
   *
   * Reaches no network: a caller reads {@link BizBackendService.userRights}
   * once and asks about as many models as it holds. A failed read, and a rights
   * table naming no model, permit nothing.
   * @param rights - what one {@link BizBackendService.userRights} call answered.
   * @returns the permissions that read grants.
   */
  judge(rights: BizUserRights | BizBackendFailure): BizPermissions {
    return judgeRights(rights, this.rules)
  }

  /**
   * Whether a token is held for the signed-in visitor at all.
   *
   * Reading the slot spends nothing and reaches no network, so a consumer that
   * asks a person for permission before reading can find out beforehand that
   * the answer could not be honoured. It promises nothing about the next call:
   * the backend can refuse the token in between, and every call answers
   * `unauthenticated` on its own whether or not anyone asked here.
   * @returns true while a token is held.
   */
  holdsCredential(): boolean {
    return this.credential.read() !== undefined
  }

  /**
   * Read one page of one resource model's rows.
   * @param request - the model to read and how to narrow it.
   * @param signal - aborts the request in flight; an abort answers `unreachable`.
   * @returns the rows, or why there are none.
   */
  async search(request: BizSearchRequest, signal: AbortSignal): Promise<BizSearchResult | BizBackendFailure> {
    const subject = this.subjectFor(request.meta)
    if ('kind' in subject) return subject
    const spec = resolveSearch(
      request,
      subject.meta,
      combineUrls(this.upstream, `${SEARCH_SERVICE_PATH}/${subject.meta}/_search`),
    )
    const answered = await this.exchange(spec.url, {
      method: 'POST',
      headers: { ...credentialHeaders(subject.token), 'content-type': 'application/json' },
      body: JSON.stringify(spec.body),
      signal,
    }, subject.token)
    if (answered.kind !== 'answered') return answered
    const result = readSearchData(answered.data)
    if (result === undefined) return { kind: 'unreachable', detail: 'the answer carried no rows to read' }
    return result
  }

  /**
   * Read one resource model's attribute names, under both of the names the
   * deployment keeps for each.
   * @param meta - the resource model, by its English name.
   * @param signal - aborts the request in flight; an abort answers `unreachable`.
   * @returns the model's attributes, or why they could not be read.
   */
  async describe(meta: string, signal: AbortSignal): Promise<BizMetaResult | BizBackendFailure> {
    const subject = this.subjectFor(meta)
    if ('kind' in subject) return subject
    const answered = await this.exchange(
      combineUrls(this.upstream, `${META_SERVICE_PATH}/${subject.meta}`),
      { method: 'GET', headers: credentialHeaders(subject.token), signal },
      subject.token,
    )
    if (answered.kind !== 'answered') return answered
    const attributes = readAttributes(answered.data)
    if (attributes === undefined) return { kind: 'unreachable', detail: 'the answer listed no attributes' }
    return { attributes }
  }

  /**
   * Read one resource model's default query scheme — the columns this
   * deployment's own resource list opens that model with.
   *
   * The same request the deployment's frontend makes before it draws a resource
   * list: the model's stored schemes, narrowed to the resource-list kind and to
   * the one marked default. A caller that has no column list of its own gets
   * the deployment's own choice of columns and their headers, rather than
   * guessing attribute names.
   * @param meta - the resource model, by its English name.
   * @param signal - aborts the request in flight; an abort answers `unreachable`.
   * @returns the scheme's columns in its own order, or why they could not be read.
   */
  async describeScheme(meta: string, signal: AbortSignal): Promise<BizSchemeResult | BizBackendFailure> {
    const subject = this.subjectFor(meta)
    if ('kind' in subject) return subject
    const query = `?schemaType=${String(QUERY_SCHEME_TYPE)}&metaEnName=${subject.meta}`
      + `&schemaName=&isDefault=${String(DEFAULT_SCHEME_FLAG)}`
    const answered = await this.exchange(
      `${combineUrls(this.upstream, SCHEME_SERVICE_PATH)}${query}`,
      { method: 'GET', headers: credentialHeaders(subject.token), signal },
      subject.token,
    )
    if (answered.kind !== 'answered') return answered
    const columns = readSchemeColumns(answered.data)
    if (columns === undefined) return { kind: 'unreachable', detail: 'the model has no default query scheme' }
    return { columns }
  }

  /**
   * Read this deployment's own catalog of resource models.
   *
   * One request and one answer: this endpoint lists the whole catalog rather
   * than a page of it, so a caller is never left holding part of it and
   * believing it has all of it. Every model's description arrives attached and
   * none of it is kept — {@link BizModelSummary} is the whole of what a caller
   * receives.
   * @param signal - aborts the request in flight; an abort answers `unreachable`.
   * @returns the catalog, or why it could not be read.
   */
  async listModels(signal: AbortSignal): Promise<BizModelListResult | BizBackendFailure> {
    const held = this.credentialFor()
    if (typeof held !== 'string') return held
    const query = `?resClassCnName=&resClassType=${String(STORED_RESOURCE_CLASS_TYPE)}`
    const answered = await this.exchange(
      `${combineUrls(this.upstream, MODEL_LIST_SERVICE_PATH)}${query}`,
      { method: 'GET', headers: credentialHeaders(held), signal },
      held,
    )
    if (answered.kind !== 'answered') return answered
    const models = readModelList(answered.data)
    if (models === undefined) return { kind: 'unreachable', detail: 'the answer listed no resource models' }
    return { models }
  }

  /**
   * Read one resource model's stored default schemes — the forms and the table
   * this deployment's own pages open that model with.
   *
   * The request always names the model. The same endpoint answers with every
   * scheme this deployment stores when it is asked without one, which is tens
   * of megabytes and no caller's question.
   * @param meta - the resource model, by its English name.
   * @param signal - aborts the request in flight; an abort answers `unreachable`.
   * @returns the model's default schemes, or why they could not be read.
   */
  async describeSchemes(meta: string, signal: AbortSignal): Promise<BizModelSchemes | BizBackendFailure> {
    const subject = this.subjectFor(meta)
    if ('kind' in subject) return subject
    const query = `?schemaType=&metaEnName=${subject.meta}&schemaName=&isDefault=${String(DEFAULT_SCHEME_FLAG)}`
    const answered = await this.exchange(
      `${combineUrls(this.upstream, SCHEME_SERVICE_PATH)}${query}`,
      { method: 'GET', headers: credentialHeaders(subject.token), signal },
      subject.token,
    )
    if (answered.kind !== 'answered') return answered
    const schemes = readSchemes(answered.data)
    if (schemes === undefined) return { kind: 'unreachable', detail: 'the answer listed no schemes' }
    return { schemes }
  }

  /**
   * Read what the signed-in person may do in this deployment.
   *
   * The endpoint also answers with that person's profile. This read never
   * copies it: {@link BizUserRights} is built out of the rights subtree alone,
   * so no account name, employee number, telephone or mail address leaves this
   * seam for a caller to put in front of a model or into a session log.
   * @param signal - aborts the request in flight; an abort answers `unreachable`.
   * @returns the rights, or why they could not be read.
   */
  async userRights(signal: AbortSignal): Promise<BizUserRights | BizBackendFailure> {
    const held = this.credentialFor()
    if (typeof held !== 'string') return held
    const answered = await this.exchange(
      combineUrls(this.upstream, RIGHTS_SERVICE_PATH),
      { method: 'GET', headers: credentialHeaders(held), signal },
      held,
    )
    if (answered.kind !== 'answered') return answered
    const rights = readUserRights(answered.data)
    if (rights === undefined) return { kind: 'unreachable', detail: 'the answer carried no rights table' }
    return rights
  }

  /**
   * The credential a call spends, or why it spends none.
   * @returns the token, or the failure a call with no token answers.
   */
  private credentialFor(): string | BizBackendFailure {
    return this.credential.read() ?? { kind: 'unauthenticated' }
  }

  /**
   * Everything a call needs before it may spend the credential.
   * @param meta - the model name the call names.
   * @returns the token and the checked name, or why the call stops here.
   */
  private subjectFor(meta: string): BizCallSubject | BizBackendFailure {
    const token = this.credentialFor()
    if (typeof token !== 'string') return token
    if (!MODEL_NAME.test(meta)) {
      return {
        kind: 'unreachable',
        detail: `"${reportable(meta, token, MAX_DETAIL_CHARS)}" is not a resource model name, so nothing was requested`,
      }
    }
    return { token, meta }
  }

  /**
   * Perform one request and classify its answer.
   *
   * The backend answers a refused request with HTTP 200 and a non-zero code in
   * its envelope, which is why the code is read rather than the status alone: a
   * consumer trusting the status would treat a refusal as data.
   *
   * Two answers mean the credential itself no longer counts, and both give it
   * up here so the process stops presenting a token this backend has already
   * refused: HTTP 401 whatever the body says, and any failing status carrying
   * one of {@link CREDENTIAL_REFUSAL_CODES}. HTTP 403 is neither on its own —
   * the deployment's own client reads it as this request being refused access
   * and keeps its stored token — so a 403 is classified from its envelope like
   * any other failing status, which is also what makes a 403 carrying one of
   * those codes a refused credential.
   * @param url - the absolute address.
   * @param init - method, headers, body, and abort signal.
   * @param presented - the credential this request carried, so a message
   * repeating it can have it taken back out.
   * @returns the envelope's payload, or the failure it classified as.
   */
  private async exchange(url: string, init: RequestInit, presented: string): Promise<BizExchange> {
    let response: Response
    try {
      response = await fetch(url, init)
    } catch (error) {
      return { kind: 'unreachable', detail: reportable(String(error), presented, MAX_DETAIL_CHARS) }
    }
    if (response.status === 401) {
      this.credential.drop('refused-by-backend')
      return { kind: 'refused', status: 401 }
    }
    let body: string
    try {
      body = await response.text()
    } catch (error) {
      return { kind: 'unreachable', detail: reportable(String(error), presented, MAX_DETAIL_CHARS) }
    }
    const envelope = decodeEnvelope(body)
    const code = envelopeCode(envelope)
    if (code === undefined) {
      return {
        kind: 'unreachable',
        detail: `the HTTP ${String(response.status)} answer was not this backend's envelope`,
      }
    }
    if (!response.ok && CREDENTIAL_REFUSAL_CODES.includes(code)) {
      this.credential.drop('refused-by-backend')
      return { kind: 'refused', status: response.status }
    }
    if (code !== 0) {
      const message = envelopeMessage(envelope, presented)
      return {
        kind: 'rejected',
        status: response.status,
        code,
        ...message === undefined ? {} : { message },
      }
    }
    return { kind: 'answered', data: envelopeData(envelope) }
  }
}
