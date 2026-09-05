/**
 * The two server-menu literals both halves of this package are defined
 * against, in a module that imports nothing.
 *
 * They live here rather than in `workflows.ts` because the browser half reads
 * them as values, and `workflows.ts` imports `@deepseek-ai/dsh-settings` and
 * `@deepseek-ai/schemastery` for the durable schema — a value import of that
 * module from the client tree pulls both into the browser bundle, which the
 * client-bundle purity gate refuses (see `packages/client/tsdown.client.ts`).
 * `route.ts` keeps this package's HTTP paths for the same reason.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/menu-constants
 */

/**
 * Group id the 临时工作流 section reserves. That section's rows are derived
 * from the live session list rather than stored (see the browser half's
 * `temporarySessions`), and its title comes from the locale dictionary rather
 * than from a stored `name`, so nothing durable is ever filed under this id:
 * `validateServerMenu` refuses both a stored group claiming it and a workflow
 * naming it. Its one live use is as the section's key in the browser-local
 * collapse map, which is not a document.
 *
 * Not a UUID, so a group a user creates cannot collide with it.
 */
export const TEMPORARY_GROUP_ID = 'temporary'

/**
 * Longest a user-typed group name may be, in UTF-16 code units. Both halves
 * hold it: the durable schema refuses a longer name, and the naming field
 * caps its own input rather than letting a write travel to the route just to
 * be refused.
 */
export const MAX_GROUP_NAME_LENGTH = 40
