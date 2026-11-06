/** The private product applications this repository ships outside npm. */

/**
 * Private product applications that the desktop and PWA releases assemble. Each carries its own product version and
 * publishes nothing to npm, so none is a release member, has a publication files policy, or carries the workspace
 * version, and none is a default installation of the `dsh` product whose experimental isolation the default-product
 * gate checks.
 */
export const PRIVATE_PRODUCT_APP_DIRECTORIES: ReadonlySet<string> = new Set([
  'apps/desktop-app',
  'apps/desktop-server',
  'apps/desktop-shell',
  'apps/pwa',
])
