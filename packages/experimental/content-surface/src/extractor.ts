/**
 * The extractor contract of the content-surface seam, and the two derivations
 * the router computes from a registered table: the type-erased form the fold
 * works with, and the fold-semantics version the projection registers under.
 *
 * An extractor is the whole of what a kind contributes on the host: which
 * logged events belong to it, which entry each one records, and how a stored
 * record resolves into the title and payload the browser draws. It owns no
 * subscription and no session event of its own — every kind here is derived
 * from facts another package already logs.
 * @module @deepseek-ai/dsh-experimental-content-surface/src/extractor
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/** What one extractor reads out of a single event. */
export interface ContentSurfaceDraft<D> {
  /**
   * Identity of the entry within this kind. A later draft naming the same id
   * replaces the earlier record rather than adding a second entry, which is
   * how a redrawn chart and a re-shown page stay one row in the switcher.
   */
  readonly entryId: string
  /** Kind-owned plain JSON; it is stored verbatim and handed back to `resolve`. */
  readonly data: D
}

/** The browser-facing half of an entry, resolved from a stored record. */
export interface ContentSurfaceResolved {
  /** One line naming the entry in the switcher strip. */
  readonly title: string
  /** Kind-owned plain JSON the kind's renderer consumes. */
  readonly payload: unknown
}

/**
 * One kind's contribution to the content surface.
 *
 * Both functions MUST be synchronous and pure: `read` runs inside the session
 * projection's fold, and `resolve` runs inside its view, where an async result
 * would tear the carriers' consistency cut.
 */
export interface ContentSurfaceExtractor<D> {
  /** The kind this extractor produces; also the `content.surface.kind` key its renderer claims. */
  readonly kind: string
  /**
   * Invalidation anchor for `data`: bump it whenever the stored shape or the
   * reading rules change, so persisted checkpoints written by the previous
   * version are discarded instead of handed to the new `resolve`.
   */
  readonly dataVersion: number
  /**
   * Read the entry one committed event records.
   * @param event - the committed session event.
   * @returns the draft, or `undefined` when the event records nothing for this kind.
   */
  read(event: SessionEvent): ContentSurfaceDraft<D> | undefined
  /**
   * Resolve one stored record against what this kind's host row knows now.
   * @param data - the `data` a previous `read` stored.
   * @returns the entry's title and the payload its renderer receives.
   */
  resolve(data: D): ContentSurfaceResolved
}

/** Type-erased extractor the fold works with; the register call already proved the typed form. */
export interface ErasedExtractor {
  readonly kind: string
  readonly dataVersion: number
  read(event: SessionEvent): ContentSurfaceDraft<unknown> | undefined
  resolve(data: unknown): ContentSurfaceResolved
}

/**
 * Erase one registered extractor's data type.
 *
 * `resolve` takes the stored value back as `D` without re-validating it: a
 * record either came from this process's own `read` or from a persisted
 * checkpoint the registry only seeds when the fold version still matches, and
 * `dataVersion` is the knob that makes the second case safe.
 * @param extractor - the typed extractor as its owner wrote it.
 * @returns the erased form.
 */
export function eraseExtractor<D>(extractor: ContentSurfaceExtractor<D>): ErasedExtractor {
  return {
    kind: extractor.kind,
    dataVersion: extractor.dataVersion,
    read: event => extractor.read(event),
    resolve: data => extractor.resolve(data as D),
  }
}

/**
 * Fold-semantics version of one extractor table.
 *
 * The session-projection registry seeds a fold from a persisted checkpoint row
 * whenever the row's `ver` matches the live unit's `stateVersion`, and this
 * fold's result depends on which extractors were registered when the row was
 * written. Deriving the version from the table is what makes a composition
 * change discard those rows instead of forward-applying them into a stream
 * missing every entry the added kind would have found.
 * @param extractors - the registered table, in any order.
 * @returns a non-negative safe integer, stable across processes for one table.
 */
export function foldVersion(extractors: readonly ErasedExtractor[]): number {
  const signature = extractors.map(extractor => `${extractor.kind}@${extractor.dataVersion}`).sort().join('\n')
  // FNV-1a, folded to 31 bits so the value stays inside the non-negative safe
  // integers the registry accepts. Two tables sharing a value would share a
  // checkpoint; the README records that residual risk.
  let hash = 0x811c9dc5
  for (let index = 0; index < signature.length; index += 1) {
    hash = Math.imul(hash ^ signature.charCodeAt(index), 0x01000193)
  }
  return hash >>> 1
}
