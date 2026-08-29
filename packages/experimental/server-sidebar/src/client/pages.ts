/**
 * Reads `@deepseek-ai/dsh-experimental-content-frame`'s configured page
 * catalog for the page-navigation menu group.
 *
 * The route path is a literal copy of that package's `CONTENT_SETTINGS_ROUTE`
 * rather than an imported value, and the response shape is locally validated
 * (the same wire-validation style content-frame's own client uses for
 * `cacheSize`) rather than trusted from an imported type — a cross-package
 * value import is not this repository's sanctioned way to couple two
 * client-adjacent plugins (`packages/client/AGENTS.md`'s export-discipline
 * section). Both packages are fork-owned together in this deployment and
 * must keep this route path in agreement.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/pages
 */

/** Must match `@deepseek-ai/dsh-experimental-content-frame`'s `CONTENT_SETTINGS_ROUTE`. */
const CONTENT_FRAME_SETTINGS_ROUTE = '/content-frame/settings'

/** One configured page, as the menu needs it. */
export interface MenuPage {
  /** Stable id passed to the `show-content-page` command. */
  readonly id: string
  /** Human-facing name shown in the menu. */
  readonly title: string
}

/** Narrow one decoded array entry to a usable {@link MenuPage}. */
function isMenuPage(value: unknown): value is MenuPage {
  return typeof value === 'object' && value !== null
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { title?: unknown }).title === 'string'
}

/**
 * Read the deployment's configured content-column pages.
 *
 * Failure is contained rather than thrown: this sidebar is a load-bearing
 * shell surface (session navigation lives in it), and a deployment that does
 * not compose `dsh-experimental-content-frame` at all is an ordinary,
 * expected composition — the page-navigation menu group renders empty
 * instead of taking the whole sidebar down with it.
 * @returns the configured pages, in declaration order; empty when the route
 * is unreachable, answers non-200, or answers an unusable document.
 */
export async function readContentPages(): Promise<MenuPage[]> {
  try {
    const response = await fetch(CONTENT_FRAME_SETTINGS_ROUTE, { cache: 'no-store' })
    if (!response.ok) return []
    const settings = await response.json() as { pages?: unknown }
    if (!Array.isArray(settings.pages)) return []
    return settings.pages.filter(isMenuPage).map(page => ({ id: page.id, title: page.title }))
  } catch {
    return []
  }
}
