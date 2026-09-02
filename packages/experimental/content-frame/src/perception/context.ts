/**
 * The `content:column` prompt context: what the column holds, on every request.
 *
 * A tool result tells the model what a page said once; this tells it what is on
 * screen now, before it decides whether to ask. It is registered as a prompt
 * *context* rather than a section for the reason `approval:policy` is: the
 * value changes as the user works, and a context is materialized after the
 * retained history, so a column that moved does not rewrite the stable
 * system-prompt prefix the provider caches.
 *
 * Both readings are of this session's own projections, which is what keeps the
 * model-visible half reconstructable from the log: every entry came from an
 * event, and so did every address. Nothing is timestamped — a relative time
 * would differ between a live run and its replay, and the conversation the
 * model reads already carries the order in which things happened.
 * @module @deepseek-ai/dsh-experimental-content-frame/perception/context
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { ContentSurfaceEntry, ContentSurfaceView } from '@deepseek-ai/dsh-experimental-content-surface/types'
import type { PageIndex } from '../pages.ts'
import { PAGE_KIND } from '../surface.ts'
import type { ContentPagesState } from '../types.ts'
import { columnContextText, type ColumnContextBounds, type ContextEntry } from './text.ts'

/**
 * Prompt order of the content-column context. It follows `approval:policy`'s
 * `115` and stays inside the same band: both describe the state the model is
 * about to act in, and this one is read against the tool guidance above it —
 * `content_show` and `content_read` own what their arguments mean, and this
 * says what they would be acting on.
 */
export const CONTENT_COLUMN_CONTEXT_ORDER = 130

/**
 * Turn one live entry into the line the context lists it as.
 * @param entry - the entry, as the `contentSurface` view resolved it.
 * @param front - the pair the stream says is in front, when there is one.
 * @param state - the `contentPages` fold: who opened each page and where it went.
 * @param pages - the validated page index, for the address a page was opened at.
 * @returns the entry as the context names it.
 */
function contextEntry(
  entry: ContentSurfaceEntry,
  front: ContentSurfaceView['front'],
  state: ContentPagesState,
  pages: PageIndex,
): ContextEntry {
  const inFront = front !== undefined && front.kind === entry.kind && front.entryId === entry.entryId
  const named = { kind: entry.kind, title: entry.title, front: inFront }
  if (entry.kind !== PAGE_KIND) return named
  const record = state[entry.entryId]
  const at = record?.location
  // The address is worth a line only when it says something the page id does
  // not: a frame still sitting where it was opened is already described.
  const location = at !== undefined && at.url !== pages.get(entry.entryId)?.url ? at : undefined
  return {
    ...named,
    ...record?.by === undefined ? {} : { by: record.by },
    ...location === undefined ? {} : { location },
  }
}

/**
 * Compose the context for one assembly.
 * @param ctx - the context carrying the projection registry.
 * @param pages - the validated page index.
 * @param canRead - whether this deployment offers `content_read`.
 * @param bounds - what this deployment spends on the context.
 * @param assemble - the assembly this text is being built for.
 * @returns the block, or an empty string for an assembly with no session.
 */
function columnContext(
  ctx: Context,
  pages: PageIndex,
  canRead: boolean,
  bounds: ColumnContextBounds,
  assemble: AssembleContext,
): string {
  const agent = assemble.agent
  // A bare assemble() (tests, diagnostics) has no session, so no column.
  if (agent === undefined) return ''
  // `snapshot` computes every registered client-visible unit's view, not only
  // this one. The whole repository registers a handful, and the alternative —
  // folding the entry stream here — would duplicate content-surface's own fold.
  const surface = ctx.sessionProjections.snapshot(agent.session).values.contentSurface
  const state = ctx.sessionProjections.stateOf(agent.session, 'contentPages') ?? {}
  const entries = (surface?.entries ?? []).map(entry => contextEntry(entry, surface?.front, state, pages))
  return columnContextText(entries, canRead, bounds)
}

/**
 * Register the content-column context on a composition that assembles prompts.
 *
 * Both services are optional seams: an assembly with no system prompt has
 * nowhere to put this, and one with no projection registry has no column to
 * describe.
 * @param ctx - plugin context.
 * @param pages - the validated page index.
 * @param canRead - whether this deployment offers `content_read`.
 * @param bounds - what this deployment spends on the context.
 */
export function registerColumnContext(
  ctx: Context,
  pages: PageIndex,
  canRead: boolean,
  bounds: ColumnContextBounds,
): void {
  ctx.inject(['systemPrompt', 'sessionProjections'], (scope: Context) => {
    scope.systemPrompt.context({
      name: 'content:column',
      order: CONTENT_COLUMN_CONTEXT_ORDER,
      text: assemble => columnContext(scope, pages, canRead, bounds, assemble),
    })
  })
}
