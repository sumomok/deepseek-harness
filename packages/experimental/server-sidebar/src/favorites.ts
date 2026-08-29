/**
 * Favorites domain: the durable shape, its schema, and the settings namespace
 * this package's node half registers.
 *
 * Persistence is per-account because it rides the settings capability: the
 * local file provider's document lives at `$DSH_HOME/settings.yaml`, and this
 * deployment shape is one process per signed-in user (see the package
 * README's favorites section). A favorite is a weak reference to a session id
 * — see {@link ServerMenuFavorite} — because nothing here owns session
 * deletion and a stale pointer must not corrupt the document it lives in.
 */

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** Settings namespace this package owns. */
export const SERVER_SIDEBAR_NAMESPACE: SettingsNamespace = settingsNamespace('server-sidebar')

/**
 * One favorited session, as the user named it. `sessionId` is a weak
 * reference: this package never observes session deletion, so a favorite
 * naming a session the workspace domain no longer lists is expected, not
 * corrupt — the menu renders it as a removable, non-navigable row rather than
 * silently dropping it (see the package README).
 */
export interface ServerMenuFavorite {
  /** The favorited session's id. */
  sessionId: string
  /** The user's own name for the favorite, shown instead of the session's own title. */
  label: string
  /** Display order among favorites, ascending; ties break on `sessionId`. */
  order: number
}

/** Durable section this package's namespace resolves to. */
export interface ServerMenuSettings {
  /** Every favorite, in no particular storage order — `order` is what the menu sorts by. */
  favorites: ServerMenuFavorite[]
}

/** Durable schema; also the wire shape both favorites routes validate against. */
export const ServerMenuSettingsSchema: z<ServerMenuSettings> = z.object({
  favorites: z.array(z.object({
    sessionId: z.string().required(),
    label: z.string().required(),
    order: z.number().required(),
  })).default([]),
})

/**
 * Reject a favorites list with a duplicate session id — the one constraint
 * the schema alone cannot express (schemastery validates shape, not
 * cross-element uniqueness).
 * @param value - the resolved section, schema-valid by construction.
 * @throws {Error} when two entries name the same session.
 */
export function validateFavorites(value: ServerMenuSettings): void {
  const seen = new Set<string>()
  for (const favorite of value.favorites) {
    if (seen.has(favorite.sessionId)) {
      // Unprefixed: this message's one consumer (the favorites route's error
      // response) adds the "server-sidebar:" prefix itself, alongside every
      // other write failure it wraps the same way.
      throw new Error(`duplicate favorite for session "${favorite.sessionId}"`)
    }
    seen.add(favorite.sessionId)
  }
}
