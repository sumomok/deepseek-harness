/**
 * A stand-in for this deployment's backend, answering the vendored crud kit's
 * request layer under jsdom: the visitor's profile, each table's schemes and
 * dictionary, every query's rows, per table, and the batch writes each table's
 * own controls make.
 *
 * It replaces `XMLHttpRequest`, which is what that layer uses under jsdom, so a
 * spec installs {@link StubRequest} with `vi.stubGlobal` and defines the tables
 * its blocks open with {@link defineTable}. The profile grants every defined
 * table unless a case answers it otherwise through {@link answers}. Nothing
 * here reaches a network.
 *
 * The request layer caches a table's schemes and the visitor's profile across
 * mounts, so a case that needs a fresh scheme opens a table of its own.
 */
import { vi } from 'vitest'

/** The token the page carries, the way this deployment's login page leaves one. */
export const STORED_TOKEN = 'Bearer aGVhZGVy.eyJzdWIiOiJ1LTEifQ.c2ln'

/** One table the stub serves. */
export interface StubTable {
  /** The columns of the table's query scheme. */
  readonly gridItems: readonly Readonly<Record<string, unknown>>[]
  /** The items of the table's query, add and modify forms alike. */
  readonly formItems: readonly Readonly<Record<string, unknown>>[]
  /**
   * The items of the table's add form alone, where a case needs the add form to
   * differ from the query and modify ones — a deployment requires a column in
   * the add form that its query panel merely filters by, and the required flag
   * is what the block validates a save against.
   */
  readonly addFormItems?: readonly Readonly<Record<string, unknown>>[]
  /** The rows every query is answered with. */
  readonly rows: readonly Readonly<Record<string, unknown>>[]
  /**
   * What each row's relation columns refer to, by position, as a query
   * answer's `ref` carries it: the page draws a relation link only in a cell
   * whose entry here names the related table. None where absent.
   */
  readonly refs?: readonly Readonly<Record<string, string>>[]
  /**
   * The columns the profile this stub answers grants the table's modify forms,
   * which is where the page reads what the visitor may change; every other
   * field of those forms is drawn read-only. None where absent.
   */
  readonly modifiableColumns?: readonly string[]
}

/** Every table the stub serves, by name. */
const tables = new Map<string, StubTable>()

/**
 * Serve one table.
 * @param meta - the table's name in the backend.
 * @param table - its schemes and rows.
 */
export function defineTable(meta: string, table: StubTable): void {
  tables.set(meta, table)
}

/** What a case answers the profile request with, where it needs something other than a profile granting every table. */
export const answers: { userInfo: [number, unknown] | undefined } = { userInfo: undefined }

/** One request the stub answered. */
export interface Seen {
  /** The request method. */
  readonly method: string
  /** The request URL, query included. */
  readonly url: string
  /** The `Authorization` header it carried. */
  readonly authorization: string | undefined
  /** The body the request carried as JSON text, empty where it carried none. */
  readonly body: string
}

/** Every request the stub answered, in order; a spec resets it per case. */
export const seen: Seen[] = []

/**
 * One scheme row of the kind the page asks for.
 * @param meta - the table.
 * @param table - its schemes.
 * @param schemaType - 1 query, 2 add, 3 modify.
 * @returns the row.
 */
function schemeRow(meta: string, table: StubTable, schemaType: number): Record<string, unknown> {
  const formItems = schemaType === 2 ? table.addFormItems ?? table.formItems : table.formItems
  return {
    schemaType,
    isDefault: 1,
    schemaEnName: `${meta}_${schemaType}`,
    metaAlias: '演示设备',
    metaEnName: meta,
    contentType: 'normal',
    form: [{ formType: 'normal', labelWidth: '100px', formItems }],
    grid: { gridItems: table.gridItems },
  }
}

/**
 * Answer a row's delete or a batch edit: the kit writes one item per record and
 * names each written record from the `rawValue` the answer carries back, so the
 * answer carries back the request's own items.
 * @param body - the write's body as JSON text.
 * @returns the status and the body.
 */
function answerBatchWrite(body: string): [number, unknown] {
  const sent = JSON.parse(body) as { readonly resObjList: readonly { readonly rawValue: unknown }[] }
  const resObjList = sent.resObjList.map(item => ({ rawValue: item.rawValue }))
  return [200, { code: 0, data: { resObjList, globalFailedInfo: null } }]
}

/**
 * Answer one request the way the deployment's backend does.
 * @param method - the request method.
 * @param url - the request URL, query included.
 * @param body - the body the request carried as JSON text.
 * @returns the status and the body.
 */
function route(method: string, url: string, body: string): [number, unknown] {
  const [path = '', query = ''] = url.split('?')
  const params = new URLSearchParams(query)
  if (path.endsWith('/nrms-auth/api/auth/userinfo')) {
    if (answers.userInfo !== undefined) return answers.userInfo
    const resclass = [...tables].map(([meta, table]) => ({
      resclassenname: meta, search: 1, add: 1, update: 1, delete: 1, imp: 1, exp: 1,
      gridexp: 1, searchSetting: 1, advSearch: 1, showAsPass: 0, columns: table.modifiableColumns ?? [],
    }))
    return [200, { code: 0, data: { useraccount: 'probe', username: '探针用户', auth: { resclass } } }]
  }
  if (path.endsWith('/nrms-schema-manage/api/schema/schema')) {
    const meta = params.get('metaEnName') ?? ''
    const table = tables.get(meta)
    if (table === undefined) return [200, { code: 0, data: [] }]
    const asked = Number(params.get('schemaType'))
    const types = asked > 0 ? [asked] : [1, 2, 3]
    return [200, { code: 0, data: types.map(type => schemeRow(meta, table, type)) }]
  }
  const dictionary = /\/nrms-schema-manage\/api\/meta\/resclass\/([^/]+)/.exec(path)
  if (dictionary !== null) {
    const meta = dictionary[1] ?? ''
    const attrs = (tables.get(meta)?.gridItems ?? [])
      .map(item => ({ relatedMetaAttr: item['relatedMetaAttr'], alias: item['alias'], dataType: 'string' }))
    return [200, { code: 0, data: { metaEnName: meta, metaAlias: '演示设备', attrs } }]
  }
  const search = /\/nrms-datamanagement\/api\/resources\/([^/]+)\/_search$/.exec(path)
  if (method === 'POST' && search !== null) {
    const table = tables.get(search[1] ?? '')
    const rows = table?.rows ?? []
    const page = { total: rows.length, currentPage: 1, pageSize: 20 }
    return [200, { code: 0, data: { rawValue: rows, displayValue: rows, ref: table?.refs ?? [], page } }]
  }
  if (method === 'POST' && /\/nrms-datamanagement\/api\/batchresources\/delete\/[^/?]+$/.test(path)) return answerBatchWrite(body)
  if (method === 'PUT' && /\/nrms-datamanagement\/api\/batchresources\/[^/?]+$/.test(path)) return answerBatchWrite(body)
  return [200, { code: 0, data: null }]
}

/** The stub the kit's request layer talks to under jsdom. */
export class StubRequest {
  readyState = 0
  status = 0
  responseText = ''
  response = ''
  timeout = 0
  withCredentials = false
  responseType = ''
  onreadystatechange: (() => void) | null = null
  onload: (() => void) | null = null
  upload = { addEventListener: (): void => {} }
  private method = ''
  private url = ''
  private readonly headers: Record<string, string> = {}
  private readonly listeners: Record<string, (() => void)[]> = {}

  open(method: string, url: string): void {
    this.method = method
    this.url = url
    this.readyState = 1
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value
  }

  getAllResponseHeaders(): string {
    return 'content-type: application/json\r\n'
  }

  addEventListener(type: string, listener: () => void): void {
    (this.listeners[type] ??= []).push(listener)
  }

  removeEventListener(): void {}

  abort(): void {}

  send(body: string | null = null): void {
    const text = body ?? ''
    seen.push({ method: this.method, url: this.url, authorization: this.headers['authorization'], body: text })
    const [status, answer] = route(this.method, this.url, text)
    setTimeout(() => {
      this.readyState = 4
      this.status = status
      this.responseText = JSON.stringify(answer)
      this.response = this.responseText
      this.onreadystatechange?.()
      this.onload?.()
      for (const listener of this.listeners['load'] ?? []) listener()
      for (const listener of this.listeners['loadend'] ?? []) listener()
    }, 0)
  }
}

/**
 * Let Vue and the stub backend finish one round.
 * @returns a promise settling after the queued timers.
 */
export function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 20) })
}

/**
 * Wait until the stub backend has been quiet for three rounds, or forty rounds
 * have passed, whichever comes first.
 * @returns a promise settling once nothing new has been requested.
 */
export async function drain(): Promise<void> {
  let quiet = 0
  for (let round = 0; round < 40 && quiet < 3; round += 1) {
    const before = seen.length
    await flush()
    quiet = seen.length === before ? quiet + 1 : 0
  }
}

/**
 * Wait until the request layer's progress bar has finished.
 *
 * nprogress ends a bar on two timers after the last request answers — a fade,
 * then the removal — and both reach for `document`, drawing the bar again
 * wherever its parent selector now points. A bar a case leaves fading is
 * therefore drawn on the body of the next case once the block it was contained
 * in is gone, and one left fading at the end of a file runs after jsdom is torn
 * down and throws there. The bar marks the document element `nprogress-busy`
 * while it is drawn, and the removal clears the mark.
 * @returns a promise settling once no bar is drawn.
 */
export async function settleProgress(): Promise<void> {
  await vi.waitFor(() => {
    if (document.documentElement.classList.contains('nprogress-busy')) throw new Error('a progress bar is still fading out')
  }, { timeout: 3000, interval: 20 })
}
