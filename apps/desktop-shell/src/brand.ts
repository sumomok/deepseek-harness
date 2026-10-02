/**
 * The product name the shell shows: the loading page's wordmark, the window
 * title (the boot page's `<title>` and the window's initial title), the titles
 * of the recovering notification, the stopped-server dialog and the
 * download-failure dialog, and, through `scripts/client-build.ts`, the served
 * UI's browser title. It is display text only: `productName` in
 * `electron-builder.yml`, which the artifact names and the app bundle are
 * built from, stays `DSH Desktop`, and so does what reads it through
 * `app.getName()` (the tray tooltip and menu, the macOS application menu, the
 * About dialog).
 * @module @deepseek-ai/dsh-desktop-shell/brand
 */

/** The product name in each shell language, keyed like the labels in [[@deepseek-ai/dsh-desktop-shell/menu-text]]. */
export const PRODUCT_NAME = { zh: '北冥', en: 'Beiming' } as const
