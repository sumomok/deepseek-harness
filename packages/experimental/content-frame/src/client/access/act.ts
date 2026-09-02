/**
 * The acting half of `content_act`, running inside the seat that owns the
 * frames: one step at a time against the documents the reader walked, in the
 * same order the model asked for.
 *
 * The scope is the reader's, not the frame's: a ref can name an element inside
 * a same-origin frame the page itself holds, so each step is run in that
 * element's own document — its events, its value setter, its dialogs, and the
 * wait for it to stop redrawing — while a wait for text looks in all of them.
 *
 * Every step is checked before it runs and the call stops at the first failure.
 * Two checks reject rather than act. The element has to still be on the screen,
 * because a hidden one answers to its name and takes an event like any other.
 * And the check that matters is the name: the model copied a label out of a read,
 * and the element that ref names has to still be called that. A page that
 * re-rendered its table between the read and the call has the same refs
 * pointing at different rows, and without the check the call would press
 * whatever now sits there — which is the one failure mode that cannot be
 * undone by reading again afterwards.
 *
 * The events are the page's own. A click is the whole pointer sequence a user
 * produces, a fill goes through the value setter React and Vue listen to, and a
 * key is three events with no form submitted behind them: what runs afterwards
 * is the application's handler, not this module's idea of what should happen.
 * Nothing here decides what the page does — it decides what the browser is told
 * the user did.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/access/act
 */

import type { ActStep, ActStepResult } from '../../access/wire.ts'
import {
  cannotActReason, disabledReason, hiddenReason, labelChangedReason, noOptionReason, occludedReason,
  outOfTimeReason, refGoneReason, waitedReason,
} from '../../access/act-text.ts'
import {
  DIALOG_SELECTOR, containerName, isDisabled, isHiddenAround, isPassword, isSkipped, queryInOrder, visibleText,
} from './dom.ts'
import type { RefTable } from './refs.ts'
import { whenQuiet } from '../perception/settle.ts'

/**
 * How often a `wait` step looks at the page. A protocol constant, not a
 * deployment choice: it is fast enough that the step ends within a tenth of a
 * second of the text appearing, and cheap enough that a whole minute of waiting
 * costs six hundred reads of one document's visible text.
 */
const WAIT_POLL_MS = 100

/**
 * How long one custom list has to draw its options after it is opened, in
 * multiples of {@link WAIT_POLL_MS}. A protocol constant: a list that has not
 * drawn anything in a second of polling is not a list this step can choose
 * from, and the failure says so rather than spending the call's whole deadline.
 */
const OPTION_POLLS = 10

/** What one step needs from the seat to run against the page. */
export interface ActPage {
  /** The frame's own document, which is the outermost one a step may reach. */
  readonly doc: Document
  /**
   * Every same-origin document the reader walked, {@link doc} first. A ref can
   * name an element in any of them, so what is asked of the page as a whole —
   * whether text has appeared — is asked of all of them; what is asked about
   * one element is asked of that element's own document.
   */
  readonly docs: readonly Document[]
  /** The numbering the model's refs come from. */
  readonly refs: RefTable
  /** Injected visibility, the reader's own. */
  readonly isVisible: (el: Element) => boolean
  /**
   * Injected naming, the reader's own: what a listing prints for one element.
   * A step carries a name copied out of a listing, so the check is against the
   * same computation that printed it and never against a second one.
   */
  readonly name: (el: Element) => string
}

/** How long the steps may wait, as the deployment configured it. */
export interface ActBounds {
  /** How long the page must go unchanged after a step before the next one runs. */
  readonly settleQuietMs: number
  /** How long one step may wait for that stillness, capped by what is left of {@link deadline}. */
  readonly settleMaxMs: number
  /**
   * The moment the whole run must be over by, as a `Date.now()` value. Every
   * step is started before it or not at all, and both waits — for stillness
   * after a step, and for a `wait` step's text — end at it.
   */
  readonly deadline: number
}

/** What running the steps produced. */
export interface ActRun {
  /** One entry per requested step, in order. */
  readonly results: ActStepResult[]
  /** Whether each step filled a box that hides its own value, by position. */
  readonly redacted: boolean[]
  /** How long the page took to go quiet after the last step that ran, in ms. */
  readonly settledMs: number
}

/** The events one click produces, in the order a browser produces them. */
const CLICK_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'] as const

/**
 * Fire one event the page can act on: bubbling, cancelable, and in that
 * document's own window so a framework's delegated listener sees it.
 * @param el - the element the event is dispatched at.
 * @param type - the event's type.
 */
function fire(el: Element, type: string): void {
  el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))
}

/**
 * Fire one pointer or mouse event, as a `MouseEvent` where the window has one.
 *
 * A framework reading `event.button` or `event.clientX` off a plain `Event`
 * reads `undefined` and can take the click for something else, so the event is
 * constructed as the interface the page expects wherever the document's own
 * window provides it.
 * @param el - the element the event is dispatched at.
 * @param type - one of {@link CLICK_EVENTS}.
 */
function firePointer(el: Element, type: string): void {
  const view = el.ownerDocument.defaultView
  /* v8 ignore next -- every element a step resolves sits in a mounted document, which has a window. */
  if (view === null) return
  const init = { bubbles: true, cancelable: true, view, button: 0, buttons: 1 }
  const Pointer = (view as Window & { PointerEvent?: typeof MouseEvent }).PointerEvent
  const Constructor = type.startsWith('pointer') && Pointer !== undefined ? Pointer : view.MouseEvent
  el.dispatchEvent(new Constructor(type, init))
}

/**
 * The dialog one document has open, preferring one that declares itself modal.
 *
 * The same rule the listing's header names one by, applied to the element
 * rather than to its name: a step whose target is outside what the page has put
 * in front of the user is a step the user could not have taken either.
 * @param doc - the document to look in.
 * @param isVisible - injected visibility, the reader's own.
 * @returns the dialog element, or undefined when none is open.
 */
function openDialog(doc: Document, isVisible: (el: Element) => boolean): Element | undefined {
  let topmost: Element | undefined
  for (const el of queryInOrder(doc, DIALOG_SELECTOR)) {
    if (isSkipped(el, isVisible)) continue
    if (el.getAttribute('aria-modal') === 'true') return el
    topmost ??= el
  }
  return topmost
}

/**
 * The element and every frame it sits inside, innermost first, out to the
 * frame the console itself holds.
 *
 * What a dialog covers is decided over this list rather than over the element
 * alone: a dialog is drawn in one document and covers everything under it,
 * frames included, and `contains` answers false across a frame boundary
 * whichever side the dialog is on.
 * @param el - the element a step names.
 * @param root - the frame's own document, where the walk stops.
 * @returns the element, then each frame element on the way out.
 */
function nesting(el: Element, root: Document): Element[] {
  const nodes: Element[] = [el]
  for (let doc = el.ownerDocument; doc !== root;) {
    const view = doc.defaultView
    /* v8 ignore next -- a ref names an element of a document the frame's own reached, so every step out has a window and a frame. */
    if (view === null || view.frameElement === null) break
    nodes.push(view.frameElement)
    doc = view.frameElement.ownerDocument
  }
  return nodes
}

/**
 * The dialog standing between the user and one element, if any.
 *
 * Each document the element sits inside is asked in turn, innermost out: a
 * dialog the page opened over the frame covers what is in the frame, and a
 * dialog holding the frame covers nothing inside it.
 * @param page - the frame's own document and the visibility test.
 * @param el - the element a step names.
 * @returns the dialog covering it, or undefined when none does.
 */
function occluder(page: ActPage, el: Element): Element | undefined {
  const nodes = nesting(el, page.doc)
  for (const node of nodes) {
    const dialog = openDialog(node.ownerDocument, page.isVisible)
    if (dialog !== undefined && !nodes.some(inside => dialog.contains(inside))) return dialog
  }
  return undefined
}

/**
 * Set a field's value the way a user's typing sets it.
 *
 * Through the prototype's own setter rather than the property, because React
 * and Vue both track the value they last wrote on the element itself: assigning
 * `el.value` updates what the page shows and leaves the framework believing
 * nothing changed, so the next render puts the old value back. The setter is
 * looked up on the element's own window, which is the frame's, not the shell's.
 * @param el - the field to fill.
 * @param value - what to type into it.
 */
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const view = el.ownerDocument.defaultView
  /* v8 ignore next -- every element a step resolves sits in a mounted document, which has a window. */
  if (view === null) return
  const prototype = el.localName === 'textarea' ? view.HTMLTextAreaElement : view.HTMLInputElement
  const declared = Object.getOwnPropertyDescriptor(prototype.prototype, 'value')
  // The setter is applied to `el` below, which is the whole point of taking it
  // off the prototype rather than calling it as a method.
  // oxlint-disable-next-line typescript/unbound-method
  const setter = declared?.set
  /* v8 ignore next 2 -- both prototypes declare a value setter in every DOM implementation this runs on. */
  if (setter === undefined) el.value = value
  else Reflect.apply(setter, el, [value])
}

/** Wait one interval between two looks at the page. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, WAIT_POLL_MS) })
}

/**
 * Run one `fill` step.
 * @param el - the element the ref named.
 * @param step - the step, carrying what to type.
 * @returns the failure, or undefined when the box was filled.
 */
function fill(el: Element, step: Extract<ActStep, { action: 'fill' }>): string | undefined {
  if (el.localName !== 'input' && el.localName !== 'textarea') {
    return cannotActReason(step.ref, 'fill')
  }
  const field = el as HTMLInputElement | HTMLTextAreaElement
  field.focus()
  setValue(field, step.text)
  fire(field, 'input')
  fire(field, 'change')
  return undefined
}

/**
 * Choose one option of a native `<select>` by the text the user reads.
 * @param el - the select element.
 * @param step - the step, carrying the option's text.
 * @returns the failure, or undefined when the option was chosen.
 */
function selectNative(el: HTMLSelectElement, step: Extract<ActStep, { action: 'select' }>): string | undefined {
  const option = [...el.options].find(candidate => candidate.text.trim() === step.value)
  if (option === undefined) return noOptionReason(step.ref, step.value)
  el.value = option.value
  fire(el, 'input')
  fire(el, 'change')
  return undefined
}

/**
 * Choose one option of a list the page draws itself: open it, wait for the
 * options, and click the one whose text matches.
 *
 * A picker built out of a read-only box and a popup is what an application
 * framework draws where the platform would draw a `<select>`, and the user
 * chooses from it by clicking twice. So does this.
 * @param el - the element the ref named.
 * @param step - the step, carrying the option's text.
 * @param page - the document and the visibility test.
 * @returns the failure, or undefined when the option was clicked.
 */
async function selectDrawn(
  el: Element,
  step: Extract<ActStep, { action: 'select' }>,
  page: ActPage,
): Promise<string | undefined> {
  for (const type of CLICK_EVENTS) firePointer(el, type)
  for (let poll = 0; poll < OPTION_POLLS; poll += 1) {
    // The list's own document: a popup a page draws for a control inside a
    // frame is drawn in that frame, wherever in it the page puts it.
    const option = queryInOrder(el.ownerDocument, '[role~="option"]')
      .find(candidate => !isSkipped(candidate, page.isVisible) && visibleText(candidate, page.isVisible) === step.value)
    if (option !== undefined) {
      for (const type of CLICK_EVENTS) firePointer(option, type)
      return undefined
    }
    await tick()
  }
  return noOptionReason(step.ref, step.value)
}

/**
 * Wait for text to appear anywhere the page shows it.
 * @param step - the step, carrying the text to wait for.
 * @param page - the document and the visibility test.
 * @param budgetMs - how long this step may spend looking.
 * @returns the failure, or undefined when the text appeared.
 */
async function waitFor(
  step: Extract<ActStep, { action: 'wait' }>,
  page: ActPage,
  budgetMs: number,
): Promise<string | undefined> {
  const until = Date.now() + budgetMs
  const shown = (doc: Document): boolean => visibleText(doc.body, page.isVisible).includes(step.text)
  for (;;) {
    // Visible text rather than the document's own: a page that keeps its
    // toasts in the markup and hides them would otherwise answer at once. And
    // every document the reader walked, because what the user is waiting to
    // see may be drawn by an application the page holds in a frame.
    if (page.docs.some(shown)) return undefined
    if (Date.now() >= until) return waitedReason(step.text, budgetMs)
    await tick()
  }
}

/**
 * Run one step against the element its ref names.
 * @param step - the step to run.
 * @param page - the documents, the numbering, and the visibility test.
 * @param el - the element the ref resolved to, absent for a `wait` and for a
 * ref the page no longer has.
 * @param budgetMs - how long a `wait` step may spend looking.
 * @returns the failure, or undefined when the step ran.
 */
async function runStep(
  step: ActStep,
  page: ActPage,
  el: Element | undefined,
  budgetMs: number,
): Promise<string | undefined> {
  if (step.action === 'wait') return await waitFor(step, page, budgetMs)
  if (el === undefined) return refGoneReason(step.ref)
  // Before the name, because a hidden element still answers to one: what the
  // ref names is on the page and not on the screen, and a step that ran would
  // be pressing something the user cannot see.
  if (isHiddenAround(el, page.isVisible)) return hiddenReason(step.ref)
  // The name is what the model chose this element by, so a page that changed
  // under the refs stops the call here rather than acting on what took its
  // place.
  const name = page.name(el)
  if (name !== step.label) return labelChangedReason(step.ref, name, step.label)
  const dialog = occluder(page, el)
  if (dialog !== undefined) {
    return occludedReason(step.ref, containerName(dialog, page.isVisible))
  }
  if (isDisabled(el)) return disabledReason(step.ref, step.label)
  switch (step.action) {
    case 'click':
      // Optional because a DOM implementation may not provide it: the lib
      // declares it unconditionally, and jsdom has no layout to scroll.
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      el.scrollIntoView?.({ block: 'center' })
      for (const type of CLICK_EVENTS) firePointer(el, type)
      return undefined
    case 'fill': return fill(el, step)
    case 'select':
      return el.localName === 'select'
        ? selectNative(el as HTMLSelectElement, step)
        : await selectDrawn(el, step, page)
    case 'press':
      for (const type of ['keydown', 'keypress', 'keyup']) {
        el.dispatchEvent(new KeyboardEvent(type, { key: step.key, bubbles: true, cancelable: true }))
      }
      return undefined
    /* v8 ignore next 2 -- the action union is closed and `wait` returned above; the arm keeps a new member loud. */
    default: return cannotActReason('', 'act')
  }
}

/**
 * Whether one step's own answer should be withheld from the transcript.
 * @param step - the step that ran.
 * @param el - the element it named, absent for a `wait` and for a ref the page
 * no longer has.
 * @returns whether it filled a box the page hides the value of.
 */
function fillsSecret(step: ActStep, el: Element | undefined): boolean {
  return el !== undefined && step.action === 'fill' && isPassword(el)
}

/**
 * Run every step in order, stopping at the first failure.
 *
 * Each step that ran waits for the page to go quiet before the next one starts:
 * a click that opens a dialog has to have opened it before the step that fills
 * a box inside it resolves its ref. The wait is bounded per step, so a page
 * that never stops moving costs one ceiling per step rather than the whole run,
 * and it is bounded again by the run's own deadline — which is also what a
 * step past that moment fails on, rather than starting work whose answer no
 * longer has a caller.
 * @param steps - the validated steps, in the order the model asked for.
 * @param page - the documents, the numbering, and the visibility test.
 * @param bounds - the deployment's per-step ceiling and the run's own deadline.
 * @returns what each step ended as, which of them filled a hidden box, and how
 * long the page took to go quiet after the last one.
 */
export async function runSteps(steps: readonly ActStep[], page: ActPage, bounds: ActBounds): Promise<ActRun> {
  const results: ActStepResult[] = []
  const redacted: boolean[] = []
  let settledMs = 0
  let stopped = false
  for (const [at, step] of steps.entries()) {
    const index = at + 1
    if (stopped) {
      results.push({ index, status: 'skipped' })
      redacted.push(false)
      continue
    }
    if (Date.now() >= bounds.deadline) {
      results.push({ index, status: 'failed', message: outOfTimeReason(index) })
      redacted.push(false)
      stopped = true
      continue
    }
    const el = step.action === 'wait' ? undefined : page.refs.resolve(step.ref)
    const secret = fillsSecret(step, el)
    const failure = await runStep(step, page, el, Math.max(bounds.deadline - Date.now(), 0))
    redacted.push(secret)
    if (failure !== undefined) {
      results.push({ index, status: 'failed', message: failure })
      stopped = true
      continue
    }
    results.push({ index, status: 'ok' })
    const started = Date.now()
    // The document the step acted in: an application in a frame redraws that
    // frame, and a wait for the frame's own document would see none of it.
    await whenQuiet(el?.ownerDocument ?? page.doc, {
      quietMs: bounds.settleQuietMs,
      budgetMs: Math.min(bounds.settleMaxMs, Math.max(bounds.deadline - started, 0)),
    })
    settledMs = Date.now() - started
  }
  return { results, redacted, settledMs }
}
