/**
 * Desktop composition layer, node half. The empty apply gives the Loader a
 * host-side row for the `desktop-brand` entry; the browser half ships through
 * `exports["./client"]`.
 * @module @deepseek-ai/dsh-desktop-app
 */

/** Host plugin body: this package contributes browser presentation only. */
export function apply(): void {}
