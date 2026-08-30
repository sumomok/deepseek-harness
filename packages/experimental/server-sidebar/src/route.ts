/**
 * The one HTTP path this package's workbench/workflow feature is defined
 * against. Not configurable — the node half and the browser half must agree
 * on it, and nothing outside this package addresses it.
 *
 * A second, unrelated wire agreement lives outside this file, by design: the
 * browser half also reads `@deepseek-ai/dsh-experimental-content-frame`'s
 * `/content-frame/settings` route (for the navigation menu's catalog) and
 * executes that package's `show-content-page` command (for a page click and
 * for a workflow's navigation-snapshot replay). Both are hardcoded literals
 * in the browser half rather than values imported from that package — see
 * `src/client/pages.ts` and `src/client/open-page.ts` for why.
 */

/**
 * Exact route this package's node half serves. `GET`/`HEAD` answer the
 * current server-menu document; `POST` merges a patch into it (any subset of
 * `{ workflows, workbenchSessionId }` — a caller changing only one field
 * never has to resend the other, since the underlying settings write is a
 * merge, not a wholesale replace).
 */
export const SERVER_MENU_ROUTE = '/server-menu/workflows'
