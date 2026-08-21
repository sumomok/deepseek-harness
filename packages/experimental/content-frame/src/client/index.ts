/**
 * Content-frame browser half: claims the service-line shell's `content` column
 * and keeps one live frame per session.
 *
 * `content` is a `single`, `root` slot, so this registration is the column's
 * only occupant and the framework never remounts it. Session transitions are
 * therefore the component's own business: it reads the current session and
 * that session's `content` projection through the root standard hook, and
 * hides the frames it is not showing instead of destroying them.
 *
 * The cache bound is host configuration, and a browser half receives no cordis
 * config — the boot manifest carries plugin names, not their `config` blocks —
 * so apply reads it from the node half's settings route before claiming the
 * column. A failed read fails the row: a column that silently used some other
 * bound would be indistinguishable from one that honored it.
 * @module @deepseek-ai/dsh-experimental-content-frame/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the service-line shell's `content` SlotMap declaration.
import type {} from '@deepseek-ai/dsh-experimental-server-layout/client'
// Type-only: pulls this package's own `content` SessionProjectionMap merge.
import type {} from '../types.ts'
import { CONTENT_SETTINGS_ROUTE, type ContentFrameSettings } from '../route.ts'
import { ContentFrame } from './ContentFrame.tsx'
import { en, NS, zh, type ContentFrameKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The content column's copy. */
    contentFrame: ContentFrameKey
  }
}

export type { ContentFrameFace, ContentFrameProps } from './ContentFrame.tsx'

/** Required services: the slot registry and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Read the browser-facing half of this plugin's configuration from its node half.
 * @returns the settings the node half serves.
 * @throws {Error} when the route is unreachable, answers non-200, or answers a
 * document without a usable cache bound.
 */
async function readSettings(): Promise<ContentFrameSettings> {
  const response = await fetch(CONTENT_SETTINGS_ROUTE, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`content-frame: ${CONTENT_SETTINGS_ROUTE} answered ${response.status}`)
  }
  const settings = await response.json() as Partial<ContentFrameSettings>
  const cacheSize = settings.cacheSize
  // A wire boundary: the document crossed a process, so its own contract is
  // checked here rather than trusted from the type.
  if (typeof cacheSize !== 'number' || !Number.isInteger(cacheSize) || cacheSize < 1) {
    throw new Error(`content-frame: ${CONTENT_SETTINGS_ROUTE} answered an unusable cacheSize: ${JSON.stringify(cacheSize)}`)
  }
  return { cacheSize, ...settings.defaultPage === undefined ? {} : { defaultPage: settings.defaultPage } }
}

/**
 * Client plugin body: register the dictionaries and claim the content column.
 * @param ctx - client root context.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'content-frame: dictionaries')
  const settings = await readSettings()
  ctx.slots.inject('content', () => ctx.slots.register({
    name: 'content',
    locale: NS,
    // Configuration is settled in the apply world and handed over as plain
    // data; the component reads none of its own.
    inject: () => settings,
  }, ContentFrame))
}
