/**
 * Favorites HTTP client: the browser half of this package's own favorites
 * route. Same-package import of `../route.ts` — this is this package's own
 * wire agreement with itself, not the cross-package kind `pages.ts` and
 * `open-page.ts` avoid.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/favorites-api
 */
import { SERVER_MENU_FAVORITES_ROUTE } from '../route.ts'
import type { ServerMenuFavorite } from '../favorites.ts'

export type { ServerMenuFavorite } from '../favorites.ts'

/** Narrow one decoded array entry to a usable {@link ServerMenuFavorite}. */
function isFavorite(value: unknown): value is ServerMenuFavorite {
  const candidate = value as Partial<ServerMenuFavorite> | null
  return typeof candidate === 'object' && candidate !== null
    && typeof candidate.sessionId === 'string'
    && typeof candidate.label === 'string'
    && typeof candidate.order === 'number'
}

/**
 * Read the current favorites list.
 *
 * Failure is contained rather than thrown, for the same reason
 * `pages.ts#readContentPages` contains its own: a deployment without the
 * settings capability composed (so this package's own node half never claims
 * the route) is an ordinary, expected composition, and the favorites menu
 * group renders empty rather than taking the sidebar down with it.
 * @returns the current favorites, in whatever order the server answered;
 * empty when the route is unreachable, answers non-200, or answers an
 * unusable document.
 */
export async function readFavorites(): Promise<ServerMenuFavorite[]> {
  try {
    const response = await fetch(SERVER_MENU_FAVORITES_ROUTE, { cache: 'no-store' })
    if (!response.ok) return []
    const body = await response.json() as { favorites?: unknown }
    return Array.isArray(body.favorites) ? body.favorites.filter(isFavorite) : []
  } catch {
    return []
  }
}

/**
 * Replace the whole favorites list. The caller always posts the complete
 * next list (add/rename/remove are pure list transforms applied before this
 * call), matching the route's whole-value replace contract.
 * @param favorites - the complete next favorites list.
 * @returns the server's authoritative resulting list.
 * @throws {Error} when the request fails transport-level, answers non-200,
 * or answers a document with no usable `favorites` array; the message names
 * the server's own refusal text when one was given.
 */
export async function saveFavorites(favorites: readonly ServerMenuFavorite[]): Promise<ServerMenuFavorite[]> {
  const response = await fetch(SERVER_MENU_FAVORITES_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ favorites }),
  })
  const body = await response.json().catch(() => undefined) as { favorites?: unknown; error?: unknown } | undefined
  if (!response.ok) {
    throw new Error(typeof body?.error === 'string' ? body.error : `favorites save failed: HTTP ${String(response.status)}`)
  }
  if (!Array.isArray(body?.favorites)) {
    throw new Error('favorites save answered no usable favorites list')
  }
  return body.favorites.filter(isFavorite)
}
