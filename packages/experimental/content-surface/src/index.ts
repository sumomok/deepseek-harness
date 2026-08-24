/**
 * @deepseek-ai/dsh-experimental-content-surface — the service-line shell's
 * content column as one per-session stream of typed entries.
 *
 * The column had one seat and more than one producer wanting it. This package
 * turns the seat into a router: host rows register extractors that recognize
 * their own already-logged events, and this row folds them into a single
 * `contentSurface` projection. The browser half —
 * `@deepseek-ai/dsh-experimental-content-column` — renders the selected entry
 * through a keyed slot whose key is the entry's kind. A new kind is a host
 * extractor plus a `content.surface.kind` registration; nothing here changes.
 *
 * No session event of its own, deliberately. Every entry is derived from a
 * fact another package already logs — `content/shown` for a page, a
 * `show_chart` call for a chart — so replay reconstructs the whole column from
 * the log the agent actually wrote.
 * @module @deepseek-ai/dsh-experimental-content-surface
 */

import { Context, Service } from '@deepseek-ai/cordis'
// Type-only: resolves ctx.sessionProjections for the optional projection child.
import type {} from '@deepseek-ai/dsh-session-projection'
import { eraseExtractor, type ContentSurfaceExtractor, type ErasedExtractor } from './extractor.ts'
import { contentSurfaceProjection } from './projection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    contentSurface: ContentSurfaceRegistry
  }
}

// The `contentSurface` projection declarations live in src/types.ts (their one
// home); this re-export projects the type face onto the package root and keeps
// the module edge in the emitted index.d.ts.
export type * from './types.ts'
export type {
  ContentSurfaceDraft,
  ContentSurfaceExtractor,
  ContentSurfaceResolved,
} from './extractor.ts'

/**
 * `ctx.contentSurface`: the extractor table behind the content column's entry
 * stream, and the owner of the `contentSurface` projection unit.
 *
 * **Registration timing is free.** The projection registry fixes a unit's fold
 * and its `stateVersion` at registration and caches one folded cell per
 * session, so a table read live inside one long-lived unit would leave every
 * cell built before a late extractor arrived permanently missing that kind's
 * history. This registry therefore registers a NEW unit for every table
 * change: the registry drops the old unit's cells with it, and each session's
 * next touch refolds `init` over its whole in-memory log through the new table.
 * `stateVersion` is derived from the table for the same reason, so a persisted
 * checkpoint written under a different set of kinds is discarded rather than
 * forward-applied.
 *
 * The one cost is push latency: the registry publishes a changed value only
 * while driving an event, so a browser already connected when a kind row is
 * hot-loaded reads the previous stream until that session's next event.
 */
export class ContentSurfaceRegistry extends Service {
  private readonly extractors = new Set<ErasedExtractor>()
  /** The context the projection unit is registered on; absent without a projection registry. */
  private host: Context | undefined
  /** Disposer of the unit currently registered, if any. */
  private unit: (() => void) | undefined

  /**
   * Create and install the registry as `ctx.contentSurface`.
   * @param ctx - Cordis context that owns the service.
   */
  constructor(ctx: Context) {
    super(ctx, 'contentSurface')
    // Optional capability: an assembly without a projection registry keeps the
    // extractor table and publishes nothing, and the column shows its empty state.
    ctx.inject(['sessionProjections'], (projectionCtx: Context) => {
      projectionCtx.effect(() => {
        this.host = projectionCtx
        this.resync()
        return () => {
          this.release()
          this.host = undefined
        }
      }, 'content-surface: contentSurface projection unit')
    })
  }

  /**
   * Register one kind's extractor. The registration is an effect on the
   * calling context's fiber: disposing the fiber (or calling the returned
   * disposer) removes the kind, and every session's stream refolds without it.
   * @param extractor - the kind, its data version, and its two pure functions.
   * @returns the exact disposer that unregisters this extractor.
   */
  register<D>(extractor: ContentSurfaceExtractor<D>): () => void {
    const erased = eraseExtractor(extractor)
    const dispose = this.ctx.effect(() => {
      this.extractors.add(erased)
      this.resync()
      return () => {
        this.extractors.delete(erased)
        this.resync()
      }
    }, 'contentSurface.register()')
    return () => void dispose()
  }

  /** Replace the registered unit with one folding the table as it stands now. */
  private resync(): void {
    this.release()
    if (this.host === undefined) return
    this.unit = this.host.sessionProjections.register(contentSurfaceProjection([...this.extractors]))
  }

  /** Withdraw the registered unit, dropping its cached cells with it. */
  private release(): void {
    this.unit?.()
    this.unit = undefined
  }
}

export default ContentSurfaceRegistry
