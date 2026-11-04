/**
 * The IPC channel the app window's preload uses to report the palette the page
 * is painting. `preload.cts` mirrors the name because a sandboxed preload can
 * only require `electron`.
 * @module @deepseek-ai/dsh-desktop-shell/theme-channels
 */

/** Channel carrying one theme report from the window's page. */
export const THEME_CHANNEL = 'dsh-desktop:theme-report'
