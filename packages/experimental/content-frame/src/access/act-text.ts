/**
 * Every sentence `content_act` puts in front of a model or a user: the tool
 * description, the parameter lines, the refusals, the approval request, and the
 * three sections one call answers with.
 *
 * One home for all of it and no imports beyond the wire's own vocabulary and
 * the shared failures' one type, because both halves author some of it — the host composes what it knows
 * before a browser has claimed the call, and the seat composes what only the
 * page can say. A failure is the only text the model reads while deciding what
 * to do next, so each one names the ref, the step, or the call that fixes it.
 * @module @deepseek-ai/dsh-experimental-content-frame/access/act-text
 */

import type { ToolVoice } from './text.ts'
import {
  MAX_ACT_KEY_CHARS, MAX_ACT_TEXT_CHARS, MAX_NAME_CHARS, type ActArgs, type ActStep, type ActStepRefusal,
  type ActStepResult, type ActTarget, type DialogAnswer,
} from './wire.ts'

/**
 * The model-facing description. It names the column the way `content_read`
 * does, states that every target comes from a read, and says outright that one
 * call is one approval — the model's cost model for batching is otherwise
 * invisible to it.
 */
export const CONTENT_ACT_DESCRIPTION =
  'Act on the page the user is looking at in the content column (内容区 — the column between the sidebar and '
  + 'this conversation), the way the user would: click a control, fill a box, choose '
  + 'from a list, press a key, or wait for text to appear. Every target is a ref from a content_read, and every '
  + 'label is that element\'s name copied from the read — the browser checks the name before it acts, so a page '
  + 'that changed since the read stops the call instead of clicking something else; for a row the read printed '
  + 'with no name, pass label "" and its mark, the class tokens the read printed for it. The steps run in '
  + 'order and stop at the first failure; the answer reports each step, what the page did while they ran, and a fresh '
  + 'reading of the page. One call is one approval request, so put the steps that belong together in one call.'

/** The `steps` parameter line. */
export const STEPS_DESCRIPTION =
  'the steps to run in order, each {action, ref, label, mark?, text?, value?, key?}'

/** The `action` parameter line. */
export const ACTION_DESCRIPTION =
  '"click" a control; "fill" replaces a box\'s whole value with text; "select" chooses the option whose visible '
  + 'text is value; "press" sends one key such as Enter or Escape; "wait" waits for text to appear anywhere on '
  + 'the page'

/** The `ref` parameter line. */
export const REF_DESCRIPTION = 'the element\'s ref from a previous content_read, like "e12"; omit only for "wait"'

/** The `label` parameter line. */
export const LABEL_DESCRIPTION =
  'the element\'s name exactly as the read printed it; the browser refuses the step when the page now shows '
  + 'another name there. Pass "" for a row the read printed with no name, and give mark as well. Omit only '
  + 'for "wait"'

/**
 * The one form a mark takes, in both the parameter's description and every
 * refusal about it. A model that has just read `e7 clickable {class: el-icon-delete}`
 * has to know which part of that row goes in the field.
 */
export const MARK_EXAMPLE =
  'where the read printed e7 clickable {class: el-icon-delete}, pass ref "e7", label "" and mark '
  + '"el-icon-delete" — the tokens alone, without the braces and without the "class:" printed in front of them'

/** The `mark` parameter line. */
export const MARK_DESCRIPTION =
  'only for a row the read printed with no name: the class tokens the read printed for it, which is what the '
  + `browser checks that row by. ${MARK_EXAMPLE}. Omit for every row that has a name`

/** The `text` parameter line. */
export const TEXT_DESCRIPTION = 'what "fill" types, and what "wait" waits to see'

/** The `value` parameter line. */
export const VALUE_DESCRIPTION = 'the option "select" chooses, by the text the user would read'

/** The `key` parameter line. */
export const KEY_DESCRIPTION = 'the key "press" sends, as the browser names it: Enter, Escape, Tab, ArrowDown'

/** The `dialogs` parameter line. */
export const DIALOGS_DESCRIPTION =
  'how to answer a confirm/alert/prompt the page itself opens while these steps run: "cancel" (the default) '
  + 'records what it said and stops at that step; "accept" is only permitted when the approval request said so, '
  + 'so pass it only when the user is being asked to approve confirming as well'

/** Refusal for a call with no owning session, which has no column to act on. */
export const NO_AGENT_REFUSAL = 'content_act requires an owning agent session'

/** Refusal for a call the agent loop cancelled while it waited. */
export const CANCELLED_REFUSAL = 'content_act was cancelled'

/** Refusal for a column that holds nothing at all. */
export const EMPTY_COLUMN_REFUSAL =
  'The content column is empty. Call content_show to put a page there, then read it before acting on it.'

/**
 * How `content_act` names itself in the two endings whose wording is the
 * caller's. A model told the entry in front is something `content_read cannot
 * read` has been told about the wrong call: what it asked for was steps, and
 * the tool it is told about is the one it reaches for next.
 */
export const ACT_VOICE: ToolVoice = {
  emptyColumn: EMPTY_COLUMN_REFUSAL,
  cannot: 'content_act cannot act on',
}

/** Refusal for a call whose steps list is empty. */
export const NO_STEPS_REFUSAL = 'steps must name at least one step'

/** Refusal for a step whose `ref` is not one a read returned. */
export const REF_REFUSAL = 'every step but "wait" needs ref, a ref like "e12" from a previous content_read'

/** Refusal for a step with no `label` to check the page against. */
export const LABEL_REFUSAL =
  'every step but "wait" needs label, the element\'s name exactly as content_read printed it, '
  + 'or "" for a row it printed with no name'

/** Refusal for a `fill` with nothing to type. */
export const FILL_TEXT_REFUSAL = 'a "fill" step needs text, the value to type into the box'

/** Refusal for a `wait` with nothing to wait for. */
export const WAIT_TEXT_REFUSAL = 'a "wait" step needs text, the words to wait for'

/** Refusal for a `select` with no option named. */
export const SELECT_VALUE_REFUSAL = 'a "select" step needs value, the option\'s visible text'

/** Refusal for a `press` with no key named. */
export const PRESS_KEY_REFUSAL = 'a "press" step needs key, such as "Enter"'

/** Refusal for a step naming a row the read printed with no name and carrying no mark for it. */
export const MARK_REFUSAL =
  `a row the read printed with no name is named by its mark: ${MARK_EXAMPLE}`

/** Refusal for a mark carrying the listing's own punctuation rather than the tokens inside it. */
export const MARK_PRINTED_REFUSAL =
  `mark is the class tokens themselves, not the whole of what the read printed there: ${MARK_EXAMPLE}`

/** Refusal for a step carrying both a name and a mark. */
export const MARK_ON_NAMED_REFUSAL =
  'a row has one identity: pass label for a row the read named, or mark with label "" for one it did not — '
  + 'not both'

/**
 * The sentence for the field one step could not be read over.
 * @param refusal - which field the wire could not use.
 * @returns the model-facing sentence, without the step prefix.
 */
export function stepRefusalText(refusal: ActStepRefusal): string {
  switch (refusal) {
    // The tool's own schema refuses every other action, so this reaches the
    // model only through a caller that bypassed it.
    case 'action': return ACTION_DESCRIPTION
    case 'ref': return REF_REFUSAL
    case 'label': return LABEL_REFUSAL
    case 'mark': return MARK_REFUSAL
    case 'mark-printed': return MARK_PRINTED_REFUSAL
    case 'mark-on-named': return MARK_ON_NAMED_REFUSAL
    case 'fill-text': return FILL_TEXT_REFUSAL
    case 'wait-text': return WAIT_TEXT_REFUSAL
    case 'value': return SELECT_VALUE_REFUSAL
    case 'key': return PRESS_KEY_REFUSAL
    case 'label-length': return tooLongRefusal('label', MAX_NAME_CHARS)
    case 'text-length': return tooLongRefusal('text', MAX_ACT_TEXT_CHARS)
    case 'value-length': return tooLongRefusal('value', MAX_ACT_TEXT_CHARS)
    case 'key-length': return tooLongRefusal('key', MAX_ACT_KEY_CHARS)
    case 'mark-length': return tooLongRefusal('mark', MAX_ACT_TEXT_CHARS)
    /* v8 ignore next 2 -- the refusal union is closed and typed; the arm keeps a new member loud. */
    default: return ACTION_DESCRIPTION
  }
}

/**
 * Refusal for a call with more steps than the deployment allows.
 * @param maxSteps - the deployment's bound.
 * @returns the model-facing sentence.
 */
export function tooManyStepsRefusal(maxSteps: number): string {
  return `steps must hold at most ${String(maxSteps)} steps; split the rest into another call`
}

/**
 * Refusal naming the step a per-step refusal belongs to.
 * @param at - the step's position, counting from 1.
 * @param reason - what is wrong with it.
 * @returns the model-facing sentence.
 */
export function stepRefusal(at: number, reason: string): string {
  return `content_act step ${String(at)}: ${reason}`
}

/**
 * What the tool adds to the unclaimed refusal it shares with `content_read`.
 *
 * The read's own sentence says a console has to be open; this says the one
 * thing a model deciding whether to retry an action needs on top of it, which
 * the read never has to say because a read that did not run changed nothing
 * either way.
 */
export const NOTHING_DONE = ' Nothing was done.'

/**
 * The failure for a console that claimed the call and then went quiet.
 *
 * Unlike every other ending, this one cannot say what happened: the steps may
 * have run in full, in part, or not at all, and the only honest next move is to
 * look at the page before deciding.
 * @param actTimeoutMs - the deadline that passed.
 * @returns the model-facing sentence.
 */
export function unverifiedRefusal(actTimeoutMs: number): string {
  return `The console claimed this call but did not report within ${actTimeoutMs / 1000}s; `
    + 'the steps may have run partially or fully. Call content_read before deciding to retry.'
}

/**
 * How the approval request names the page.
 *
 * The request is composed before any browser has claimed the call, so the host
 * knows the steps and not the page they will run on. Naming the column instead
 * of guessing a title is what keeps the request true.
 */
export const APPROVAL_SUBJECT = '当前展示的这一项'

/** What the approval request adds when the call may confirm the page's own dialog. */
export const APPROVAL_DIALOG_CLAUSE = '并确认页面弹出的确认框'

/**
 * How the approval request names one step's target: what the read called it, or
 * — for a row the read named nothing — the mark it carries instead.
 *
 * A row the page named nothing would otherwise reach the user as 点「」, which
 * says nothing about what is being approved. The mark is the page's own markup
 * and is shown as that, because it is the only thing either side has.
 * @param step - the validated step, an action that names an element; the wire
 * gives it a mark when, and only when, the read named the row nothing.
 * @param noun - what to call the thing where the read named it nothing.
 * @returns the phrase, quotes included.
 */
function approvalTarget(step: ActTarget, noun: string): string {
  return step.mark === undefined ? `「${step.label}」` : `标为「class: ${step.mark}」的无名${noun}`
}

/**
 * One step as the approval request says it, in the user's own words.
 * @param step - the validated step.
 * @returns the clause, without punctuation around it.
 */
function approvalClause(step: ActStep): string {
  switch (step.action) {
    case 'click': return `点${approvalTarget(step, '控件')}`
    case 'fill': return `填${approvalTarget(step, '框')}为「${step.text}」`
    case 'select': return `在${approvalTarget(step, '项')}里选「${step.value}」`
    case 'press': return `在${approvalTarget(step, '控件')}上按 ${step.key}`
    case 'wait': return `等「${step.text}」出现`
    /* v8 ignore next 2 -- the action union is closed and every arm returns; the arm keeps a new member loud. */
    default: return ''
  }
}

/**
 * The approval request, composed from the arguments and nothing else.
 *
 * The panel title reads this and the card reads `presentCall`, and both may
 * only see the arguments — which is why every step carries what the read called
 * its target: a name, or the mark that stands in for one where the read printed
 * no name. A request that named the page would be naming something the host has
 * not seen.
 * @param args - the validated arguments.
 * @returns the user-facing sentence.
 */
export function approvalReason(args: ActArgs): string {
  const steps = args.steps.map(approvalClause).join('；')
  const dialogs = args.dialogs === 'accept' ? `，${APPROVAL_DIALOG_CLAUSE}` : ''
  return `在「${APPROVAL_SUBJECT}」上：${steps}${dialogs}`
}

/**
 * Refusal for a call that would confirm the page's own dialog without the
 * approval request having said so.
 *
 * The check is on the text the user was shown rather than on the arguments,
 * because the arguments are what is being checked: an approval covering
 * "click 删除" does not cover the confirmation that follows it, and a call
 * whose request never mentioned the dialog may not answer one.
 */
export const DIALOGS_UNAPPROVED_REFUSAL =
  'content_act: dialogs "accept" needs an approval request that says the page\'s own confirmation will be '
  + 'confirmed too; this call was approved without it'

/**
 * How one step names its target in the answer: what the read called it, or the
 * mark it carries where the read named it nothing.
 * @param step - the validated step, an action that names an element.
 * @returns the quoted name or the mark, as the listing printed it.
 */
function ranTarget(step: ActTarget): string {
  return step.mark === undefined ? `"${step.label}"` : `{class: ${step.mark}}`
}

/** How one step reads in the first section of the answer. */
function ranClause(step: ActStep): string {
  switch (step.action) {
    case 'click': return `click ${ranTarget(step)}`
    case 'fill': return `fill ${ranTarget(step)} ← "${step.text}"`
    case 'select': return `select "${step.value}" in ${ranTarget(step)}`
    case 'press': return `press ${step.key} on ${ranTarget(step)}`
    case 'wait': return `wait for "${step.text}"`
    /* v8 ignore next 2 -- the action union is closed and every arm returns; the arm keeps a new member loud. */
    default: return ''
  }
}

/** What a `fill` of a password box says instead of the value it typed. */
export const REDACTED_VALUE = '(hidden)'

/**
 * One step's clause for the answer, with a password box's value withheld.
 * @param step - the step that ran.
 * @param redacted - whether the element it filled hides its own value.
 * @returns the clause.
 */
export function stepClause(step: ActStep, redacted: boolean): string {
  // A password box is filled and never quoted back: the value the model sent is
  // the user's credential, and a transcript is not where it belongs.
  if (step.action === 'fill' && redacted) return `fill "${step.label}" ← ${REDACTED_VALUE}`
  return ranClause(step)
}

/**
 * What ran, for a call that stopped at a failing step.
 * @param ran - how many steps ran before it.
 * @returns the sentence closing the failure.
 */
export function ranSummary(ran: number): string {
  if (ran === 0) return 'Nothing ran.'
  if (ran === 1) return 'Step 1 ran; later steps were skipped.'
  return `Steps 1–${String(ran)} ran; later steps were skipped.`
}

/**
 * The failure for a ref whose element the page no longer has.
 * @param ref - the ref the step named.
 * @returns the reason, without the step prefix.
 */
export function refGoneReason(ref: string): string {
  return `${ref} is no longer on the page; call content_read for current refs.`
}

/**
 * The failure for an element the page still has and no longer shows.
 *
 * A hidden element answers to a name, takes an event and runs a handler, so
 * nothing else on the way to a step would stop one: what the model would be
 * doing is pressing a control the user cannot see, which is the one thing this
 * tool exists not to do.
 * @param ref - the ref the step named.
 * @returns the reason, without the step prefix.
 */
export function hiddenReason(ref: string): string {
  return `${ref} is not visible now; call content_read for current refs.`
}

/**
 * The failure for a column showing another page than the call was approved
 * against.
 *
 * The user is asked about steps on "the entry on display" and answers whenever
 * they answer; anything can happen to the column in between, and the switcher
 * strip is one click. What the approval covered was the page in front at the
 * time, so a call that arrives to find another one there has lost the thing it
 * was agreed about, and the only safe move is to run nothing and say so.
 * @param now - the title of the page in front now.
 * @param approved - the title of the page the steps were approved against.
 * @returns the model-facing sentence.
 */
export function frontChangedRefusal(now: string, approved: string): string {
  return `The page in front is now "${now}", not "${approved}" the steps were approved for; `
    + 'nothing was done. Ask the user, then retry.'
}

/**
 * The failure for a page asking the user to sign in, which no call acts on.
 *
 * `content_read` withholds such a page's listing; this withholds the steps.
 * The two are the same rule about the same page — an agent does not type into
 * a credential form — said by whichever tool the model reached for.
 */
export const SIGN_IN_ACT_REFUSAL =
  'The page shows a sign-in form; content_act will not act on it. Ask the user to sign in, then retry.'

/**
 * The failure for an element whose name is not the one the read printed.
 * @param ref - the ref the step named.
 * @param now - the name the page shows there now.
 * @param expected - the name the step carried.
 * @returns the reason, without the step prefix.
 */
export function labelChangedReason(ref: string, now: string, expected: string): string {
  return `${ref} is now "${now}", not "${expected}" — the page changed; call content_read for current refs.`
}

/**
 * The failure for a row the read named nothing whose mark is not the one the
 * step carries: the page has redrawn what stands at that ref.
 * @param ref - the ref the step named.
 * @param now - the mark the page carries there now.
 * @param expected - the mark the step carried.
 * @returns the reason, without the step prefix.
 */
export function markChangedReason(ref: string, now: string, expected: string): string {
  return `${ref} is now marked {class: ${now}}, not {class: ${expected}} — the page changed; `
    + 'call content_read for current refs.'
}

/**
 * The failure for a target the page has covered with a modal dialog.
 * @param ref - the ref the step named.
 * @param dialog - the open dialog's own name.
 * @returns the reason, without the step prefix.
 */
export function occludedReason(ref: string, dialog: string): string {
  return `${ref} is behind the open dialog "${dialog}"; act inside the dialog or close it first.`
}

/**
 * The failure for a control the page has switched off.
 * @param ref - the ref the step named.
 * @param label - the control's name.
 * @returns the reason, without the step prefix.
 */
export function disabledReason(ref: string, label: string): string {
  return `${ref} "${label}" is disabled.`
}

/**
 * The failure for an option no list offered.
 * @param ref - the ref the step named.
 * @param value - the option text the step asked for.
 * @returns the reason, without the step prefix.
 */
export function noOptionReason(ref: string, value: string): string {
  return `no option reading "${value}" appeared for ${ref}; read the page to see what it offers.`
}

/**
 * The failure for a step the call had no time left to start.
 *
 * The deadline is the host's, and it is spent by everything before this step:
 * the page settling after each earlier one, a `wait` that spent what was left,
 * an application that took a while to answer a click. What the model does about
 * it depends on what the earlier steps did, which the same report carries.
 * @param at - the step's position, counting from 1.
 * @returns the reason, without the step prefix.
 */
export function outOfTimeReason(at: number): string {
  return `the console's time for this call ran out before step ${String(at)}.`
}

/**
 * The failure for text that never appeared.
 * @param text - what the step waited for.
 * @param waitedMs - how long it waited.
 * @returns the reason, without the step prefix.
 */
export function waitedReason(text: string, waitedMs: number): string {
  return `"${text}" did not appear within ${waitedMs / 1000}s.`
}

/**
 * The failure for an action this seat has no way to perform on that element.
 * @param ref - the ref the step named.
 * @param action - the action asked for.
 * @returns the reason, without the step prefix.
 */
export function cannotActReason(ref: string, action: string): string {
  return `${ref} is not something "${action}" can be done to; read the page for what it offers.`
}

/** One thing the browser did on the page's own account while the steps ran. */
export interface ActPageEvent {
  /** Which of the three kinds it is. */
  readonly kind: 'dialog' | 'navigation' | 'window'
  /** The line it prints, already composed by the half that observed it. */
  readonly line: string
}

/**
 * The line a native dialog prints.
 * @param kind - which native dialog the page opened.
 * @param text - what it said.
 * @param answer - how the seat answered it.
 * @returns the line.
 */
export function dialogLine(kind: string, text: string, answer: DialogAnswer): string {
  return `dialog (${kind}) "${text}" — answered ${answer}`
}

/**
 * The line a route change inside the frame prints.
 * @param url - where the frame went.
 * @returns the line.
 */
export function navigationLine(url: string): string {
  return `navigation to ${url}`
}

/**
 * The line an attempt to open a window prints.
 * @param url - the address the page asked for.
 * @returns the line.
 */
export function windowLine(url: string): string {
  return `the page tried to open ${url} in a new window; it was not opened`
}

/** The heading of the second section. */
export const EVENTS_HEADING = 'Page events during these steps:'

/** What the second section says when the page did nothing on its own. */
export const NO_EVENTS = 'Page events during these steps: none.'

/** The heading of the third section. */
export const PAGE_NOW_HEADING = 'Page now:'

/** What one call's answer is composed from. */
export interface ActReportText {
  /** The page's configured title. */
  readonly page: string
  /** The steps the call asked for. */
  readonly steps: readonly ActStep[]
  /** How each of them ended. */
  readonly results: readonly ActStepResult[]
  /** Whether a `fill` step's box hides its own value, by step index. */
  readonly redacted: readonly boolean[]
  /** How long the page took to hold still after the last step that ran, in ms. */
  readonly settledMs: number
  /** What the page did on its own. */
  readonly events: readonly ActPageEvent[]
  /** The closing reading of the page. */
  readonly snapshot: string
}

/**
 * The first section: what ran, or which step stopped the call and why.
 * @param report - what the call did.
 * @returns the section, one line.
 */
function ranSection(report: ActReportText): string {
  const failed = report.results.find(result => result.status === 'failed')
  const ran = report.results.filter(result => result.status === 'ok').length
  if (failed !== undefined) return `Step ${String(failed.index)} failed: ${failed.message} ${ranSummary(ran)}`
  const clauses = report.steps
    .map((step, at) => stepClause(step, report.redacted[at] === true))
    .join('; ')
  const settled = `(settled after ${(report.settledMs / 1000).toFixed(1)}s)`
  return `Done ${String(ran)}/${String(report.steps.length)} on ${report.page}: ${clauses} ${settled}.`
}

/**
 * The whole body one call answers with: what ran, what the page did on its own,
 * and how the page reads now.
 *
 * Three sections every time, in the same order, because the model reads the
 * answer to decide its next move and a section that appears only sometimes is
 * a section it stops looking for.
 * @param report - what the call did, what happened, and the closing reading.
 * @returns the model-facing body.
 */
export function actReportText(report: ActReportText): string {
  const events = report.events.length === 0
    ? [NO_EVENTS]
    : [EVENTS_HEADING, ...report.events.map(event => `  ${event.line}`)]
  return [ranSection(report), ...events, PAGE_NOW_HEADING, report.snapshot].join('\n')
}

/**
 * Refusal for a field the wire will not carry at the length it arrived.
 * @param field - the parameter being refused.
 * @param max - the longest value it takes, in characters.
 * @returns the model-facing sentence.
 */
export function tooLongRefusal(field: string, max: number): string {
  return `${field} must be at most ${String(max)} characters`
}
