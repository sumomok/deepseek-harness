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
 * What the seat draws with is `ctx.componentRenderers`, the browser half of the
 * catalog seam this row installs here: a component plugin's browser half
 * registers its definitions and its renderers into it, and a page with none
 * loaded draws its own "nothing here can draw this block" line rather than
 * failing to build. That line and the two beside it are this row's copy, in its
 * own `contentComponent` namespace, because which components exist is a
 * deployment's runtime fact and the sentence shown in place of a missing one
 * belongs to whoever does the lookup and misses.
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
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the content column's `content.surface.kind` SlotMap declaration.
import type {} from '@deepseek-ai/dsh-experimental-content-column/client'
// Type-only: pulls ui-conversation's `conversation.chat.commandview` SlotMap declaration.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { postAction, type PendingPresses } from './action.ts'
import { joinActComponentChannel, type ActComponentWiring } from './act-channel.ts'
import { ActionCommandRow } from './ActionCommandRow.tsx'
import { ComponentSurface, type ComponentSurfaceInjected } from './ComponentSurface.tsx'
import { en, NS, zh } from './locales.ts'
import { ComponentRendererRegistry } from './registry.ts'
import { ViewCommandRow } from './ViewCommandRow.tsx'

export { COMPONENT_KIT_ENTRIES } from '../component-call.ts'
export { NS } from './locales.ts'
export { ComponentRendererRegistry } from './registry.ts'
export type { ContentComponentKey } from './locales.ts'
export type {
  BrowserComponent,
  BrowserContribution,
  ComponentRendererTable,
  RegisteredRenderer,
} from './registry.ts'
export type {
  ComponentActionHandler,
  ComponentActionPayload,
  ComponentActionState,
  ComponentOutputHandler,
  ComponentRenderer,
  ComponentRendererProps,
} from './renderer.ts'
export type { ComponentSurfaceInjected, ComponentSurfaceProps } from './ComponentSurface.tsx'
export type { ActComponentSeatCall, ActComponentWiring } from './act-channel.ts'
export type { ActComponentRun } from './act-executor.ts'
export type { DrawnEntry } from './entry-container.ts'
export type { ViewCommandRowProps } from './ViewCommandRow.tsx'

/**
 * Required services: the slot registry, the locale registry this row's own
 * dictionary lands in, and remote commands, which is how a gesture inside a
 * block reaches the session.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.commands']

/**
 * Client plugin body: install the renderer registry, register this row's
 * dictionaries, claim the column's `component` kind, and take over both of this
 * package's commands' chat rows.
 *
 * The registry is installed here and the component plugins that fill it wait
 * for it through `ctx.inject`, so composition order between this row and any
 * component row is free.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // One table per page, not per mounted seat: the rows in it are exactly the
  // presses whose records have not come back, and every seat this registration
  // ever mounts reads and writes the same ones.
  const pending: PendingPresses = new Map()
  // What the seat offers through until the channel row is composed, and what it
  // offers through afterwards; a page with no channel answerers nothing.
  let channelWiring: ActComponentWiring = {
    offer: () => {},
    park: () => {},
  }
  ctx.plugin(ComponentRendererRegistry)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'show-component: dictionaries')
  // The seat answers `act_component` calls through the content channel another
  // row provides. Without that row there is no way for a call to reach this
  // tab, and the seat is mounted without one rather than failing to load: what
  // a deployment loses is the tool, which the host half offers only where the
  // same service is composed.
  ctx.inject(['contentTabChannel'], (channelCtx) => {
    const actChannel = joinActComponentChannel(channelCtx.contentTabChannel)
    channelWiring = actChannel
    return () => { actChannel.park() }
  })
  ctx.inject(['componentRenderers'], (seatCtx) => {
    seatCtx.slots.inject('content.surface.kind', () => seatCtx.slots.register({
      name: 'content.surface.kind',
      // The literal, not this package's `COMPONENT_KIND`: the client-slot catalog
      // generator reads keyed registrations by static string, and an identifier
      // here drops this row's key from the generated catalog.
      key: 'component',
      locale: NS,
      inject: (): ComponentSurfaceInjected => ({
        onAction: (sessionId, action) => postAction(seatCtx, sessionId, action),
        pending,
        // A page with no channel row is handed a wiring that does nothing:
        // there is no tab-side answerer for the host to reach, which the host
        // half reads the same way and offers no tool for.
        offerCalls: (sessionId, calls) => { channelWiring.offer(sessionId, calls) },
        parkCalls: () => { channelWiring.park() },
        // The live registry rather than a snapshot of it: a component row loaded
        // after this seat mounted is drawable at the next render, and one
        // disposed stops being drawn rather than leaving the seat holding a
        // renderer nothing registered.
        components: seatCtx.componentRenderers,
      }),
    }, ComponentSurface))
  })
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
