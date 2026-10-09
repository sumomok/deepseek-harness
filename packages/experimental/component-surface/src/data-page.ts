/**
 * `toy.data-page` on the host: the question the user is asked before the
 * deployment's own data page opens in the panel, every sentence the model is
 * refused or answered with about it, the table of calls waiting for the page
 * to say which columns it loaded, and the rules a written-down view placing a
 * form page or an info card beside the page is held to.
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
 * @module @deepseek-ai/dsh-experimental-component-surface/src/data-page
 */

import type { Session } from '@deepseek-ai/dsh-session'
import {
  BINDING_KEY,
  catalogEntry,
  DATA_PAGE_EDITING_OUTPUT,
  DATA_PAGE_GATED_IDS,
  DATA_PAGE_ID,
  DATA_PAGE_OPENED_OUTPUT,
  DATA_PAGE_ROW_OPERATIONS,
  DATA_PAGE_TOOLBAR_BUTTONS,
  dataPageColumnPhrase,
  dataPageMeta,
  dataPageNodes,
  FORM_PAGE_ID,
  INFO_CARD_ID,
  MAX_DATA_PAGE_REPORTED_COLUMNS,
  readBinding,
  SHOW_COMPONENT_TOOL_NAME,
  type CatalogId,
  type ComponentCatalog,
  type ComponentCatalogEntry,
  type ComponentNode,
  type ComponentSpec,
  type DataPageColumn,
} from './component-call.ts'
import { refuse, type ComponentCallFailure } from './validate.ts'

/**
 * One column a loaded data page reported, as the seat read it off the page's
 * own scheme. The catalog's own reading of the same payload, so a column named
 * in a result line and a column named in a notice are the same value read the
 * same way.
 */
export type DataPageLoadColumn = DataPageColumn

/** What one loaded data page reported: the table it loaded, the columns it shows, and the rights it resolved. */
export interface DataPageLoadReport {
  /** The table, by its name in the backend. */
  readonly meta: string
  /** The first {@link MAX_DATA_PAGE_REPORTED_COLUMNS} drawn columns, in the page's own order. */
  readonly columns: readonly DataPageLoadColumn[]
  /** How many columns the page draws in all. */
  readonly total: number
  /** The rights this deployment answered with for this user on this table, by the page's own key for each. */
  readonly rights: readonly string[]
}

/** What one waiting call is answered with, once its page reports or its deadline passes. */
type LoadWaiter = (report: DataPageLoadReport | undefined) => void

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
  async settle(session: Session, entryId: string, timeoutMs: number, signal: AbortSignal): Promise<DataPageLoadReport | undefined> {
    const table = this.tableOf(session)
    // One deadline for both ways this wait can end without an answer, so there
    // is a single settlement point rather than a timer racing a listener.
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    let own: LoadWaiter | undefined
    try {
      return await new Promise<DataPageLoadReport | undefined>((resolve) => {
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
  report(session: Session, entryId: string, report: DataPageLoadReport): boolean {
    const table = this.waiting.get(session)
    const resolve = table?.get(entryId)
    if (table === undefined || resolve === undefined) return false
    table.delete(entryId)
    resolve(report)
    return true
  }
}

/** The metaLabel one data page block carries, as validation accepted it. */
function dataPageLabel(node: ComponentNode): string {
  return node.props['metaLabel'] as string
}

/** How many hidden conditions one data page block narrows its table by. */
function dataPageConditionCount(node: ComponentNode): number {
  const conditions = node.props['conditions'] as readonly unknown[] | undefined
  return conditions?.length ?? 0
}

/**
 * Build the sentence the user is asked before the page opens.
 *
 * In the register of the data-source card, and true of what a placed block
 * does: the page is the user's to query, it opens read-only because a call may
 * not ask for anything else, and what reaches the agent is column names,
 * counts, and the rows they point at. A hidden condition is counted, never
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
export function dataPageApprovalReason(node: ComponentNode): string {
  const conditions = dataPageConditionCount(node)
  const narrowed = conditions === 0 ? '' : `，预设了 ${conditions} 个筛选条件`
  return `用您的账号打开「${dataPageLabel(node)}」的完整数据页，可以在里面查询、翻页、排序${narrowed}；`
    + '小助手看不到表里的内容，只会知道有哪些列、每次查到多少条，以及您点到或勾选的那几行。'
    + `\n数据表：${dataPageMeta(node)}`
}

/** Refusal for a call with no session behind it: nothing can be asked, and nothing can be recorded. */
export const DATA_PAGE_NO_SESSION
  = `${SHOW_COMPONENT_TOOL_NAME}: this call is not running in a session, so the user could not be asked to open the `
    + 'data page. Nothing on the panel changed.'

/**
 * Refusal for a page the user did not allow.
 *
 * One sentence for every way the question can end other than a grant, because
 * the three are one thing from where the model is sitting: the page does not
 * open, and why is the user's business.
 */
export const DATA_PAGE_NOT_APPROVED
  = `${SHOW_COMPONENT_TOOL_NAME}: the user did not open the data page, so nothing was drawn. Nothing on the panel changed.`

/**
 * Whether one block names a component this deployment's `dataPage` setting
 * turns on.
 * @param node - the block, as validation accepted it.
 * @returns true for the data page and the two blocks a view places beside one.
 */
function dataPageGated(node: ComponentNode): boolean {
  return DATA_PAGE_GATED_IDS.some(id => id === node.component)
}

/**
 * Refusal for a block naming a component the deployment's `dataPage` setting
 * left off: the data page, or a block a view places beside one.
 *
 * The one refusal every path that meets such a block has to reach first,
 * because a deployment that does not offer the component cannot place it for
 * any other reason either: telling the model to move a page into a call of its
 * own would send it to write a second call this deployment refuses in the same
 * words. The components it lists are the registered ones that setting does not
 * govern.
 * @param catalog - the components this deployment registers.
 * @param spec - the spec, as validation accepted it.
 * @param node - the block refused, one of that spec's nodes.
 * @returns the refusal, naming the block's component and the components this deployment does offer.
 */
export function componentNotOffered(catalog: ComponentCatalog, spec: ComponentSpec, node: ComponentNode): ComponentCallFailure {
  const others = catalog.entries
    .map(entry => entry.id)
    .filter(id => !DATA_PAGE_GATED_IDS.includes(id))
    .join(', ')
  return refuse(
    `spec.nodes[${spec.nodes.indexOf(node)}].component`,
    `names ${node.component}, which this deployment does not offer. Offered components: ${others}.`,
  )
}

/**
 * The first property of one call's data page that only a written-down page may
 * set.
 *
 * The sentence is the catalog's own `viewOnly` declaration rather than one
 * written here: the same declaration keeps the property out of the tool's
 * description, so a model is neither offered it nor refused in different words
 * for sending it.
 * @param catalog - the components this deployment offers.
 * @param spec - the spec, as validation accepted it.
 * @param page - the data page block of that spec.
 * @returns the refusal, or `undefined` when the call set none of them.
 */
function refuseArrangement(
  catalog: ComponentCatalog,
  spec: ComponentSpec,
  page: ComponentNode,
): ComponentCallFailure | undefined {
  // The cast is what validation proved: the node reached here only through
  // this catalog's own entry for its component.
  const declared = (catalogEntry(catalog, page.component) as ComponentCatalogEntry).propsSchema
  const written = Object.entries(declared)
    .find(([name, field]) => field.viewOnly !== undefined && page.props[name] !== undefined)
  if (written === undefined) return undefined
  return refuse(`spec.nodes[${spec.nodes.indexOf(page)}].props.${written[0]}`, written[1].viewOnly as string)
}

/**
 * Judge the data page blocks of one accepted call or view, before anything is
 * asked.
 *
 * Four things end a call here, each named by the path that has to change. A
 * deployment that does not offer the page refuses it by name, with the
 * components it does offer, and refuses a form page or an info card the same
 * way, at whichever of the three the spec places first. A second page in one
 * call is refused, because a call asks one question and a page is a whole
 * table's worth of screen. A sort naming both directions is refused the way a
 * `dataSource` sort is. And a property only a written page may set is refused
 * for a call and accepted for a view, which is the one judgement the two
 * sources do not share: a view is a file a person wrote, and the arrangement in
 * it is that person's.
 * @param catalog - the components this deployment offers.
 * @param spec - the spec, as validation accepted it.
 * @param offered - whether this deployment offers the data page and the two blocks a view places beside one.
 * @param written - whether the spec is a page somebody wrote down, which may carry its own arrangement.
 * @returns the refusal, or `undefined` when the call may proceed to the question.
 */
export function judgeDataPageNodes(
  catalog: ComponentCatalog,
  spec: ComponentSpec,
  offered: boolean,
  written: boolean,
): ComponentCallFailure | undefined {
  if (!offered) {
    const gated = spec.nodes.find(dataPageGated)
    if (gated !== undefined) return componentNotOffered(catalog, spec, gated)
  }
  const pages = dataPageNodes(spec)
  const first = pages[0]
  if (first === undefined) return undefined
  const second = pages[1]
  if (second !== undefined) {
    return refuse(
      `spec.nodes[${spec.nodes.indexOf(second)}]`,
      `places a second ${DATA_PAGE_ID} block. A call opens one data page; place another in a call of its own.`,
    )
  }
  const sort = first.props['querySort'] as { readonly asc?: string; readonly desc?: string } | undefined
  if (sort?.asc !== undefined && sort.desc !== undefined) {
    return refuse(
      `spec.nodes[${spec.nodes.indexOf(first)}].props.querySort.desc`,
      'cannot be sent beside asc. Sort by one attribute, in one direction.',
    )
  }
  return written ? undefined : refuseArrangement(catalog, spec, first)
}

/**
 * Judge every property of one block that declares the one output it reads.
 *
 * The property must be written, must be a binding, and must name that output
 * of a block of the declared component, whole. Validation has already
 * resolved the binding against this spec's own blocks and refused an output
 * whose value the property does not accept; what is left to refuse here is a
 * property left out, a value written out, and a binding to the right kind of
 * value on the wrong block.
 * @param catalog - the components this deployment offers.
 * @param spec - the spec, as validation accepted it.
 * @param node - one block of that spec.
 * @returns the refusal of the first such property, or `undefined` when every one reads its output.
 */
function judgeSourcedProps(catalog: ComponentCatalog, spec: ComponentSpec, node: ComponentNode): ComponentCallFailure | undefined {
  // The cast is what validation proved: the node reached here only through
  // this catalog's own entry for its component.
  const declared = (catalogEntry(catalog, node.component) as ComponentCatalogEntry).propsSchema
  const at = `spec.nodes[${spec.nodes.indexOf(node)}].props`
  for (const [name, field] of Object.entries(declared)) {
    const source = field.bindsFrom
    if (source === undefined) continue
    const value = node.props[name]
    if (value === undefined) return refuse(`${at}.${name}`, `is required in a view: ${source.reason}`)
    const binding = readBinding(value)
    if (binding === undefined) {
      return refuse(
        `${at}.${name}`,
        `must read ${source.output} of a ${source.component} block of this view, written `
        + `{"${BINDING_KEY}": "node:<that block's id>.${source.output}"}: ${source.reason}`,
      )
    }
    // Validation resolved the reference against this spec's own blocks.
    const read = spec.nodes.find(one => one.id === binding.sourceId) as ComponentNode
    if (read.component !== source.component || binding.outputId !== source.output || binding.index !== undefined) {
      const item = binding.index === undefined ? '' : `[${binding.index}]`
      return refuse(
        `${at}.${name}.${BINDING_KEY}`,
        `reads ${binding.outputId}${item} of "${binding.sourceId}"; this property reads ${source.output} of a `
        + `${source.component} block and nothing else: ${source.reason}`,
      )
    }
  }
  return undefined
}

/**
 * Refusal for the second block of one component reading one output of the page.
 * @param spec - the spec, as validation accepted it.
 * @param page - the data page every such block reads.
 * @param component - the component of the blocks counted.
 * @param output - the output of the page they read.
 * @param consequence - what two of them would do on screen.
 * @returns the refusal at the second such block, or `undefined` when the spec places at most one.
 */
function secondReader(
  spec: ComponentSpec,
  page: ComponentNode,
  component: CatalogId,
  output: string,
  consequence: string,
): ComponentCallFailure | undefined {
  const second = spec.nodes.filter(node => node.component === component)[1]
  if (second === undefined) return undefined
  return refuse(`spec.nodes[${spec.nodes.indexOf(second)}]`, `is a second ${component} reading ${output} of "${page.id}": ${consequence}`)
}

/** One of the data page's own two forms, and the button that opens it. */
interface PageForm {
  /** The word the button and the form go by, which is also the prefix of the region that draws the form. */
  readonly which: 'add' | 'modify'
  /**
   * Whether the page keeps the button, read off its read-only flag and its
   * arrangement; what a view leaves out is the page's own default, which
   * draws every button.
   */
  readonly kept: (page: ComponentNode) => boolean
}

/**
 * The regions one data page block arranges, as validation accepted them.
 * @param page - the data page block.
 * @returns the regions the view wrote, or `undefined` where it left every one to the page.
 */
function pageRegions(page: ComponentNode): Readonly<Record<string, boolean>> | undefined {
  return page.props['regions'] as Readonly<Record<string, boolean>> | undefined
}

/**
 * The page's two forms, add before modify. The add button sits in the
 * toolbar, so a page whose toolbar is not drawn keeps none; the modify button
 * sits on every row of the table, which the page always draws.
 */
const PAGE_FORMS: readonly PageForm[] = [
  {
    which: 'add',
    kept: page => page.props['readOnly'] === false
      && pageRegions(page)?.['toolbar'] !== false
      && ((page.props['toolbarButtons'] as readonly string[] | undefined) ?? DATA_PAGE_TOOLBAR_BUTTONS).includes('add'),
  },
  {
    which: 'modify',
    kept: page => page.props['readOnly'] === false
      && ((page.props['rowOperations'] as readonly string[] | undefined) ?? DATA_PAGE_ROW_OPERATIONS).includes('modify'),
  },
]

/**
 * Judge the form page of one view against the data page whose buttons it
 * follows, or, where the view places none, the page's own forms against the
 * buttons it keeps.
 * @param spec - the spec, as validation accepted it.
 * @param page - the view's data page.
 * @returns the refusal, or `undefined` when the forms and the buttons agree.
 */
function judgeForms(spec: ComponentSpec, page: ComponentNode): ComponentCallFailure | undefined {
  const twice = secondReader(spec, page, FORM_PAGE_ID, DATA_PAGE_EDITING_OUTPUT, 'one press would open two forms.')
  if (twice !== undefined) return twice
  const regions = pageRegions(page)
  const form = spec.nodes.find(node => node.component === FORM_PAGE_ID)
  if (form === undefined) {
    const orphaned = PAGE_FORMS.find(one => regions?.[`${one.which}Form`] === false && one.kept(page))
    if (orphaned === undefined) return undefined
    return refuse(
      `spec.nodes[${spec.nodes.indexOf(page)}].props.regions.${orphaned.which}Form`,
      `is false while the page keeps its ${orphaned.which} button, and no ${FORM_PAGE_ID} in this view reads `
      + `${DATA_PAGE_EDITING_OUTPUT} of "${page.id}": the button would open nothing.`,
    )
  }
  const at = `spec.nodes[${spec.nodes.indexOf(form)}].props`
  const table = form.props['relatedMeta'] as string
  if (table !== dataPageMeta(page)) {
    return refuse(
      `${at}.relatedMeta`,
      `is "${table}", and the data page "${page.id}" it reads is opened on "${dataPageMeta(page)}": a form saves into `
      + 'the table its data page shows.',
    )
  }
  const reads = `reads ${DATA_PAGE_EDITING_OUTPUT} of "${page.id}"`
  if (page.props['readOnly'] !== false) {
    return refuse(
      `${at}.request`,
      `${reads}, which is read-only because its readOnly is not false: it draws no add or modify button, so the form `
      + 'never has a record to save.',
    )
  }
  const drawn = PAGE_FORMS.find(one => regions?.[`${one.which}Form`] !== false)
  if (drawn === undefined) return undefined
  return refuse(
    `${at}.request`,
    `${reads}, whose own ${drawn.which} form is still drawn because regions.${drawn.which}Form is not false: one press `
    + 'would open two forms.',
  )
}

/**
 * Judge the info card of one view against the data page whose record it shows,
 * or, where the view places none, the page's links against the card it draws.
 * @param spec - the spec, as validation accepted it.
 * @param page - the view's data page.
 * @returns the refusal, or `undefined` when the page's card, its links and the view's info card agree.
 */
function judgeCard(spec: ComponentSpec, page: ComponentNode): ComponentCallFailure | undefined {
  const twice = secondReader(spec, page, INFO_CARD_ID, DATA_PAGE_OPENED_OUTPUT, 'one click would fill two cards.')
  if (twice !== undefined) return twice
  const card = spec.nodes.find(node => node.component === INFO_CARD_ID)
  const cardInPage = pageRegions(page)?.['infoCard'] !== false
  const links = page.props['infoCardLinks'] === true
  if (card === undefined) {
    if (cardInPage || !links) return undefined
    return refuse(
      `spec.nodes[${spec.nodes.indexOf(page)}].props.infoCardLinks`,
      `is true while regions.infoCard is false, and no ${INFO_CARD_ID} in this view reads ${DATA_PAGE_OPENED_OUTPUT} of `
      + `"${page.id}": a name the user clicks would open nothing.`,
    )
  }
  const reads = `reads ${DATA_PAGE_OPENED_OUTPUT} of "${page.id}"`
  if (cardInPage) {
    return refuse(
      `spec.nodes[${spec.nodes.indexOf(card)}].props.record`,
      `${reads}, whose own side card is still drawn because regions.infoCard is not false: one click would open two cards.`,
    )
  }
  if (links) return undefined
  return refuse(
    `spec.nodes[${spec.nodes.indexOf(card)}].props.record`,
    `${reads}, whose names are not links because infoCardLinks is not true: nothing on the page opens a record.`,
  )
}

/**
 * Judge how one written-down view wires a form page and an info card to the
 * data page they read.
 *
 * Only a view places either block, so only a view's judgement runs this, after
 * the spec has been accepted and its data page judged. Every property that
 * reads one output of the page is judged first, for every block, because each
 * rule after that compares a block with the page it reads. Then the form page:
 * at most one, saving into the page's own table, beside a page that is not
 * read-only and draws neither of its own forms; and a page that leaves out a
 * form while keeping the button that opens it needs the form page beside it.
 * Then the info card: at most one, beside a page whose own side card is
 * switched off with `regions.infoCard: false`, so that one click opens one
 * card and only the info card reports what it shows, and whose names stay
 * links with `infoCardLinks: true`, so that something on the page opens a
 * record; and a page whose names are links while its own card is switched off
 * needs the info card beside it.
 * @param catalog - the components this deployment offers.
 * @param spec - the spec, as validation accepted it.
 * @returns the refusal, or `undefined` when the view's blocks agree with one another.
 */
export function judgeDataPageParts(catalog: ComponentCatalog, spec: ComponentSpec): ComponentCallFailure | undefined {
  for (const node of spec.nodes) {
    const failure = judgeSourcedProps(catalog, spec, node)
    if (failure !== undefined) return failure
  }
  const page = dataPageNodes(spec)[0]
  if (page === undefined) return undefined
  return judgeForms(spec, page) ?? judgeCard(spec, page)
}

/**
 * Refusal for a data page placed by the same call that reads a `dataSource`.
 * @param spec - the spec, as validation accepted it, carrying at least one data page.
 * @returns the refusal, naming the first page.
 */
export function dataPageBesideDataSource(spec: ComponentSpec): ComponentCallFailure {
  const first = dataPageNodes(spec)[0] as ComponentNode
  return refuse(
    `spec.nodes[${spec.nodes.indexOf(first)}]`,
    `places a ${DATA_PAGE_ID} block, which cannot be sent beside dataSource. Open the data page in a call of its own.`,
  )
}

/**
 * The sentence added to an accepted call's line once its page has reported.
 * @param node - the data page block, as validation accepted it.
 * @param report - what the page loaded.
 * @returns the sentence, with a leading space.
 */
export function dataPageLoadedText(node: ComponentNode, report: DataPageLoadReport): string {
  const rest = report.total > report.columns.length ? ` and ${report.total - report.columns.length} more` : ''
  const columns = report.columns.length === 0
    ? 'no columns'
    : `${report.total} column${report.total === 1 ? '' : 's'}: ${report.columns.map(dataPageColumnPhrase).join(', ')}${rest}`
  return ` The user opened the data page of "${dataPageMeta(node)}" in block "${node.id}" with their own credential; it has `
    + `loaded and shows ${columns}. What the user queries in it stays in the panel; each query's row count, the rows they `
    + 'tick and the cell they click come back to you.'
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
export function dataPageUnreportedText(node: ComponentNode, timeoutMs: number): string {
  return ` The user opened the data page of "${dataPageMeta(node)}" in block "${node.id}" with their own credential; no `
    + `client reported its columns within ${timeoutMs / 1000}s. The page loads when the user views it, and its `
    + `first ${MAX_DATA_PAGE_REPORTED_COLUMNS} columns, each query's row count and the rows they touch then reach you as `
    + 'notices — do not place it again because of this.'
}
