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
 * `contentSurface` projection the host half contributes to, which the framework
 * already carries to the browser with every session's values.
 * @module @deepseek-ai/dsh-experimental-component-surface/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the content column's `content.surface.kind` SlotMap declaration.
import type {} from '@deepseek-ai/dsh-experimental-content-column/client'
import { NS } from '@deepseek-ai/dsh-experimental-component-kit/client'
import { ComponentSurface } from './ComponentSurface.tsx'

export type { ComponentSurfaceProps } from './ComponentSurface.tsx'

/**
 * Required services: the slot registry, and the locale registry the component
 * row's dictionary lands in — this seat translates through that dictionary and
 * has none of its own.
 */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: claim the column's `component` kind.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('content.surface.kind', () => ctx.slots.register({
    name: 'content.surface.kind',
    // The literal, not this package's `COMPONENT_KIND`: the client-slot catalog
    // generator reads keyed registrations by static string, and an identifier
    // here drops this row's key from the generated catalog.
    key: 'component',
    locale: NS,
  }, ComponentSurface))
}
