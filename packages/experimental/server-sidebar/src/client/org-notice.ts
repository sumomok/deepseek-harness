/**
 * The organization notice: what the page reads from the organization plugin,
 * how it checks those answers, and what the card shows.
 *
 * Whether a member has to see the organization's disclosure, and which
 * version, is the organization plugin's to work out: it holds the version the
 * organization accepted for this deployment and the version each member has
 * seen or agreed to, and only it can tell members apart. The page asks it
 * through an {@link OrgNoticePort}, shows the answer, and reports what the
 * member did with it. Nothing about the notice is stored by the page: a
 * member's "seen" version is not a Settings write, which on the console is
 * shared by every member, and not browser storage, which two people sharing a
 * browser would share as well.
 *
 * The answers cross a process boundary, so {@link parseOrgNoticeDue},
 * {@link parseMarkSeenAnswer}, and {@link parseConfirmAnswer} check every
 * field the page reads, ignore the fields it does not, and name the first
 * field that does not read. {@link createOrgNoticeStore} keeps the card's
 * state and remembers, for the life of the page, which cards the member has
 * put away, so a card acknowledged or deferred here is not shown again on
 * this page until the plugin answers another version.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/org-notice
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** One text in both languages the console ships. */
export interface BilingualText {
  zh: string
  en: string
}

/** One kind of data the disclosure says is collected. */
export interface DisclosureCategory {
  /** The organization's id for the category. */
  id: string
  /** What the category is called. */
  label: BilingualText
}

/**
 * Who may read what a member uploads: the member alone, or the member and the
 * organization's administrators.
 */
export type DisclosureViewers = 'self' | 'self_and_admins'

/** The parts of the organization's disclosure the card shows. */
export interface DisclosureText {
  title: BilingualText
  /** The disclosure's own text, shown as plain text with its line breaks. */
  body: BilingualText
  categories: readonly DisclosureCategory[]
  /** How many days uploaded data is kept; a positive whole number. */
  retentionDays: number
  viewers: DisclosureViewers
  /** How to reach the organization about the disclosure; empty when it names none. */
  contact: string
  /** The full policy's address; the card links it only when it is an `https:` address. */
  policyUrl: string
}

/** A due answer that shows a card: a notice to read once, or a disclosure to agree to. */
export interface ShownDue {
  kind: 'notice' | 'consent'
  /** The disclosure version this answer shows; a positive whole number. */
  version: number
  /** The organization's name, when the plugin knows it. */
  orgName?: string
  /** The text of that version. */
  disclosure: DisclosureText
}

/**
 * What the organization plugin answers for the calling member: nothing to
 * show, no judgement yet (ask again after `retryAfterMs`), or a card.
 */
export type OrgNoticeDue =
  | { kind: 'none' }
  | {
    kind: 'pending'
    /**
     * How long to wait before asking again, in milliseconds: zero or more,
     * and at most {@link MAX_TIMER_DELAY_MS}.
     */
    retryAfterMs: number
  }
  | ShownDue

/**
 * The plugin's answer to {@link OrgNoticePort.markSeen}: the version is
 * recorded as read, or it is not a version the plugin can record now.
 */
export type MarkSeenAnswer = { kind: 'recorded' } | { kind: 'stale' }

/**
 * The plugin's answer to {@link OrgNoticePort.confirm}: the agreement is
 * recorded, or the version is not the one that asks for agreement now. The
 * plugin's `accepted` answer also names the version, which the page does not
 * read: it puts away the version it sent.
 */
export type ConfirmAnswer = { kind: 'accepted' } | { kind: 'stale' }

/**
 * The page's port to the organization plugin. Each call resolves to the
 * plugin's answer for the member who made it, and rejects when the plugin
 * refused the call, could not be reached, or answered something the page
 * cannot read. The plugin refuses with the Remote codes
 * `sumomokOrg/caller-unknown` (it cannot tell which member called) and, from
 * {@link OrgNoticePort.confirm} only, `sumomokOrg/unavailable` (the
 * organization could not be reached); the card treats every rejection of one
 * method the same way, and only the console report tells an answer the page
 * cannot read from the other rejections.
 */
export interface OrgNoticePort {
  /**
   * Ask what the calling member has to see now.
   * @returns the answer.
   */
  due(): Promise<OrgNoticeDue>
  /**
   * Record that the calling member has read a notice.
   * @param version - the version the card showed.
   * @returns whether the plugin recorded it.
   */
  markSeen(version: number): Promise<MarkSeenAnswer>
  /**
   * Record the calling member's agreement to a disclosure.
   * @param version - the version the card showed.
   * @returns whether the plugin recorded it.
   */
  confirm(version: number): Promise<ConfirmAnswer>
}

/** An answer the page cannot read, naming the first field that did not. */
export class OrgNoticeAnswerError extends Error {
  /**
   * @param field - the dotted path of the field, from the answer's top level.
   */
  constructor(readonly field: string) {
    super(`server-sidebar: the organization notice answer is unusable at ${field}`)
    this.name = 'OrgNoticeAnswerError'
  }
}

/**
 * Narrow a value to a plain record.
 * @param value - any value.
 * @returns whether it is a non-array object.
 */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read an answer's top level.
 * @param value - the answer as it arrived.
 * @returns the answer as a record.
 */
function readAnswer(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new OrgNoticeAnswerError('(answer)')
  return value
}

/**
 * Read one string field.
 * @param value - the field's value.
 * @param field - the field's path, for the error.
 * @returns the string.
 */
function readString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new OrgNoticeAnswerError(field)
  return value
}

/**
 * Read one positive whole number.
 * @param value - the field's value.
 * @param field - the field's path, for the error.
 * @returns the number.
 */
function readCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new OrgNoticeAnswerError(field)
  return value
}

/**
 * Read one text in both languages.
 * @param value - the field's value.
 * @param field - the field's path, for the error.
 * @returns the two texts.
 */
function readBilingual(value: unknown, field: string): BilingualText {
  if (!isRecord(value)) throw new OrgNoticeAnswerError(field)
  return { zh: readString(value.zh, `${field}.zh`), en: readString(value.en, `${field}.en`) }
}

/**
 * Read the disclosure's text.
 * @param value - the `disclosure` field's value.
 * @returns the parts the card shows.
 */
function readDisclosure(value: unknown): DisclosureText {
  if (!isRecord(value)) throw new OrgNoticeAnswerError('disclosure')
  const { categories, viewers } = value
  if (!Array.isArray(categories)) throw new OrgNoticeAnswerError('disclosure.categories')
  if (viewers !== 'self' && viewers !== 'self_and_admins') throw new OrgNoticeAnswerError('disclosure.viewers')
  return {
    title: readBilingual(value.title, 'disclosure.title'),
    body: readBilingual(value.body, 'disclosure.body'),
    categories: categories.map((category: unknown, index) => {
      const field = `disclosure.categories[${String(index)}]`
      if (!isRecord(category)) throw new OrgNoticeAnswerError(field)
      return { id: readString(category.id, `${field}.id`), label: readBilingual(category.label, `${field}.label`) }
    }),
    retentionDays: readCount(value.retentionDays, 'disclosure.retentionDays'),
    viewers,
    contact: readString(value.contact, 'disclosure.contact'),
    policyUrl: readString(value.policyUrl, 'disclosure.policyUrl'),
  }
}

/**
 * The longest delay `setTimeout` waits. Browsers hold the delay as a signed
 * 32-bit integer and run a timer with a longer one at once.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * Check the organization plugin's answer to {@link OrgNoticePort.due}. Fields
 * the page does not read are ignored, and a `kind` it does not know reads as
 * nothing to show: the plugin's answers only grow by addition. A `pending`
 * wait longer than {@link MAX_TIMER_DELAY_MS} reads as that delay.
 * @param value - the answer as it arrived.
 * @param unknownKind - told the `kind` of an answer read as nothing to show for that reason.
 * @returns the answer.
 * @throws OrgNoticeAnswerError naming the first field the page cannot read.
 */
export function parseOrgNoticeDue(value: unknown, unknownKind: (kind: unknown) => void): OrgNoticeDue {
  const answer = readAnswer(value)
  const { kind } = answer
  if (kind === 'none') return { kind }
  if (kind === 'pending') {
    const { retryAfterMs } = answer
    if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
      throw new OrgNoticeAnswerError('retryAfterMs')
    }
    return { kind, retryAfterMs: Math.min(retryAfterMs, MAX_TIMER_DELAY_MS) }
  }
  if (kind !== 'notice' && kind !== 'consent') {
    unknownKind(kind)
    return { kind: 'none' }
  }
  const version = readCount(answer.version, 'version')
  const disclosure = readDisclosure(answer.disclosure)
  if (answer.orgName === undefined) return { kind, version, disclosure }
  return { kind, version, orgName: readString(answer.orgName, 'orgName'), disclosure }
}

/**
 * Check the organization plugin's answer to {@link OrgNoticePort.markSeen}.
 * @param value - the answer as it arrived.
 * @returns the answer.
 * @throws OrgNoticeAnswerError when it is neither `recorded` nor `stale`.
 */
export function parseMarkSeenAnswer(value: unknown): MarkSeenAnswer {
  const { kind } = readAnswer(value)
  if (kind !== 'recorded' && kind !== 'stale') throw new OrgNoticeAnswerError('kind')
  return { kind }
}

/**
 * Check the organization plugin's answer to {@link OrgNoticePort.confirm}.
 * @param value - the answer as it arrived.
 * @returns the answer.
 * @throws OrgNoticeAnswerError when it is neither `accepted` nor `stale`.
 */
export function parseConfirmAnswer(value: unknown): ConfirmAnswer {
  const { kind } = readAnswer(value)
  if (kind !== 'accepted' && kind !== 'stale') throw new OrgNoticeAnswerError('kind')
  return { kind }
}

/** A method of {@link OrgNoticePort} whose failure the page reports. */
export type OrgNoticeMethod = 'due' | 'markSeen' | 'confirm'

/**
 * How a call failed: `unreadable` when the plugin answered something the page
 * cannot read ({@link OrgNoticeAnswerError}), `refused` for any other
 * rejection, which is the plugin's refusal or a call that did not reach it.
 */
export type OrgNoticeFailure = 'refused' | 'unreadable'

/**
 * What the notice reports to the browser console about: one method's failure
 * of one kind, or a `due()` answer whose `kind` the page does not know.
 */
export type OrgNoticeTopic = `${OrgNoticeMethod} ${OrgNoticeFailure}` | 'kind'

/**
 * Report a failure to the browser console.
 * @param topic - what failed.
 * @param message - the line to report.
 * @param cause - the failure, when there is one.
 */
export type OrgNoticeReport = (topic: OrgNoticeTopic, message: string, cause?: unknown) => void

/**
 * Report each topic once: an answer that cannot be read, or a refusal,
 * repeats on every later ask, while a refusal and an unreadable answer of
 * the same method are two topics.
 * @param warn - where a report goes; the browser console's `console.warn` in the product.
 * @returns the reporter.
 */
export function reportOncePerTopic(warn: (...line: unknown[]) => void): OrgNoticeReport {
  const reported = new Set<OrgNoticeTopic>()
  return (topic, message, cause) => {
    if (reported.has(topic)) return
    reported.add(topic)
    if (cause === undefined) warn(message)
    else warn(message, cause)
  }
}

/**
 * Report a call that failed: an answer the page cannot read by the field that
 * did not read, and any other rejection with the given line and the rejection.
 * @param report - where the failure is reported.
 * @param method - the method that failed.
 * @param refused - the line for a rejection other than an unreadable answer.
 * @param error - the rejection.
 */
function reportFailure(report: OrgNoticeReport, method: OrgNoticeMethod, refused: string, error: unknown): void {
  if (error instanceof OrgNoticeAnswerError) {
    report(`${method} unreadable`, `server-sidebar: the organization notice answer to ${method}() is unusable at ${error.field}`)
    return
  }
  report(`${method} refused`, refused, error)
}

/** What the card shows: nothing, or one answer and where the member's agreement stands. */
export type OrgNoticeView =
  | { shown: undefined }
  | {
    shown: ShownDue
    /** An agreement is on its way to the plugin; the card takes no second one meanwhile. */
    confirming: boolean
    /** The last agreement did not go through. */
    failed: boolean
  }

/** The card's state, the member's three actions on it, and its teardown. */
export interface OrgNoticeStore extends HostObservable<OrgNoticeView> {
  /**
   * Ask the plugin again. An answer to an earlier ask that arrives after a
   * later one's is dropped. A `pending` answer leaves the card as it is and
   * asks again after the delay it names; any ask cancels that scheduled one.
   */
  refresh: () => Promise<void>
  /** 知道了: put the notice away and tell the plugin it was read; a `stale` answer asks again. */
  acknowledge: () => void
  /**
   * 稍后: put the disclosure away for this page without answering it; does
   * nothing while an agreement is on its way.
   */
  later: () => void
  /**
   * 同意: send the member's agreement. The card stays until the plugin takes
   * it, shows a refusal on the card, and asks again on a `stale` answer.
   */
  consent: () => Promise<void>
  /** Stop asking: cancel a scheduled ask, and drop every answer still on its way. */
  dispose: () => void
}

/**
 * A card the member has put away on this page.
 * @param due - the answer the card showed.
 * @returns the key the store remembers it by.
 */
function putAwayKey(due: Pick<ShownDue, 'kind' | 'version'>): string {
  return `${due.kind}:${String(due.version)}`
}

/** The view that shows nothing. */
const HIDDEN: OrgNoticeView = { shown: undefined }

/**
 * Create the card's store.
 * @param port - the organization plugin's port.
 * @param report - where a failure is reported.
 * @returns the store, showing nothing until its first {@link OrgNoticeStore.refresh}.
 */
export function createOrgNoticeStore(port: OrgNoticePort, report: OrgNoticeReport): OrgNoticeStore {
  let view: OrgNoticeView = HIDDEN
  const putAway = new Set<string>()
  const listeners = new Set<() => void>()
  let asked = 0
  let disposed = false
  let retry: ReturnType<typeof setTimeout> | undefined
  // Whether an ask's answer still counts: it is the latest ask, and the store is not disposed.
  const latest = (ask: number): boolean => ask === asked && !disposed
  const set = (next: OrgNoticeView): void => {
    view = next
    for (const listener of [...listeners]) listener()
  }
  const hide = (): void => {
    if (view.shown !== undefined) set(HIDDEN)
  }
  const showing = (due: ShownDue): boolean => view.shown !== undefined && putAwayKey(view.shown) === putAwayKey(due)
  const putAwayShown = (kind: ShownDue['kind']): ShownDue | undefined => {
    if (view.shown === undefined || view.shown.kind !== kind || view.confirming) return undefined
    const { shown } = view
    putAway.add(putAwayKey(shown))
    set(HIDDEN)
    return shown
  }
  const show = (due: ShownDue): void => {
    if (putAway.has(putAwayKey(due))) {
      hide()
      return
    }
    // The same card keeps where its agreement stands; another version starts clean.
    const previous = showing(due) ? view : HIDDEN
    set({
      shown: due,
      confirming: previous.shown !== undefined && previous.confirming,
      failed: previous.shown !== undefined && previous.failed,
    })
  }
  const store: OrgNoticeStore = {
    getSnapshot: () => view,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh: async () => {
      if (disposed) return
      clearTimeout(retry)
      asked += 1
      const ask = asked
      let due: OrgNoticeDue
      try {
        due = await port.due()
      } catch (error) {
        if (!latest(ask)) return
        reportFailure(report, 'due', 'server-sidebar: the organization notice could not be read:', error)
        // An agreement on its way keeps its card until it settles.
        if (view.shown !== undefined && view.confirming) return
        hide()
        return
      }
      if (!latest(ask)) return
      switch (due.kind) {
        case 'none':
          hide()
          return
        case 'pending':
          retry = setTimeout(() => { void store.refresh() }, due.retryAfterMs)
          return
        case 'notice':
        case 'consent':
          show(due)
          return
        /* v8 ignore next 2 -- OrgNoticeDue is closed and every member is handled above. */
        default:
          assertNever(due)
      }
    },
    acknowledge: () => {
      const shown = putAwayShown('notice')
      if (shown === undefined) return
      void port.markSeen(shown.version).then(
        async (answer) => {
          if (answer.kind === 'stale') await store.refresh()
        },
        (error: unknown) => {
          reportFailure(report, 'markSeen', 'server-sidebar: the organization notice was not recorded as read:', error)
        },
      )
    },
    later: () => { putAwayShown('consent') },
    consent: async () => {
      const current = view
      if (current.shown === undefined || current.shown.kind !== 'consent' || current.confirming) return
      const { shown } = current
      set({ shown, confirming: true, failed: false })
      let answer: ConfirmAnswer
      try {
        answer = await port.confirm(shown.version)
      } catch (error) {
        reportFailure(report, 'confirm', 'server-sidebar: the organization did not record the agreement:', error)
        if (showing(shown)) set({ shown, confirming: false, failed: true })
        return
      }
      if (answer.kind === 'stale') {
        if (showing(shown)) set({ shown, confirming: false, failed: false })
        await store.refresh()
        return
      }
      putAway.add(putAwayKey(shown))
      if (showing(shown)) set(HIDDEN)
    },
    dispose: () => {
      disposed = true
      clearTimeout(retry)
    },
  }
  return store
}
