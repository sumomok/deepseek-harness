/**
 * The content surface's browser half: it claims the service-line shell's
 * `content` column and opens one keyed seat per content kind inside it.
 *
 * `content` is a `single`, `root` slot, so this registration is the column's
 * only occupant, and every kind that wants the column registers into
 * `content.surface.kind` instead of competing for the seat. That is the whole
 * point of the row: the shell's one column becomes an open key domain, and a
 * feature package contributes a renderer without knowing which other kinds
 * exist.
 *
 * The row reads no configuration and serves no route: what the column shows is
 * the host's `contentSurface` projection, which the framework already carries
 * to the browser with every session's values.
 *
 * A second, independent registration lives in this same `apply()`: an empty
 * `conversation.chat.commandview` entry for `DISMISS_CONTENT_ENTRY_COMMAND`,
 * plus the stylesheet collapsing the empty row it leaves behind (see
 * `HiddenCommandRow.tsx` and `hide-empty-command-row.ts`) — the switcher
 * strip's close button is a command invocation for its durable log record,
 * not for a chat message narrating the click.
 * @module @deepseek-ai/dsh-experimental-content-column/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the service-line shell's `content` SlotMap declaration.
import type {} from '@deepseek-ai/dsh-experimental-server-layout/client'
// Type-only: pulls ui-conversation's `conversation.chat.commandview` SlotMap declaration.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the host half's `contentSurface` SessionProjectionMap merge.
import type { ContentSurfaceEntry } from '@deepseek-ai/dsh-experimental-content-surface/types'
import { ContentSurface, type ContentSurfaceInjected } from './ContentSurface.tsx'
import { dismissContentEntry } from './dismiss.ts'
import { HiddenCommandRow } from './HiddenCommandRow.tsx'
import { installHiddenCommandRowStyle } from './hide-empty-command-row.ts'
import { en, NS, zh, type ContentSurfaceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Keyed content-column renderer, dispatched by an entry's `kind`. Register
     * with `key: '<kind>'` to own how one kind of content draws in the column;
     * the key domain is open — it is whatever kind a host extractor produces —
     * so there is no compile-time key set and an unclaimed kind renders the
     * column's own "nothing renders this" notice.
     *
     * Root-scoped, like the column itself: every registered kind's seat mounts
     * once for the page's lifetime and is hidden rather than unmounted while
     * another kind is on display, so a renderer holding DOM the column must not
     * destroy — a live iframe is the case this router was built around — keeps
     * it across both an entry switch and a session switch. A seat is therefore
     * rendered far more often than it is selected, and reads `entry` to know
     * which it is.
     */
    'content.surface.kind': { kind: 'keyed'; scope: 'root'; owner: ContentSurfaceKindOwnerProps }
  }

  interface LocaleNamespaceMap {
    /** The content column's own copy (the switcher strip and its two notices). */
    contentSurface: ContentSurfaceKey
  }
}

/**
 * Owner share of one kind seat. Both members are plain data, and an entry is
 * never present without the session it belongs to.
 */
export interface ContentSurfaceKindOwnerProps {
  /** The session whose surface the column shows, or undefined while none is current. */
  sessionId: string | undefined
  /**
   * The selected entry while it belongs to this seat's kind; undefined while
   * another kind is on display or the session has no entries. A seat receiving
   * undefined keeps whatever it holds — it is hidden, not gone.
   */
  entry: ContentSurfaceEntry | undefined
}

export type { ContentSurfaceInjected, ContentSurfaceProps } from './ContentSurface.tsx'

/** Required services: the slot registry, the locale registry, and remote commands (the close button's dispatch). */
export const inject = ['slots', 'locale', 'remote', 'remote.commands']

/**
 * Client plugin body: register the dictionaries, claim the content column,
 * and hide the dismiss-content-entry command's chat echo.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'content-column: dictionaries')
  ctx.effect(() => installHiddenCommandRowStyle(), 'content-column: hide empty command row')
  ctx.slots.inject('content', () => ctx.slots.register({
    name: 'content',
    locale: NS,
    children: { 'content.surface.kind': { kind: 'keyed', scope: 'root' } },
    inject: (): ContentSurfaceInjected => ({
      onDismiss: (sessionId, kind, entryId) => { void dismissContentEntry(ctx, sessionId, kind, entryId) },
    }),
  }, ContentSurface))
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
    name: 'conversation.chat.commandview',
    // The literal, not this package's own copy of the command name: the
    // client-slot catalog generator reads keyed registrations by static
    // string, and an identifier here drops this row's key from the
    // generated catalog (see `content-frame`'s equivalent registration).
    key: 'dismiss-content-entry',
  }, HiddenCommandRow))
}
