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
 * Every entry is otherwise derived from a fact another package already logs —
 * `content/shown` for a page, a `show_chart` call for a chart — so replay
 * reconstructs the whole column from the log the agent actually wrote. The
 * one exception this router owns directly is dismissal: closing an entry's
 * tab in the switcher strip is not a fact any other package's log already
 * carries, so this row appends `content-surface/dismissed` itself and the
 * fold removes the named record on sight (see `command.ts` and
 * `projection.ts`).
 *
 * One model-visible contribution, the prompt section below: what an entry
 * stream needs the model to understand is that a piece of content stays one
 * piece of content across turns, which is the same sentence for every kind.
 * It reaches the model through the assembled system prompt, which the routed
 * request header already records, so it adds no session event of its own.
 * @module @deepseek-ai/dsh-experimental-content-surface
 */

import { Context, Service } from '@deepseek-ai/cordis'
// Type-only: resolves ctx.sessionProjections for the optional projection child.
import type {} from '@deepseek-ai/dsh-session-projection'
// Type-only: resolves ctx.systemPrompt for the optional prompt-section child.
import type {} from '@deepseek-ai/dsh-system-prompt'
// Type-only: resolves ctx.commands for the optional dismiss-content-entry command child.
import type {} from '@deepseek-ai/dsh-commands'
import { eraseExtractor, type ContentSurfaceExtractor, type ErasedExtractor } from './extractor.ts'
import { contentSurfaceProjection } from './projection.ts'
import { dismissContentEntryCommand } from './command.ts'

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
 * Prompt order of the on-display rule. It sits past the `100–199` tool-guidance
 * band because it is read against whatever each tool just said about its own
 * arguments: the rule tells the model WHEN to reuse an identity, and each tool
 * schema owns what that identity is called. Nothing registers a later section
 * today, so this is the last thing the assembled prompt says.
 */
const ON_DISPLAY_SECTION_ORDER = 200

/**
 * The rule that makes a follow-up land on the entry already in the column.
 *
 * Kind-agnostic and tool-agnostic on purpose: it names no chart, no page, and
 * no argument, so a kind registered later inherits it with no edit here, and it
 * stays true in a composition whose kinds this package has never heard of. The
 * producing tools keep their own trigger wording; the two layers were measured
 * together and neither is redundant, which the
 * [Agent Note](../../../../.agents/notes/implemented/feature/2026-08-24-content-on-display-rule.md)
 * records with the numbers.
 */
const ON_DISPLAY_RULE = '# Working with content already on display\n\n'
  + 'When the user refers to something you have already produced and put on display — quoting it, naming its title, or otherwise pointing at it — and asks for a change, update that same piece of content in place through the tool that produced it, reusing its identity, rather than producing a new one beside it.'

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
    // Optional for the same reason, and unconditional in the table: the rule
    // describes what the user does, not what any kind can draw, so gating it on
    // a registered kind would make the prompt depend on hot-load timing while
    // saving nothing a real composition ever spends.
    ctx.inject(['systemPrompt'], (promptCtx: Context) => {
      promptCtx.systemPrompt.section({
        name: 'content:on-display',
        order: ON_DISPLAY_SECTION_ORDER,
        text: ON_DISPLAY_RULE,
      })
    })
    // Optional for the same reason again: a deployment without a command
    // runtime keeps the extractor table and the switcher's close button has
    // nowhere to dispatch to, same as any other command-backed UI gesture.
    ctx.inject(['commands'], (commandsCtx: Context) => {
      commandsCtx.commands.register(dismissContentEntryCommand())
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
