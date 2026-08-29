/**
 * Service-line shell sidebar, browser half: a drop-in replacement for the
 * shipped `dsh-client-ui-sidebar` root registration, composed by disabling
 * that row and inserting this one (`overlay/sidebar-menu.patch.yml`). Both
 * cannot load together — `sidebar` is a single slot and its five child slots
 * may be declared only once.
 *
 * Replacing the shell means honoring everything the shipped one published, or
 * its registrants break: the same `ctx.slots.register` children keys, kinds,
 * and scopes (reused here by type rather than redeclared — see
 * `ServerSidebarRoot.tsx`'s module doc — so ui-workspace's and ui-settings's
 * existing registrations keep working with zero changes), the same fold
 * geometry and pointer-driven scrollbar behavior (`ServerSidebarRoot.tsx`,
 * ported from `SidebarRoot.tsx`), and the same New Session / toggle actions.
 * The shipped `dsh-client-ui-sidebar` entry has no host-side behavior beyond
 * this — its own node half is `export function apply(): void {}` — so
 * nothing else needed carrying over; this package's own node half exists
 * only for the favorites feature (see the package root's `src/index.ts`).
 *
 * On top of that contract this shell adds one thing: the page-navigation and
 * favorites menu (`MenuSection.tsx`), seated between the New Session button
 * and the workspace browser. Page navigation reads
 * `dsh-experimental-content-frame`'s configured pages and executes its
 * `show-content-page` command — both through hardcoded literals rather than
 * an import, because a cross-package value import is not this repository's
 * sanctioned way to couple two client-adjacent plugins (see `pages.ts`'s and
 * `open-page.ts`'s module docs). Favorites are this package's own durable
 * feature, backed by its node half's settings namespace and HTTP route.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls ui-layout's ctx.layout Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import { readContentPages } from './pages.ts'
import { openContentPage } from './open-page.ts'
import { readFavorites, saveFavorites, type ServerMenuFavorite } from './favorites-api.ts'
import { createFavoritesStore } from './favorites-store.ts'
import { ServerSidebarRoot, type ServerSidebarInjected } from './ServerSidebarRoot.tsx'
import { en, zh, type ServerSidebarKey } from './locales.ts'

export type { ServerSidebarInjected, ServerSidebarRootComponentProps } from './ServerSidebarRoot.tsx'
export type { ServerSidebarKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This shell's own copy (shell controls plus the two menu groups). */
    serverSidebar: ServerSidebarKey
  }
}

/** Dictionary namespace owned by this plugin (shell controls plus the two menu groups). */
const NS = 'serverSidebar'

/** Bound favorites-store actions, as the store registration's inject factory receives them. */
type BoundFavoritesActions = BoundActions<ReturnType<typeof createFavoritesStore>>

/** Required services: the slot registry, the layout face, sessions/workspaces, locale, and remote commands. */
export const inject = ['slots', 'layout', 'sessions', 'workspaces', 'locale', 'remote', 'remote.commands']

/**
 * Persist the next favorites list and commit the server's authoritative
 * answer into the store, or surface the failure inline.
 * @param next - the complete next favorites list.
 * @param actions - the entry's bound favorites-store actions.
 */
async function persistFavorites(next: ServerMenuFavorite[], actions: BoundFavoritesActions): Promise<void> {
  try {
    const saved = await saveFavorites(next)
    actions.setFavorites(saved)
  } catch (error) {
    actions.setError(error instanceof Error ? error.message : String(error))
  }
}

/**
 * Client plugin body: dictionaries, then the read-before-register fetches
 * (this package's own settings-read pattern, matching
 * `dsh-experimental-content-frame`'s), then the root registration.
 * @param ctx - client root context.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'server-sidebar: dictionaries')

  const [pages, favorites] = await Promise.all([readContentPages(), readFavorites()])

  ctx.effect(
    () => ctx.slots.register({
      name: 'sidebar',
      locale: NS,
      // The shell owns geometry and the menu region; ui-workspace registers
      // the whole browsing region, ui-settings the foot trigger + panel —
      // unchanged from the shipped contract. Declaring is claiming: this
      // object restates dsh-client-ui-sidebar's own five child declarations
      // verbatim (an unavoidable duplicate — every registrant of a slot
      // states its own children regardless of an identical prior claim).
      /* jscpd:ignore-start */
      children: {
        'sidebar.brand.mark': { kind: 'single', scope: 'root' },
        'sidebar.brand.name': { kind: 'single', scope: 'root' },
        'sidebar.workspaces': { kind: 'single', scope: 'root' },
        'sidebar.settings': { kind: 'single', scope: 'root' },
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
      },
      /* jscpd:ignore-end */
      store: createFavoritesStore(favorites),
      inject: (actions: BoundFavoritesActions): ServerSidebarInjected => ({
        // The shell's New Session button rides the runtime's shared action
        // (current Session Workspace, then recent Workspace).
        startSession: (workspaceId) => { ctx.workspaces.startSession(workspaceId) },
        toggleSidebar: () => { ctx.layout.toggleSidebar() },
        pages,
        onOpenPage: pageId => openContentPage(ctx, pageId),
        // Wire boundary: a favorite's sessionId crossed the favorites HTTP
        // route as plain JSON, so it is cast to the branded id here rather
        // than trusted from an imported type (the menu already disables a
        // stale favorite's row, so this path only fires for a live session).
        onOpenSession: (sessionId) => { ctx.sessions.open(sessionId as SessionId) },
        onSaveFavorites: next => persistFavorites(next, actions),
      }),
    }, ServerSidebarRoot),
    'server-sidebar: slot registration',
  )
}
