/**
 * Browser half of the desktop composition layer: the product name in the
 * sidebar brand row.
 * @module @deepseek-ai/dsh-desktop-app/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (`ctx.locale`).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the Context.slots merge (`ctx.slots`).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the 'sidebar.brand.name' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { DesktopBrandName } from './BrandName.tsx'
import { en, NS, zh, type DesktopBrandKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The desktop product name. */
    'desktop-brand': DesktopBrandKey
  }
}

/** Required services: the UI slot registry and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Register the product-name dictionaries and occupy `sidebar.brand.name` once
 * ui-sidebar declares it. The mark slot stays on its fallback.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'desktop-brand: dictionaries')
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({
    name: 'sidebar.brand.name', locale: NS,
  }, DesktopBrandName))
}
