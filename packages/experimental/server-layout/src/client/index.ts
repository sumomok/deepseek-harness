/**
 * Service-line shell, browser half: a drop-in replacement for the shipped
 * `dsh-client-ui-layout` root registration, composed by disabling that row and
 * inserting this one (`overlay/three-column.patch.yml`). Both cannot load
 * together — 'root' is a single slot, and its child slots may be declared only
 * once.
 *
 * Replacing the shell means honoring everything the shipped one published, or
 * its registrants break: the same five child slot keys with the same kinds,
 * scopes, and owner shares (reused here by type rather than redeclared, so the
 * documentation stays in one place), the same `ctx.layout` face, the same
 * `usePanelInfo` root standard hook, and the same document-level theme
 * projection. On top of that this shell declares one new key — `content`, the
 * column this product line is built around.
 *
 * The provide-then-register order inside one synchronous effect is what makes
 * the shipped registrants work unchanged: ui-conversation, ui-workspace, and
 * ui-sidebar-right inject `layout`, so the service must exist before the slots
 * those registrants wait on are declared.
 * @module @deepseek-ai/dsh-experimental-server-layout/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the session standard props (useSessions).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls ui-theme's Context merge (ctx.theme + the theme/change event).
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { PanelFace } from './panel-face.ts'
import { createPanelStore } from './stores.ts'
import { projectTheme, retractTheme } from './theme-projection.ts'
import { ShellFrame } from './ShellFrame.tsx'
import { en, NS, zh, type ServerLayoutKey } from './locales.ts'

export type { ServerLayoutKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The whole center column, this shell's own seat and the reason it exists:
     * the resident work surface between the session list and the chat column.
     * EMPTY in every shipped composition — registering here claims the column
     * outright, and the shell's own placeholder disappears with the first
     * registration.
     *
     * Root-scoped, unlike the chat column beside it: the occupant mounts once
     * for the page's lifetime and no session transition can remount it. The
     * column is meant to hold DOM state a session switch must not destroy — an
     * iframe's live document is the case this shell was built for, and under
     * `session-maybe` the renderer's adoption rule (`SessionMaybeEntry`) kills
     * that document on every switch after the first. The occupant reads the
     * main view's session through the root standard hook (`useSessions`: the
     * row whose `retainedBy.mainView` count is positive) and decides for
     * itself what a switch changes. It receives no owner props.
     */
    'content': { kind: 'single'; scope: 'root'; owner: ContentOwnerProps }
  }

  interface LocaleNamespaceMap {
    /** This shell's own copy (the empty content column). */
    serverLayout: ServerLayoutKey
  }
}

/** Content owner share: empty — the column's occupant owns its whole surface. */
export interface ContentOwnerProps {}

/** Required services: the slot registry, the theme registry, and the locale registry. */
export const inject = ['slots', 'theme', 'locale']

/**
 * Client plugin body: dictionaries, then the service-plus-registration effect,
 * then the theme projection.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'server-layout: dictionaries')

  ctx.effect(() => {
    // One store instance per effect run: the face binds its actions before the
    // root entry first renders, and the registration hands the same instance
    // to the frame (`create` returns it rather than a fresh one).
    const handle = createPanelStore()
    const instance = handle.create()
    const store: typeof handle = { ...handle, create: () => instance }
    const panelInfo: HostObservable<PanelInfo> = {
      getSnapshot: () => instance.getSnapshot().panelInfo,
      subscribe: listener => instance.subscribe(listener),
    }
    const mainKeys = (): string[] => ctx.slots.entries('main').flatMap(entry =>
      entry.options.key === undefined ? [] : [entry.options.key])
    const face = new PanelFace(instance.actions, id => mainKeys().includes(id), panelInfo)
    const disposePanelInfo = ctx.slots.provideRoot({ hooks: { panelInfo } })
    const disposeService = ctx.reflect.provide('layout', face)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      locale: NS,
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'content': { kind: 'single', scope: 'root' },
        'main': { kind: 'keyed', scope: 'root' },
        'rightbar': { kind: 'single', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
        'shell.leading': { kind: 'single', scope: 'root' },
      },
      store,
    }, ShellFrame)
    // A selection whose `main` entry unregistered falls back to the Conversation.
    const retainMainPanels = (): void => { instance.actions.retainMainPanels(mainKeys()) }
    const disposePanels = ctx.slots.subscribe('main', retainMainPanels)
    retainMainPanels()
    return () => {
      face.dispose()
      disposePanels()
      disposeRegistration()
      disposePanelInfo()
      // provide()'s disposer settles asynchronously; teardown is synchronous fire-and-forget.
      void disposeService()
    }
  }, 'server-layout: layout service + root registration')

  ctx.effect(() => {
    let applied = projectTheme(ctx.theme.getTheme(), [])
    const off = ctx.on('theme/change', (snapshot) => { applied = projectTheme(snapshot, applied) })
    return () => {
      off()
      retractTheme(applied)
    }
  }, 'server-layout: theme projection')
}
