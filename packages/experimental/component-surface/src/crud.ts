/**
 * `toy.crud` on the host: the question the user is asked before the
 * deployment's own data page opens in the panel, every sentence the model is
 * refused or answered with about it, and the table of calls waiting for the
 * page to say which columns it loaded.
 *
 * Pure but for that table. The requests — the approval, the record, the wait —
 * are `tool.ts`'s, and the report that settles a wait arrives through
 * `command.ts`, off the same `/component-action` line every other gesture
 * takes. Nothing here reaches a backend: the page reads its table with the
 * user's own credential from the browser, and the host reads nothing for this
 * kind. What the host does is ask, record, and wait to be told.
 *
 * Host-only, like `data-source.ts`, and for the same reason: the browser seat
 * draws the block out of the record the tool appends once the user has
 * answered, and nothing about the question survives into that record.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/crud
 */

import type { Session } from '@deepseek-ai/dsh-session'
import {
  COMPONENT_CATALOG,
  CRUD_ID,
  crudColumnPhrase,
  crudMeta,
  crudNodes,
  MAX_CRUD_REPORTED_COLUMNS,
  SHOW_COMPONENT_TOOL_NAME,
  type ComponentNode,
  type ComponentSpec,
  type CrudColumn,
} from './component-call.ts'
import { refuse, type ComponentCallFailure } from './validate.ts'

/**
 * One column a loaded data page reported, as the seat read it off the page's
 * own scheme. The catalog's own reading of the same payload, so a column named
 * in a result line and a column named in a notice are the same value read the
 * same way.
 */
export type CrudLoadColumn = CrudColumn

/** What one loaded data page reported: the table it loaded, and the columns it shows. */
export interface CrudLoadReport {
  /** The table, by its name in the backend. */
  readonly meta: string
  /** The first {@link MAX_CRUD_REPORTED_COLUMNS} drawn columns, in the page's own order. */
  readonly columns: readonly CrudLoadColumn[]
  /** How many columns the page draws in all. */
  readonly total: number
}

/** What one waiting call is answered with, once its page reports or its deadline passes. */
type LoadWaiter = (report: CrudLoadReport | undefined) => void

/**
 * The calls waiting for their data page to report what it loaded.
 *
 * Two keys, and both are load-bearing. The outer one is the session, held
 * weakly the way `ActionMemory` holds its agent: one plugin instance serves
 * every session a console runs, and an entry id is a string the model chose,
 * so `layers` in one conversation and `layers` in another are the same string
 * and different pages. Keyed by entry id alone, a browser reporting its own
 * page would settle a stranger's call with a stranger's column names and leave
 * its own user's notice undelivered. The inner one is the content entry rather
 * than the call, because the report is a gesture off the seat, which knows the
 * entry it drew and not the call that placed it.
 *
 * Within one session an entry id may still be waited on twice — the tool
 * supports replacing an entry by calling again with the same id — so a later
 * call's waiter replaces the earlier one, and each call removes only its own:
 * a `finally` that deleted the key outright would delete the replacement and
 * leave the live call waiting out its whole deadline for a report that had
 * nowhere to go.
 *
 * Settlement is single-shot, exactly as for a chart's verdict: the entry is
 * removed before its waiter is resolved, so a second report for the same
 * entry, a report after the deadline, and a report for an entry no call is
 * waiting on all take the ordinary path — a notice in the agent's inbox.
 */
export class PendingLoads {
  private readonly waiting = new WeakMap<Session, Map<string, LoadWaiter>>()

  /**
   * The table one session's waiting calls share, opened where the session has none.
   * @param session - the session the call and the report both belong to.
   * @returns that session's table.
   */
  private tableOf(session: Session): Map<string, LoadWaiter> {
    const held = this.waiting.get(session)
    if (held !== undefined) return held
    const opened = new Map<string, LoadWaiter>()
    this.waiting.set(session, opened)
    return opened
  }

  /**
   * Wait for one entry's page to report its columns.
   * @param session - the session the call runs in; only a report from this session settles it.
   * @param entryId - the content entry the call owns.
   * @param timeoutMs - how long a browser has to load the page before the call answers without its columns.
   * @param signal - the execution's cancellation; an abort ends the wait like a timeout.
   * @returns the report, or `undefined` when none arrived in time.
   */
  async settle(session: Session, entryId: string, timeoutMs: number, signal: AbortSignal): Promise<CrudLoadReport | undefined> {
    const table = this.tableOf(session)
    // One deadline for both ways this wait can end without an answer, so there
    // is a single settlement point rather than a timer racing a listener.
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    let own: LoadWaiter | undefined
    try {
      return await new Promise<CrudLoadReport | undefined>((resolve) => {
        if (deadline.aborted) {
          resolve(undefined)
          return
        }
        own = resolve
        table.set(entryId, resolve)
        deadline.addEventListener('abort', () => { resolve(undefined) }, { once: true })
      })
    } finally {
      if (own !== undefined && table.get(entryId) === own) table.delete(entryId)
    }
  }

  /**
   * Hand one page's report to the call waiting for it.
   * @param session - the session whose seat reported; a call in another session is not settled by it.
   * @param entryId - the content entry the page was drawn in.
   * @param report - what the page loaded.
   * @returns whether a waiting call took it; `false` leaves the report to be delivered as a notice.
   */
  report(session: Session, entryId: string, report: CrudLoadReport): boolean {
    const table = this.waiting.get(session)
    const resolve = table?.get(entryId)
    if (table === undefined || resolve === undefined) return false
    table.delete(entryId)
    resolve(report)
    return true
  }
}

/** The metaLabel one data page block carries, as validation accepted it. */
function crudLabel(node: ComponentNode): string {
  return node.props['metaLabel'] as string
}

/** How many hidden conditions one data page block narrows its table by. */
function crudConditionCount(node: ComponentNode): number {
  const conditions = node.props['conditions'] as readonly unknown[] | undefined
  return conditions?.length ?? 0
}

/**
 * Build the sentence the user is asked before the page opens.
 *
 * In the register of the data-source card, and true of what this block does:
 * the page is the user's to query, and what reaches the agent is column names,
 * counts, and the one row they click. A hidden condition is counted, never
 * shown — its value is the model's text, and the page itself draws none of it.
 * The table's own name in the backend is written on a line of its own, the way
 * a `dataSource` card writes it and for the same reason: a person who wants to
 * check what was asked for has the identifier, and a person who does not never
 * reads a term. The panel draws that break rather than collapsing it, so the
 * identifier stands on a line of its own at the same size as the sentence above
 * it; what this function owes is the same wording and the same ordering the
 * read's card has.
 * @param node - the data page block, as validation accepted it.
 * @returns the card's text.
 */
export function crudApprovalReason(node: ComponentNode): string {
  const conditions = crudConditionCount(node)
  const narrowed = conditions === 0 ? '' : `，预设了 ${conditions} 个筛选条件`
  return `用您的账号打开「${crudLabel(node)}」的完整数据页，可以在里面查询、翻页、排序${narrowed}；`
    + '小助手看不到表里的内容，只会知道有哪些列、每次查到多少条，以及您点到的那一行。'
    + `\n数据表：${crudMeta(node)}`
}

/** Refusal for a call with no session behind it: nothing can be asked, and nothing can be recorded. */
export const CRUD_NO_SESSION
  = `${SHOW_COMPONENT_TOOL_NAME}: this call is not running in a session, so the user could not be asked to open the `
    + 'data page. Nothing on the panel changed.'

/**
 * Refusal for a page the user did not allow.
 *
 * One sentence for every way the question can end other than a grant, because
 * the three are one thing from where the model is sitting: the page does not
 * open, and why is the user's business.
 */
export const CRUD_NOT_APPROVED
  = `${SHOW_COMPONENT_TOOL_NAME}: the user did not open the data page, so nothing was drawn. Nothing on the panel changed.`

/**
 * Refusal for a data page a deployment does not offer.
 *
 * The one refusal every path that meets a page has to reach first, because a
 * deployment that does not offer the page cannot open it for any other reason
 * either: telling the model to move the page into a call of its own would send
 * it to write a second call this deployment refuses in the same words.
 * @param spec - the spec, as validation accepted it, carrying at least one data page.
 * @returns the refusal, naming the first page and the components this deployment does offer.
 */
export function crudNotOffered(spec: ComponentSpec): ComponentCallFailure {
  const first = crudNodes(spec)[0] as ComponentNode
  const others = COMPONENT_CATALOG.map(entry => entry.id).filter(id => id !== CRUD_ID).join(', ')
  return refuse(
    `spec.nodes[${spec.nodes.indexOf(first)}].component`,
    `names ${CRUD_ID}, which this deployment does not offer. Offered components: ${others}.`,
  )
}

/**
 * Judge the data page blocks of one accepted call, before anything is asked.
 *
 * Three things end a call here, each named by the path the model has to fix.
 * A deployment that does not offer the page refuses it by name, with the
 * components it does offer. A second page in one call is refused, because a
 * call asks one question and a page is a whole table's worth of screen. A sort
 * naming both directions is refused the way a `dataSource` sort is.
 * @param spec - the spec, as validation accepted it.
 * @param offered - whether this deployment offers the data page at all.
 * @returns the refusal, or `undefined` when the call may proceed to the question.
 */
export function judgeCrudNodes(spec: ComponentSpec, offered: boolean): ComponentCallFailure | undefined {
  const pages = crudNodes(spec)
  const first = pages[0]
  if (first === undefined) return undefined
  if (!offered) return crudNotOffered(spec)
  const second = pages[1]
  if (second !== undefined) {
    return refuse(
      `spec.nodes[${spec.nodes.indexOf(second)}]`,
      `places a second ${CRUD_ID} block. A call opens one data page; place another in a call of its own.`,
    )
  }
  const sort = first.props['querySort'] as { readonly asc?: string; readonly desc?: string } | undefined
  if (sort?.asc !== undefined && sort.desc !== undefined) {
    return refuse(
      `spec.nodes[${spec.nodes.indexOf(first)}].props.querySort.desc`,
      'cannot be sent beside asc. Sort by one attribute, in one direction.',
    )
  }
  return undefined
}

/**
 * Refusal for a data page placed by the same call that reads a `dataSource`.
 * @param spec - the spec, as validation accepted it, carrying at least one data page.
 * @returns the refusal, naming the first page.
 */
export function crudBesideDataSource(spec: ComponentSpec): ComponentCallFailure {
  const first = crudNodes(spec)[0] as ComponentNode
  return refuse(
    `spec.nodes[${spec.nodes.indexOf(first)}]`,
    `places a ${CRUD_ID} block, which cannot be sent beside dataSource. Open the data page in a call of its own.`,
  )
}

/**
 * The sentence added to an accepted call's line once its page has reported.
 * @param node - the data page block, as validation accepted it.
 * @param report - what the page loaded.
 * @returns the sentence, with a leading space.
 */
export function crudLoadedText(node: ComponentNode, report: CrudLoadReport): string {
  const rest = report.total > report.columns.length ? ` and ${report.total - report.columns.length} more` : ''
  const columns = report.columns.length === 0
    ? 'no columns'
    : `${report.total} column${report.total === 1 ? '' : 's'}: ${report.columns.map(crudColumnPhrase).join(', ')}${rest}`
  return ` The user opened the data page of "${crudMeta(node)}" in block "${node.id}" with their own credential; it has `
    + `loaded and shows ${columns}. What the user queries in it stays in the panel; each query's row count and the `
    + 'cell they click come back to you.'
}

/**
 * The sentence added to an accepted call's line when no browser reported the
 * page within the deadline.
 *
 * It says what will still happen — the columns and every count reach the
 * agent as notices once the page has loaded — so a model is not tempted to
 * place the page a second time, which would ask the user the same question
 * again.
 * @param node - the data page block, as validation accepted it.
 * @param timeoutMs - the deadline that passed.
 * @returns the sentence, with a leading space.
 */
export function crudUnreportedText(node: ComponentNode, timeoutMs: number): string {
  return ` The user opened the data page of "${crudMeta(node)}" in block "${node.id}" with their own credential; no `
    + `client reported its columns within ${timeoutMs / 1000}s. The page loads when the user views it, and its `
    + `first ${MAX_CRUD_REPORTED_COLUMNS} columns, each query's row count and the cell they click then reach you as `
    + 'notices — do not place it again because of this.'
}
