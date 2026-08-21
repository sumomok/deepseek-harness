/**
 * Service-line shell, browser half: a drop-in replacement for the shipped
 * `dsh-client-ui-layout` root registration, composed by disabling that row and
 * inserting this one (`overlay/three-column.patch.yml`). Both cannot load
 * together — 'root' is a single slot, and its four child slots may be declared
 * only once.
 *
 * Replacing the shell means honoring everything the shipped one published, or
 * its registrants break: the same four child slot keys with the same kinds,
 * scopes, and owner shares (reused here by type rather than redeclared, so the
 * documentation stays in one place), the same `ctx.layout` face, and the same
 * document-level theme projection. On top of that this shell declares one new
 * key — `content`, the center column this product line is built around.
 *
 * The provide-then-register order inside one synchronous effect is what makes
 * the shipped registrants work unchanged: ui-sidebar and ui-conversation both
 * inject `layout` and both register into these child slots without waiting for
 * a declaration, so the service must exist before the slots do.
 * @module @deepseek-ai/dsh-experimental-server-layout/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls ui-theme's Context merge (ctx.theme + the theme/change event).
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
// Type-only: pulls ui-layout's ctx.layout Context merge and the four shipped
// child-slot declarations, which this shell reuses rather than restates.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { BoundPanelActions } from './panel-face.ts'
import { createPanelFace } from './panel-face.ts'
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
     * Current-session-optional, matching the chat column: the occupant owns
     * both the no-session and the live-session state without changing its React
     * identity, so it keeps its own state across a session switch. It receives
     * no owner props; session facts arrive through the framework hooks of the
     * `session-maybe` scope.
     */
    'content': { kind: 'single'; scope: 'session-maybe'; owner: ContentOwnerProps }
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

  const face = createPanelFace()
  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', face.layout)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      locale: NS,
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'content': { kind: 'single', scope: 'session-maybe' },
        'conversation': { kind: 'single', scope: 'session-maybe' },
        'details': { kind: 'single', scope: 'session' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
      // Exclusive store: the factory itself — the framework instantiates per
      // entry and delivers useStore/actions to the frame as standard props.
      store: createPanelStore,
      // The hook's only side effect connects the root store to ctx.layout.
      inject: (actions: BoundPanelActions) => {
        face.attach(actions)
        return {}
      },
    }, ShellFrame)
    return () => {
      disposeRegistration()
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
