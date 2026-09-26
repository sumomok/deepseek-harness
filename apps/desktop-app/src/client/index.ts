/**
 * Browser half of the desktop composition layer: the product name in the
 * sidebar brand row, and no current-version row in Settings → General, since
 * the desktop's own release version is shown on the update settings page.
 * @module @deepseek-ai/dsh-desktop-app/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (`ctx.locale`).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the Context.slots merge (`ctx.slots`).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the 'settings.general.item' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
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

/** List-entry id of ui-settings-general's current-version row. */
export const CURRENT_VERSION_ROW_ID = 'current-version'

/**
 * Priority below the row's default 0: of the entries sharing one list id, the
 * lowest priority renders, so this entry shadows ui-settings-general's row.
 */
export const CURRENT_VERSION_SHADOW_PRIORITY = -1

/**
 * Occupant that renders nothing in place of the current-version row.
 * @returns null.
 */
export function HiddenCurrentVersionRow(): null {
  return null
}

/**
 * Register the product-name dictionaries, occupy `sidebar.brand.name` once
 * ui-sidebar declares it, and shadow the Settings → General current-version
 * row once ui-settings-general declares its item list. The mark slot stays on
 * its fallback.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'desktop-brand: dictionaries')
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({
    name: 'sidebar.brand.name', locale: NS,
  }, DesktopBrandName))
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item', id: CURRENT_VERSION_ROW_ID, priority: CURRENT_VERSION_SHADOW_PRIORITY,
  }, HiddenCurrentVersionRow))
}
