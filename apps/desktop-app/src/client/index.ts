/**
 * Browser half of the desktop composition layer: the larger fish logo and the
 * product name in the sidebar brand row, no current-version row in
 * Settings → General, since the desktop's own release version is shown on the
 * update settings page, and no "create a plugin with the Agent" action in the
 * Plugins page's add-plugin menu.
 * @module @deepseek-ai/dsh-desktop-app/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (`ctx.locale`).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the 'plugins.add.actions' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: pulls the Context.slots merge (`ctx.slots`).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the 'settings.general.item' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the 'sidebar.brand.mark' and 'sidebar.brand.name' SlotMap entries.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { DesktopBrandMark } from './BrandMark.tsx'
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
 * List-entry id of ui-agent-preset's add-plugin menu action, which starts a
 * Creator-mode session that writes a plugin.
 */
export const CREATE_PLUGIN_ACTION_ID = 'create-plugin'

/**
 * Priority below the action's default 0, so this entry shadows
 * ui-agent-preset's action the way {@link CURRENT_VERSION_SHADOW_PRIORITY}
 * shadows the current-version row.
 */
export const CREATE_PLUGIN_SHADOW_PRIORITY = -1

/**
 * Occupant that renders nothing in place of the create-plugin action, so the
 * add-plugin menu holds no item for it, focusable or not.
 * @returns null.
 */
export function HiddenCreatePluginAction(): null {
  return null
}

/**
 * Register the product-name dictionaries, occupy `sidebar.brand.mark` and
 * `sidebar.brand.name` once ui-sidebar declares them, shadow the
 * Settings → General current-version row once ui-settings-general declares its
 * item list, and shadow the add-plugin menu's create-plugin action once
 * ui-plugin-manager declares `plugins.add.actions`. Creator mode stays
 * reachable from Settings → Agent presets and the new-session preset chip.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'desktop-brand: dictionaries')
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark' }, DesktopBrandMark))
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({
    name: 'sidebar.brand.name', locale: NS,
  }, DesktopBrandName))
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item', id: CURRENT_VERSION_ROW_ID, priority: CURRENT_VERSION_SHADOW_PRIORITY,
  }, HiddenCurrentVersionRow))
  ctx.slots.inject('plugins.add.actions', () => ctx.slots.register({
    name: 'plugins.add.actions', id: CREATE_PLUGIN_ACTION_ID, priority: CREATE_PLUGIN_SHADOW_PRIORITY,
  }, HiddenCreatePluginAction))
}
