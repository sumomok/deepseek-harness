/**
 * The two HTTP paths this package is defined against: the one its
 * workbench/workflow feature reads and writes, and the one its browser half
 * reads its own identity settings from. Neither is configurable — the node
 * half and the browser half must agree on them, and nothing outside this
 * package addresses them.
 *
 * A second, unrelated wire agreement lives outside this file, by design: the
 * browser half also reads `@deepseek-ai/dsh-experimental-content-frame`'s
 * `/content-frame/settings` route (for the navigation menu's catalog) and
 * executes that package's `show-content-page` command (for a page click and
 * for a workflow's navigation-snapshot replay). Both are hardcoded literals
 * in the browser half rather than values imported from that package — see
 * `src/client/pages.ts` and `src/client/open-page.ts` for why. The sign-out
 * button copies `@deepseek-ai/dsh-experimental-auth-gate`'s
 * `/auth-gate/settings` and `/auth-gate/logout` paths the same way, for the
 * same reason (`src/client/sign-out.ts`).
 */

/**
 * Exact route this package's node half serves. `GET`/`HEAD` answer the
 * current server-menu document; `POST` merges a patch into it (any subset of
 * `{ workflows, workbenchSessionId }` — a caller changing only one field
 * never has to resend the other, since the underlying settings write is a
 * merge, not a wholesale replace).
 */
export const SERVER_MENU_ROUTE = '/server-menu/workflows'

/**
 * Exact route this package's node half serves the browser half's own
 * identity settings on. `GET`/`HEAD` answer {@link ServerIdentitySettings};
 * nothing writes it.
 *
 * It exists because a browser half receives no cordis config — the boot
 * manifest carries plugin names, not their `config` blocks — so a `Config`
 * field the browser must obey has to be served to it (the same reason
 * `@deepseek-ai/dsh-experimental-auth-gate` serves its own settings route).
 */
export const SERVER_IDENTITY_ROUTE = '/server-menu/identity'

/** The browser-facing half of this package's configuration. */
export interface ServerIdentitySettings {
  /**
   * Claim of the deployment's access token that carries the signed-in
   * person's display name. Never a value, always the claim's name: the token
   * itself stays in the browser.
   */
  displayNameClaim: string
}
