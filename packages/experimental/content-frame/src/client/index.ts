/**
 * Content-frame browser half: it claims the `page` key of the content column's
 * kind slot and keeps one live frame per (session, page) pair.
 *
 * `content.surface.kind` is keyed and open, and the key is the entry kind its
 * host extractor produces, so claiming this package's own kind is additive:
 * every other kind keeps the renderer it had. The seat is root-scoped and the
 * column keeps it mounted while other kinds are on display, which is what lets
 * this row hide frames instead of destroying them.
 *
 * The cache bound is host configuration, and a browser half receives no cordis
 * config — the boot manifest carries plugin names, not their `config` blocks —
 * so apply reads it from the node half's settings route before claiming the
 * key. A failed read fails the row: a column that silently used some other
 * bound would be indistinguishable from one that honored it.
 * @module @deepseek-ai/dsh-experimental-content-frame/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the content column's `content.surface.kind` SlotMap declaration.
import type {} from '@deepseek-ai/dsh-experimental-content-column/client'
// Type-only: pulls this package's own `content` SessionProjectionMap merge.
import type {} from '../types.ts'
import { CONTENT_SETTINGS_ROUTE, type ContentFrameSettings } from '../route.ts'
import { ContentFrame } from './ContentFrame.tsx'
import { en, NS, zh, type ContentFrameKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The page seat's copy. */
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
  return { cacheSize }
}

/**
 * Client plugin body: register the dictionaries and claim the page kind.
 * @param ctx - client root context.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'content-frame: dictionaries')
  const settings = await readSettings()
  ctx.slots.inject('content.surface.kind', () => ctx.slots.register({
    name: 'content.surface.kind',
    // The literal, not this package's `PAGE_KIND`: the client-slot catalog
    // generator reads keyed registrations by static string, and an identifier
    // here drops this row's key from the generated catalog.
    key: 'page',
    locale: NS,
    // Configuration is settled in the apply world and handed over as plain
    // data; the component reads none of its own.
    inject: () => settings,
  }, ContentFrame))
}
