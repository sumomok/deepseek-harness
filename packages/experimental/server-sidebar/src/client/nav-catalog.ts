/**
 * The 导航 (navigation) menu's catalog: the two deployment-configured sources
 * it is built from, the row shape it hands the menu, and how one automatic
 * home is resolved out of the pair.
 *
 * Two packages configure something a click can put in the content column, and
 * the menu offers both: `@deepseek-ai/dsh-experimental-content-frame`'s pages
 * (a hosted application in an iframe) and
 * `@deepseek-ai/dsh-experimental-component-surface`'s views (a composed block
 * of interface). Each publishes its catalog over its own same-origin route,
 * and each row carries which of the two it came from, because the two are
 * opened by different commands and land as different content-surface entry
 * kinds. Pages come first in the merged menu, then views, each in the order
 * its own deployment config declares them: navigation order follows
 * deployment configuration and is never user-reordered (decision ⑤), and a
 * fixed source order keeps that true across the pair without a third
 * configuration field to keep in step.
 *
 * Both route paths are literal copies of the owning packages' own constants
 * rather than imported values, and each response is locally validated rather
 * than trusted from an imported type — a cross-package value import is not
 * this repository's sanctioned way to couple two client-adjacent plugins
 * (`packages/client/AGENTS.md`'s export-discipline section). All three
 * packages are fork-owned together in this deployment and must keep these
 * paths in agreement; `tests/nav-catalog.client.spec.ts` imports each owning
 * constant to make the copies mechanically checkable, since a drift would
 * otherwise show as a silently shorter menu and nothing else.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/nav-catalog
 */

import { clientUrl } from '@deepseek-ai/dsh-client-connection/client'
import type { NavSnapshotItem, NavSnapshotKind } from '../workflows.ts'

/**
 * Must match `@deepseek-ai/dsh-experimental-content-frame`'s
 * `CONTENT_SETTINGS_ROUTE` (see the module doc).
 */
const CONTENT_FRAME_SETTINGS_ROUTE = '/content-frame/settings'

/**
 * Must match `@deepseek-ai/dsh-experimental-component-surface`'s
 * `COMPONENT_VIEWS_ROUTE` (see the module doc).
 */
const COMPONENT_SURFACE_VIEWS_ROUTE = '/component-surface/views'

/** One row of the navigation menu. */
export interface NavItem extends NavSnapshotItem {
  /** Human-facing name shown in the menu. */
  title: string
}

/** What one catalog read resolves: the menu rows it contributes, plus its own optional automatic home. */
export interface NavCatalog {
  /** The configured items, in declaration order; empty when the route is unreachable or unusable. */
  items: NavItem[]
  /** The item to show automatically on a clean workbench draft; absent when unconfigured or invalid. */
  home?: NavSnapshotItem
}

/** Where one catalog lives and what its document calls its two fields. */
interface CatalogSource {
  /** Which kind every row this source contributes carries. */
  kind: NavSnapshotKind
  /** Same-origin route serving the catalog document. */
  route: string
  /** Package name, as a warning about this source's own document names it. */
  owner: string
  /** Document field carrying the `{id, title}` listings. */
  listField: string
  /** Document field carrying the optional automatic-home id. */
  homeField: string
}

const CONTENT_FRAME_PAGES: CatalogSource = {
  kind: 'page',
  route: CONTENT_FRAME_SETTINGS_ROUTE,
  owner: 'content-frame',
  listField: 'pages',
  homeField: 'homePage',
}

const COMPONENT_SURFACE_VIEWS: CatalogSource = {
  kind: 'view',
  route: COMPONENT_SURFACE_VIEWS_ROUTE,
  owner: 'component-surface',
  listField: 'views',
  homeField: 'homeView',
}

/** Narrow one decoded listing to a usable `{id, title}` pair. */
function isListing(value: unknown): value is { id: string; title: string } {
  return typeof value === 'object' && value !== null
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { title?: unknown }).title === 'string'
}

/**
 * Validate one catalog document's automatic-home field against the items that
 * same response already resolved.
 *
 * This is the browser half's own read of a value the owning node half already
 * validates at load — a wire boundary gets its own check rather than trusting
 * the producer, but unlike the node half's load-time failure, a browser reader
 * that fails loud here would take the whole sidebar down over one misconfigured
 * field on an otherwise-working deployment. A bad value is therefore contained:
 * reported with `console.warn` and treated as absent.
 * @param value - the decoded home field, of unknown shape.
 * @param items - this same response's already-resolved items.
 * @param source - which catalog this is, for the warning text.
 * @returns the home target when `value` names one of `items`, otherwise `undefined`.
 */
function validateHome(
  value: unknown, items: readonly NavItem[], source: CatalogSource,
): NavSnapshotItem | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    console.warn(`server-sidebar: ${source.owner} ${source.homeField} is not a string: ${JSON.stringify(value)}`)
    return undefined
  }
  if (!items.some(item => item.entryId === value)) {
    console.warn(`server-sidebar: ${source.owner} ${source.homeField} "${value}" names nothing it configures`)
    return undefined
  }
  return { kind: source.kind, entryId: value }
}

/**
 * Read one deployment-configured catalog.
 *
 * Failure is contained rather than thrown: this sidebar is a load-bearing
 * shell surface (session navigation lives in it), and a deployment that
 * composes only one of the two owning packages — or neither — is an ordinary,
 * expected composition. That source contributes no rows instead of taking the
 * whole sidebar down with it.
 * @param source - which catalog to read (see {@link CatalogSource}).
 * @returns the catalog; `items` is empty and `home` absent when the route is
 * unreachable, answers non-200, or answers an unusable document.
 */
async function readCatalog(source: CatalogSource): Promise<NavCatalog> {
  try {
    const response = await fetch(clientUrl(source.route), { cache: 'no-store' })
    if (!response.ok) return { items: [] }
    const document = await response.json() as Record<string, unknown>
    const listed = document[source.listField]
    const items = Array.isArray(listed)
      ? listed.filter(isListing).map(({ id, title }): NavItem => ({ kind: source.kind, entryId: id, title }))
      : []
    const home = validateHome(document[source.homeField], items, source)
    return { items, ...home === undefined ? {} : { home } }
  } catch {
    return { items: [] }
  }
}

/**
 * Read content-frame's configured pages and its optional home page.
 * @returns the page half of the navigation catalog.
 */
export function readContentPages(): Promise<NavCatalog> {
  return readCatalog(CONTENT_FRAME_PAGES)
}

/**
 * Read component-surface's configured views and its optional home view.
 * @returns the view half of the navigation catalog.
 */
export function readContentViews(): Promise<NavCatalog> {
  return readCatalog(COMPONENT_SURFACE_VIEWS)
}

/**
 * Merge the two catalogs into the one menu the sidebar renders, and settle
 * which item (if any) opens automatically on a clean workbench draft.
 *
 * Configuring both automatic homes fails loud at load rather than picking one:
 * the content column shows one thing at a time, so a deployment that named two
 * has expressed an intent this shell cannot carry out, and silently honoring
 * whichever source is read first would leave the other configured value doing
 * nothing with nothing to say why.
 * @param pages - content-frame's half (see {@link readContentPages}).
 * @param views - component-surface's half (see {@link readContentViews}).
 * @returns the merged menu rows, pages first, and the single automatic home.
 * @throws {Error} when both packages configure an automatic home.
 */
export function mergeNavCatalogs(pages: NavCatalog, views: NavCatalog): NavCatalog {
  if (pages.home !== undefined && views.home !== undefined) {
    throw new Error(
      `server-sidebar: content-frame configures homePage "${pages.home.entryId}" and component-surface configures `
      + `homeView "${views.home.entryId}"; a deployment may configure one automatic home, not both`,
    )
  }
  const home = pages.home ?? views.home
  return { items: [...pages.items, ...views.items], ...home === undefined ? {} : { home } }
}
