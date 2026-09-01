/**
 * The numbering the model points at: every element a snapshot names carries a
 * short ref (`e1`, `e2`, …) that stays the same for as long as that element
 * lives, so a ref the model read in one snapshot still names the same element
 * in the next one.
 *
 * A number the model has seen is never reused, `reset()` included: a ref it
 * still holds from a page that has since reloaded resolves to nothing rather
 * than to some unrelated element that inherited its number. A number minted
 * while measuring a row that then did not fit the budget is wound back by
 * `rollback()` before the read answers, so it was never seen and is free.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/access/refs
 */

/** What every ref starts with, before the number. */
const REF_PREFIX = 'e'

/** The element numbering shared by every snapshot of one page. */
export class RefTable {
  /** The ref minted for each element, so repeat sightings answer the same one. */
  #byElement = new WeakMap<Element, string>()

  /** The element each ref names, held weakly so the table never pins a detached tree. */
  #byRef = new Map<string, WeakRef<Element>>()

  /** The next unused number, monotonic across resets. */
  #next = 1

  /**
   * The ref for one element, minted on first sight.
   * @param el - the element to name.
   * @returns the element's ref.
   */
  ref(el: Element): string {
    const known = this.#byElement.get(el)
    if (known !== undefined) return known
    const minted = `${REF_PREFIX}${this.#next}`
    this.#next += 1
    this.#byElement.set(el, minted)
    this.#byRef.set(minted, new WeakRef(el))
    return minted
  }

  /**
   * The point a listing can wind the numbering back to, taken before it renders
   * rows it may not keep.
   * @returns the mark to pass to {@link rollback}.
   */
  mark(): number {
    return this.#next
  }

  /**
   * Forget every ref minted since a mark, so a listing numbers what it prints
   * and nothing it merely measured. An element numbered before the mark keeps
   * its ref; one numbered after it takes the same number again the next time a
   * listing prints it.
   * @param mark - the mark taken before the rows in question were rendered.
   */
  rollback(mark: number): void {
    for (const [ref, held] of this.#byRef) {
      if (Number(ref.slice(REF_PREFIX.length)) < mark) continue
      this.#byRef.delete(ref)
      const el = held.deref()
      /* v8 ignore next -- deref answers undefined only for an element the collector has taken, which a test cannot force. */
      if (el !== undefined) this.#byElement.delete(el)
    }
    this.#next = mark
  }

  /**
   * How wide a ref can be once a listing has numbered so many more elements,
   * for a caller sizing a line before the rows it names have been rendered.
   * @param pending - how many elements the listing may yet number.
   * @returns the widest ref in characters.
   */
  widthAfter(pending: number): number {
    return `${REF_PREFIX}${this.#next + pending}`.length
  }

  /**
   * The element a ref names, while that element is still in a document.
   * @param ref - a ref this table minted.
   * @returns the element, or undefined when the ref is unknown or its element
   * has left the document.
   */
  resolve(ref: string): Element | undefined {
    const el = this.#byRef.get(ref)?.deref()
    return el !== undefined && el.isConnected ? el : undefined
  }

  /**
   * Drop the refs of elements the page no longer has, so a table that lives as
   * long as its page does not grow one entry per row the page has ever drawn.
   * An element that leaves the document and comes back is a new element to the
   * reader and takes a new ref.
   */
  sweep(): void {
    for (const [ref, held] of this.#byRef) {
      const el = held.deref()
      /* v8 ignore next 4 -- deref answers undefined only for an element the collector has taken, which a test cannot force. */
      if (el === undefined) {
        this.#byRef.delete(ref)
        continue
      }
      if (el.isConnected) continue
      this.#byRef.delete(ref)
      this.#byElement.delete(el)
    }
  }

  /** Drop every ref, for a page that has navigated away from what they named. */
  reset(): void {
    this.#byElement = new WeakMap()
    this.#byRef = new Map()
  }
}
