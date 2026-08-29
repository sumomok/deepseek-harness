/**
 * The one HTTP path this package's favorites feature is defined against. Not
 * configurable — the node half and the browser half must agree on it, and
 * nothing outside this package addresses it.
 *
 * A second, unrelated wire agreement lives outside this file, by design: the
 * browser half also reads `@deepseek-ai/dsh-experimental-content-frame`'s
 * `/content-frame/settings` route (for the page-navigation menu's catalog)
 * and executes that package's `show-content-page` command (for a page
 * click). Both are hardcoded literals in the browser half rather than values
 * imported from that package — see `src/client/pages.ts` and
 * `src/client/open-page.ts` for why.
 */

/**
 * Exact route this package's node half serves. `GET`/`HEAD` answer the
 * current favorites document; `POST` replaces it wholesale (the browser half
 * always posts the complete next list, never a partial patch).
 */
export const SERVER_MENU_FAVORITES_ROUTE = '/server-menu/favorites'
