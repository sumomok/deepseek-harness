/**
 * show-component browser half: it claims the `component` key of the content
 * column's kind slot and draws each entry's validated spec through the
 * component row.
 *
 * `content.surface.kind` is keyed and open, and the key is the kind this
 * package's host half produces, so claiming it is additive: every other kind
 * keeps the seat it had. The registration goes through `slots.inject` because a
 * composition without the column never declares the slot, and this row must
 * then simply not install rather than fail.
 *
 * The renderer table is a value import across packages, which the client bundle
 * purity gate allows only for a declared module request: the manifest's
 * `dsh.client.external` names the component row's `/client` specifier, and the
 * loader answers the require from that row's own materialized bundle. The
 * modules node half orders the component row ahead of this one.
 *
 * The seat's copy comes from that row's dictionary too — `componentKit` is
 * named at this registration rather than duplicated here, because which
 * components exist is the row's fact and the sentence shown in place of one it
 * does not have belongs with the components.
 *
 * This half reads no configuration and serves no route: what it draws is the
 * `contentSurface` and `componentActions` projections the host half contributes
 * to, which the framework already carries to the browser with every session's
 * values — the first is the entry on display, the second is what became of each
 * gesture reported out of it. What leaves it is one command line per gesture —
 * `/component-action`, dispatched through `remote.commands` by the face this
 * registration injects, the same seam the column's own close button uses.
 *
 * The one state neither projection can carry is a press that has left the page
 * and has no record yet, and this registration is where it is kept: one
 * `PendingPresses` table for the page's life, injected alongside the dispatch.
 * It has to outlive the seat, because the column unmounts a kind's blocks
 * whenever the user picks another entry — and a block that lost its own waiting
 * on the way there would come back answerable and take the same decision
 * twice.
 *
 * Two further, independent registrations live in the same `apply()`: the chat
 * rows of the two commands this package owns (see `ActionCommandRow.tsx` and
 * `ViewCommandRow.tsx`). Both are dispatched for the durable record they write,
 * not to narrate in chat something the user just did themselves, so both rows
 * draw nothing for the settlement the host simply took and the handler's own
 * sentence for the one the person who clicked could not otherwise learn about.
 * @module @deepseek-ai/dsh-experimental-component-surface/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the content column's `content.surface.kind` SlotMap declaration.
import type {} from '@deepseek-ai/dsh-experimental-content-column/client'
// Type-only: pulls ui-conversation's `conversation.chat.commandview` SlotMap declaration.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS } from '@deepseek-ai/dsh-experimental-component-kit/client'
import { postAction, type PendingPresses } from './action.ts'
import { ActionCommandRow } from './ActionCommandRow.tsx'
import { ComponentSurface, type ComponentSurfaceInjected } from './ComponentSurface.tsx'
import { ViewCommandRow } from './ViewCommandRow.tsx'

export type { ComponentSurfaceInjected, ComponentSurfaceProps } from './ComponentSurface.tsx'

/**
 * Required services: the slot registry, the locale registry the component row's
 * dictionary lands in — this seat translates through that dictionary and has
 * none of its own — and remote commands, which is how a gesture inside a block
 * reaches the session.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.commands']

/**
 * Client plugin body: claim the column's `component` kind, and take over both
 * of this package's commands' chat rows.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // One table per page, not per mounted seat: the rows in it are exactly the
  // presses whose records have not come back, and every seat this registration
  // ever mounts reads and writes the same ones.
  const pending: PendingPresses = new Map()
  ctx.slots.inject('content.surface.kind', () => ctx.slots.register({
    name: 'content.surface.kind',
    // The literal, not this package's `COMPONENT_KIND`: the client-slot catalog
    // generator reads keyed registrations by static string, and an identifier
    // here drops this row's key from the generated catalog.
    key: 'component',
    locale: NS,
    inject: (): ComponentSurfaceInjected => ({
      onAction: (sessionId, action) => postAction(ctx, sessionId, action),
      pending,
    }),
  }, ComponentSurface))
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
    name: 'conversation.chat.commandview',
    // The literal, not this package's own `COMPONENT_ACTION_COMMAND`, for the
    // same reason as the key above.
    key: 'component-action',
  }, ActionCommandRow))
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
    name: 'conversation.chat.commandview',
    // The literal, not `SHOW_CONTENT_VIEW_COMMAND`, for the same reason as the
    // two keys above. The row is registered wherever this seat is, including a
    // deployment that configures no views: the key is free either way, and a
    // command that is never invoked has no row to draw.
    key: 'show-content-view',
  }, ViewCommandRow))
}
