/**
 * The product name the shell shows: the loading page's wordmark, the
 * recovering notification's title, and, through `scripts/client-build.ts`,
 * the served UI's browser title. It is display text only: `productName` in
 * `electron-builder.yml`, which the artifact names and the app bundle are
 * built from, stays `DSH Desktop`.
 * @module @deepseek-ai/dsh-desktop-shell/brand
 */

/** The product name in each shell language, keyed like the labels in [[@deepseek-ai/dsh-desktop-shell/menu-text]]. */
export const PRODUCT_NAME = { zh: '北冥', en: 'Beiming' } as const
