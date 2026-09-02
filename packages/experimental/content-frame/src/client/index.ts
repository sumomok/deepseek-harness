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
 *
 * Two more registrations live in this same `apply()`: empty
 * `conversation.chat.commandview` entries for `SHOW_CONTENT_PAGE_COMMAND` and
 * `CONTENT_NAVIGATED_COMMAND`, plus the stylesheet collapsing the empty rows
 * they leave behind (see `HiddenCommandRow.tsx` and
 * `hide-empty-command-row.ts`) — the sidebar's page-navigation click and the
 * seat's own navigation reports are command invocations for their durable log
 * records, not for chat messages narrating them.
 * @module @deepseek-ai/dsh-experimental-content-frame/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the content column's `content.surface.kind` SlotMap declaration.
import type {} from '@deepseek-ai/dsh-experimental-content-column/client'
// Type-only: pulls ui-conversation's `conversation.chat.commandview` SlotMap declaration.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the tool package's `tool.call.toolview` SlotMap declaration.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
// Type-only: pulls this package's own `content` SessionProjectionMap merge.
import type {} from '../types.ts'
import { CONTENT_SETTINGS_ROUTE, type ContentFrameAccessSettings } from '../route.ts'
import { ContentFrame, type ContentFrameFace } from './ContentFrame.tsx'
import { ContentReadRow } from './access/ContentReadRow.tsx'
import { reportNavigation } from './perception/navigated.ts'
import { HiddenCommandRow } from './HiddenCommandRow.tsx'
import { installHiddenCommandRowStyle } from './hide-empty-command-row.ts'
import { en, NS, zh, type ContentFrameKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The page seat's copy. */
    contentFrame: ContentFrameKey
  }
}

export type { ContentFrameFace, ContentFrameProps } from './ContentFrame.tsx'
export type { ContentReadRowProps } from './access/ContentReadRow.tsx'

/** Required services: the slot registry, the locale registry, and remote commands (the navigation report's dispatch). */
export const inject = ['slots', 'locale', 'remote', 'remote.commands']

/**
 * Whether one served value is a usable positive whole number.
 * @param value - the field as the settings document carried it.
 * @returns whether it can be used as a bound.
 */
function isBound(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

/**
 * Read the page-access half of the settings document.
 *
 * Absent is the deployment's answer that the agent may not read the page, and
 * the whole reader stays uninstalled; present but unusable is a broken
 * settings document, which fails the row like any other.
 * @param served - the `pageAccess` field, as the settings document carried it.
 * @returns the reader's settings, or undefined when the deployment configured none.
 * @throws {Error} when the field is present and unusable.
 */
function readAccess(served: unknown): ContentFrameAccessSettings | undefined {
  if (served === undefined) return undefined
  if (served !== null && typeof served === 'object') {
    const access = served as {
      outlineChars?: unknown
      claimTimeoutMs?: unknown
      readTimeoutMs?: unknown
      settleQuietMs?: unknown
      actTimeoutMs?: unknown
      maxSteps?: unknown
      settleMaxMs?: unknown
    }
    if (
      isBound(access.outlineChars) && isBound(access.claimTimeoutMs)
      && isBound(access.readTimeoutMs) && isBound(access.settleQuietMs)
      && isBound(access.actTimeoutMs) && isBound(access.maxSteps) && isBound(access.settleMaxMs)
    ) {
      return {
        outlineChars: access.outlineChars,
        claimTimeoutMs: access.claimTimeoutMs,
        readTimeoutMs: access.readTimeoutMs,
        settleQuietMs: access.settleQuietMs,
        actTimeoutMs: access.actTimeoutMs,
        maxSteps: access.maxSteps,
        settleMaxMs: access.settleMaxMs,
      }
    }
  }
  throw new Error(`content-frame: ${CONTENT_SETTINGS_ROUTE} answered an unusable pageAccess: ${JSON.stringify(served)}`)
}

/**
 * Read the browser-facing half of this plugin's configuration from its node
 * half, and assemble the face the seat receives.
 *
 * The settings document also carries `pages` (read by the sidebar's
 * page-navigation menu, not by this seat), so only the fields this seat needs
 * are typed and validated here.
 * @param onNavigated - the seat's navigation reporter, which is a client-side
 * capability rather than a served value and rides the same face.
 * @returns the two bounds the node half configured, the navigation callback,
 * and the reader's settings when the deployment configured page access.
 * @throws {Error} when the route is unreachable, answers non-200, or answers a
 * document without a usable bound.
 */
async function readSettings(onNavigated: ContentFrameFace['onNavigated']): Promise<ContentFrameFace> {
  const response = await fetch(CONTENT_SETTINGS_ROUTE, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`content-frame: ${CONTENT_SETTINGS_ROUTE} answered ${response.status}`)
  }
  const settings = await response.json() as { cacheSize?: unknown; navigationPollMs?: unknown; pageAccess?: unknown }
  const cacheSize = settings.cacheSize
  // A wire boundary: the document crossed a process, so its own contract is
  // checked here rather than trusted from the type.
  if (!isBound(cacheSize)) {
    throw new Error(`content-frame: ${CONTENT_SETTINGS_ROUTE} answered an unusable cacheSize: ${JSON.stringify(cacheSize)}`)
  }
  const navigationPollMs = settings.navigationPollMs
  if (!isBound(navigationPollMs)) {
    throw new Error(`content-frame: ${CONTENT_SETTINGS_ROUTE} answered an unusable navigationPollMs: ${JSON.stringify(navigationPollMs)}`)
  }
  const pageAccess = readAccess(settings.pageAccess)
  return { cacheSize, navigationPollMs, onNavigated, ...pageAccess === undefined ? {} : { pageAccess } }
}

/**
 * Client plugin body: register the dictionaries, claim the page kind, and
 * hide both browser-driven commands' chat echoes.
 * @param ctx - client root context.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'content-frame: dictionaries')
  ctx.effect(() => installHiddenCommandRowStyle(), 'content-frame: hide empty command row')
  const settings = await readSettings((sessionId, page, url, title) => {
    void reportNavigation(ctx, sessionId, page, url, title)
  })
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
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
    name: 'conversation.chat.commandview',
    // The literal, not `SHOW_CONTENT_PAGE_COMMAND`: the client-slot catalog
    // generator reads keyed registrations by static string (see the sibling
    // registration above).
    key: 'show-content-page',
  }, HiddenCommandRow))
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
    name: 'conversation.chat.commandview',
    // A literal for the same catalog reason as the registration above.
    key: 'content-navigated',
  }, HiddenCommandRow))
  // The transcript row exists only where the tool does: a deployment that
  // configures no page access serves no `pageAccess`, offers the model no
  // `content_read`, and gets no row for calls that can never appear.
  if (settings.pageAccess === undefined) return
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    // The literal, not this package's `CONTENT_READ_TOOL_NAME`, for the same
    // catalog reason as the two registrations above.
    key: 'content_read',
    locale: NS,
  }, ContentReadRow))
}
