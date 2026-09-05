/**
 * @deepseek-ai/dsh-experimental-biz-backend — reading this deployment's own
 * data backend with the access token of the person using it.
 *
 * Host-only, and it holds no credential of its own: whoever installs the
 * service passes the token in by reference, which in this fork is the sign-on
 * gate that took it from the visitor's browser. The two reads below are the
 * same two requests the deployment's own web page makes when a person opens a
 * resource list, minus the three the page adds for itself: no cache-busting
 * query parameter (nothing here caches), no expansion of the browser's stored
 * profile into request headers, and no activity record posted afterwards —
 * writing one would put an operation into the deployment's audit trail that its
 * user never performed.
 *
 * A capability, not a pipe. The same URL prefix also carries
 * `PUT /api/resources/{model}/{id}`, `DELETE /api/resources/{model}/{id}`, and
 * `POST /api/batchresources/delete/{model}`. A general `fetch(path, init)`
 * service would hand every plugin sharing this process the visitor's credential
 * and those endpoints along with it, so the two reads below name what they do
 * and can reach nothing else.
 *
 * Failures are values, never exceptions: every call answers with its result or
 * with one member of {@link BizBackendFailure}, so a consumer switches on the
 * tag and the compiler names the case it forgot.
 * @module @deepseek-ai/dsh-experimental-biz-backend
 */

import { Service, type Context } from '@deepseek-ai/cordis'

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

/** One attribute of a resource model, under both of its names. */
export interface BizMetaAttribute {
  /** The name rows are keyed by. */
  readonly attributeEnName: string
  /** The name the deployment shows a person. */
  readonly attributeCnName: string
}

/** What one model description returned. */
export interface BizMetaResult {
  /** Every attribute the model declares, in the order the backend lists them. */
  readonly attributes: readonly BizMetaAttribute[]
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
 * @param data - the envelope's payload.
 * @returns the result, or `undefined` when the payload is not one this seam reads.
 */
function readSearchData(data: unknown): BizSearchResult | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const payload = data as { rawValue?: unknown; displayValue?: unknown; page?: unknown }
  if (!isRowList(payload.rawValue) || !isRowList(payload.displayValue)) return undefined
  const total = readTotal(payload.page)
  return {
    rawValue: payload.rawValue,
    displayValue: payload.displayValue,
    ...total === undefined ? {} : { total },
  }
}

/**
 * Reduce one described attribute to the two names this seam publishes.
 * @param entry - one element of the description's attribute list.
 * @returns the two names, or `undefined` when the element carries neither.
 */
function readAttribute(entry: unknown): BizMetaAttribute | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const { attributeEnName, attributeCnName } = entry as { attributeEnName?: unknown; attributeCnName?: unknown }
  if (typeof attributeEnName !== 'string' || typeof attributeCnName !== 'string') return undefined
  return { attributeEnName, attributeCnName }
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
  if (!Array.isArray(listed)) return undefined
  const named: BizMetaAttribute[] = []
  for (const entry of listed as readonly unknown[]) {
    const attribute = readAttribute(entry)
    if (attribute !== undefined) named.push(attribute)
  }
  return named
}

/**
 * `ctx.bizBackend`: the two reads this deployment's data backend serves,
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

  /**
   * Create and install the service as `ctx.bizBackend`.
   * @param ctx - Cordis context that owns the service.
   * @param upstream - base URL every read is built onto. Required to be an
   * absolute http(s) address with no query string, fragment, or credentials of
   * its own, and a path ending in `/`; the caller validates it at load, because
   * an address rejected here would be rejected once per read instead of once
   * per composition.
   * @param credential - the access token these reads spend.
   */
  constructor(ctx: Context, upstream: string, credential: HeldCredential) {
    super(ctx, 'bizBackend')
    this.upstream = upstream
    this.credential = credential
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
   * Everything a call needs before it may spend the credential.
   * @param meta - the model name the call names.
   * @returns the token and the checked name, or why the call stops here.
   */
  private subjectFor(meta: string): BizCallSubject | BizBackendFailure {
    const token = this.credential.read()
    if (token === undefined) return { kind: 'unauthenticated' }
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
