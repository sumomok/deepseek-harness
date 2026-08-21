/**
 * Content-frame browser half: claims the service-line shell's `content` column
 * with an iframe over this package's own route.
 *
 * `content` is a `single`, `session-maybe` slot, so this registration is the
 * column's only occupant. Its lifetime follows the renderer's adoption rule
 * (`SessionMaybeEntry`): the incarnation the page boots into adopts the first
 * session that arrives, so the frame survives that transition, and every later
 * session change is a fresh incarnation that reloads the hosted application.
 * @module @deepseek-ai/dsh-experimental-content-frame/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the service-line shell's `content` SlotMap declaration.
import type {} from '@deepseek-ai/dsh-experimental-server-layout/client'
import { CONTENT_APP_SRC } from '../route.ts'
import { ContentFrame } from './ContentFrame.tsx'
import { en, NS, zh, type ContentFrameKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The hosted frame's copy. */
    contentFrame: ContentFrameKey
  }
}

export type { ContentFrameFace, ContentFrameProps } from './ContentFrame.tsx'

/** Required services: the slot registry and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the dictionaries and claim the content column.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'content-frame: dictionaries')
  ctx.slots.inject('content', () => ctx.slots.register({
    name: 'content',
    locale: NS,
    // The URL is decided in the apply world and handed over as plain data; the
    // component composes no path of its own.
    inject: () => ({ src: CONTENT_APP_SRC }),
  }, ContentFrame))
}
