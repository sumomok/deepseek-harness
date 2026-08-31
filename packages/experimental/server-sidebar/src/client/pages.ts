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

/** What {@link readContentPages} resolves: the menu's catalog plus the optional auto-show page. */
export interface ContentPages {
  /** The configured pages, in declaration order; empty when the route is unreachable or unusable. */
  pages: MenuPage[]
  /** Page id to show automatically on a blank workbench draft; absent when unconfigured or invalid. */
  homePage?: string
}

/** Narrow one decoded array entry to a usable {@link MenuPage}. */
function isMenuPage(value: unknown): value is MenuPage {
  return typeof value === 'object' && value !== null
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { title?: unknown }).title === 'string'
}

/**
 * Validate the settings document's `homePage` field against the pages this
 * same response already resolved.
 *
 * This is the browser half's own read of a value the node half already
 * validates at load (see `dsh-experimental-content-frame`'s `Config`
 * documentation) — a wire boundary gets its own check rather than trusting
 * the producer, but unlike the node half's load-time failure, a browser
 * reader that fails loud here would take the whole sidebar down over one
 * misconfigured field on an otherwise-working deployment. A bad value is
 * therefore contained: reported with `console.warn` and treated as absent.
 * @param value - the decoded `homePage` field, of unknown shape.
 * @param pages - this same response's already-resolved page catalog.
 * @returns `value` when it names one of `pages`, otherwise `undefined`.
 */
function validateHomePage(value: unknown, pages: readonly MenuPage[]): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    console.warn(`server-sidebar: content-frame homePage is not a string: ${JSON.stringify(value)}`)
    return undefined
  }
  if (!pages.some(page => page.id === value)) {
    console.warn(`server-sidebar: content-frame homePage "${value}" names no configured page`)
    return undefined
  }
  return value
}

/**
 * Read the deployment's configured content-column pages and its optional
 * auto-show home page.
 *
 * Failure is contained rather than thrown: this sidebar is a load-bearing
 * shell surface (session navigation lives in it), and a deployment that does
 * not compose `dsh-experimental-content-frame` at all is an ordinary,
 * expected composition — the page-navigation menu group renders empty
 * instead of taking the whole sidebar down with it.
 * @returns the configured pages and home page; the page list is empty and
 * `homePage` absent when the route is unreachable, answers non-200, or
 * answers an unusable document.
 */
export async function readContentPages(): Promise<ContentPages> {
  try {
    const response = await fetch(CONTENT_FRAME_SETTINGS_ROUTE, { cache: 'no-store' })
    if (!response.ok) return { pages: [] }
    const settings = await response.json() as { pages?: unknown; homePage?: unknown }
    const pages = Array.isArray(settings.pages) ? settings.pages.filter(isMenuPage).map(page => ({ id: page.id, title: page.title })) : []
    const homePage = validateHomePage(settings.homePage, pages)
    return { pages, ...homePage === undefined ? {} : { homePage } }
  } catch {
    return { pages: [] }
  }
}
