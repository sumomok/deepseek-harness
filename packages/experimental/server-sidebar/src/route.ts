/**
 * The two HTTP paths this package is defined against: the one its
 * workbench/workflow feature reads and writes, and the one its browser half
 * reads its own identity settings from. Neither is configurable — the node
 * half and the browser half must agree on them, and nothing outside this
 * package addresses them.
 *
 * The value is the path the node half registers, which is root-absolute
 * because a reverse proxy serving this shell under a path prefix strips that
 * prefix before the request arrives. The browser half puts the prefix back by
 * resolving this constant with `clientUrl`, and never requests it as it stands.
 *
 * Other wire agreements live outside this file, by design: the browser half
 * also reads the two navigation catalogs
 * (`@deepseek-ai/dsh-experimental-content-frame`'s `/content-frame/settings`
 * and `@deepseek-ai/dsh-experimental-component-surface`'s
 * `/component-surface/views`) and executes each catalog's own command
 * (`show-content-page` and `show-content-view`) for a menu click and for a
 * workflow's navigation-snapshot replay. All four are hardcoded literals in
 * the browser half rather than values imported from those packages — see
 * `src/client/nav-catalog.ts` and `src/client/open-nav.ts` for why. The
 * sign-out button copies `@deepseek-ai/dsh-experimental-auth-gate`'s
 * `/auth-gate/settings` and `/auth-gate/logout` paths the same way, for the
 * same reason (`src/client/sign-out.ts`).
 */

/**
 * Exact route this package's node half serves. `GET`/`HEAD` answer the
 * current server-menu document; `POST` merges a patch into it (any subset of
 * `{ workflows, groups, workbenchSessionId }` — a caller changing only one
 * field never has to resend the others, since the underlying settings write is
 * a merge, not a wholesale replace).
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
