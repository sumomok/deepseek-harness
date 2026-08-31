/**
 * Product console sidebar, browser half: a drop-in replacement for the
 * shipped `dsh-client-ui-sidebar` root registration, composed by disabling
 * that row and inserting this one (`overlay/sidebar-menu.patch.yml`). Both
 * cannot load together — `sidebar` is a single slot and its child slots may
 * be declared only once.
 *
 * Decision ① replaces the shipped shell's whole session-browsing contract
 * with a fixed three-section console: 工作台 (workbench, a persistent default
 * conversation), 导航 (navigation, `dsh-experimental-content-frame`'s
 * configured pages), and 我的工作流 (my workflows, a user's own named
 * shortcuts). The four child slots this shell keeps —
 * `sidebar.brand.mark`/`sidebar.brand.name`/`sidebar.settings`/
 * `sidebar.footer.action` — are reused by type import exactly as the prior
 * design did (see `ServerSidebarRoot.tsx`'s module doc); `sidebar.workspaces`
 * is dropped outright, and the customer composition simply never composes
 * `ui-workspace` (see the package README).
 *
 * A second, independent registration lives in this same `apply()`: the
 * "存为工作流" session-header action (decision ③), seated in
 * `dsh-client-ui-conversation`'s additive `conversation.session.header.actions`
 * list rather than a sidebar-local "+" button. That registration is
 * session-scoped (one instance per open conversation) while the sidebar's own
 * workflow store is root-scoped (one instance for the whole page) — two
 * different scope keys mean the store framework never shares one instance
 * between them, so this module closes over the sidebar's own bound actions
 * (`sidebarActions`, below) to push a freshly saved workflow into the
 * sidebar's reactive list without a page reload. The sidebar registration
 * always mounts before a conversation can be open, so this reference is set
 * by the time a user could reach the header action.
 *
 * A third, independent registration takes over
 * `dsh-client-ui-conversation`'s `conversation.hero.brand.mark` seat with
 * nothing at all (decision ②'s brand takeover, matching the sidebar's own
 * fallback-less `sidebar.brand.mark` — see `ServerSidebarRoot.tsx`'s module
 * doc): registered at priority -1 so it wins the slot's shadowing rank
 * (ascending, lowest renders) even under an official build, where
 * `@deepseek-ai/dsh-client-ui-brand-official` fills the same seat at the
 * default priority 0 — customer overlays also disable that package outright
 * (see the package README), so this is belt-and-suspenders for a deployment
 * that forgets to.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls ui-layout's ctx.layout Context merge (unused directly here,
// but required for `PropsRuntime<'sidebar'>`'s owner-share type to resolve).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls dsh-client-ui-conversation's SlotMap declaration for
// 'conversation.session.header.actions'.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import { readContentPages } from './pages.ts'
import { openContentPage, openHomePage } from './open-page.ts'
import { readServerMenu, saveServerMenu, type ServerMenuWorkflow } from './workflow-api.ts'
import { createWorkflowStore } from './workflow-store.ts'
import {
  nextOrder, openWorkbenchOnClick, openWorkbenchOnLoad, openWorkflow,
} from './workflow-actions.ts'
import { ServerSidebarRoot, type ServerSidebarInjected } from './ServerSidebarRoot.tsx'
import { SaveWorkflowAction, type SaveWorkflowInjected } from './SaveWorkflowAction.tsx'
import { installTerminologyGuard } from './terminology-guard.ts'
import { en, zh, type ServerSidebarKey } from './locales.ts'

export type { ServerSidebarInjected, ServerSidebarRootComponentProps } from './ServerSidebarRoot.tsx'
export type { ServerSidebarKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This shell's own copy (workbench/navigation/workflow labels plus the header action). */
    serverSidebar: ServerSidebarKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'serverSidebar'

/** Bound workflow-store actions, as both registrations' inject factories may receive or reuse them. */
type BoundWorkflowActions = BoundActions<ReturnType<typeof createWorkflowStore>>

/**
 * Required services: the slot registry, sessions/workspaces, locale, and
 * remote commands. `layout`/`ui-conversation` are pulled type-only above.
 */
export const inject = ['slots', 'sessions', 'workspaces', 'locale', 'remote', 'remote.commands']

/**
 * Persist a server-menu patch and commit the server's authoritative answer
 * into the given bound actions, or surface the failure inline.
 * @param patch - the fields to change (see `workflow-api.ts#saveServerMenu`).
 * @param actions - the bound actions to commit the result (or the failure) into.
 */
async function persistServerMenu(
  patch: Partial<{ workflows: ServerMenuWorkflow[]; workbenchSessionId: string }>, actions: BoundWorkflowActions,
): Promise<void> {
  try {
    const saved = await saveServerMenu(patch)
    actions.setServerMenu(saved)
  } catch (error) {
    actions.setError(error instanceof Error ? error.message : String(error))
  }
}

/**
 * Client plugin body: dictionaries, the terminology guard, and the hero
 * brand-mark takeover, then the read-before-register fetches (this package's
 * own settings-read pattern, matching `dsh-experimental-content-frame`'s),
 * then the two slot registrations.
 * @param ctx - client root context.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'server-sidebar: dictionaries')
  ctx.effect(() => installTerminologyGuard(), 'server-sidebar: terminology guard')
  ctx.effect(
    () => ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register(
      { name: 'conversation.hero.brand.mark', priority: -1 },
      () => null,
    )),
    'server-sidebar: hero brand-mark takeover',
  )

  const [{ pages, homePage }, initialMenu] = await Promise.all([readContentPages(), readServerMenu()])
  const workflowStore = createWorkflowStore(initialMenu)

  // Set once the sidebar's own inject factory runs (see the module doc for
  // why the header action needs this rather than its own store instance).
  let sidebarActions: BoundWorkflowActions | undefined

  ctx.effect(
    () => ctx.slots.register({
      name: 'sidebar',
      locale: NS,
      // The shell owns geometry, the workbench entry, navigation, and
      // workflows; ui-settings the foot trigger + panel; any brand package
      // the two identity slots. `sidebar.workspaces` is deliberately absent
      // (see this module's own doc and the package README).
      children: {
        'sidebar.brand.mark': { kind: 'single', scope: 'root' },
        'sidebar.brand.name': { kind: 'single', scope: 'root' },
        'sidebar.settings': { kind: 'single', scope: 'root' },
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
      },
      store: workflowStore,
      inject: (actions: BoundWorkflowActions): ServerSidebarInjected => {
        sidebarActions = actions
        return {
          pages,
          onOpenPage: pageId => openContentPage(ctx, pageId),
          onOpenWorkbenchOnLoad: async (workbenchSessionId, isLive) => {
            const outcome = await openWorkbenchOnLoad(ctx, workbenchSessionId, isLive)
            if (outcome?.created === true) await persistServerMenu({ workbenchSessionId: outcome.sessionId }, actions)
          },
          onOpenWorkbench: async (workbenchSessionId, isLive, isBlank) => {
            const outcome = await openWorkbenchOnClick(ctx, workbenchSessionId, isLive, isBlank)
            if (outcome === undefined) return
            if (outcome.created) await persistServerMenu({ workbenchSessionId: outcome.sessionId }, actions)
            // Every outcome of a click lands on a blank draft (reused-blank or
            // freshly created — see `openWorkbenchOnClick`'s own doc), so a
            // configured home page always applies here; the auto-open-on-load
            // path (above) leaves whatever the reopened session already shows
            // untouched (continuity semantics).
            if (homePage !== undefined) await openHomePage(ctx, outcome.sessionId, homePage)
          },
          onOpenWorkflow: async (workflow, isLive) => {
            const outcome = await openWorkflow(ctx, workflow, isLive)
            if (outcome?.created !== true) return
            // The degrade repoints one workflow's homeSessionId; the array
            // field is a whole-value replace within the patch (see
            // `src/index.ts`), so the current list is read fresh rather than
            // trusted from this closure's own stale capture.
            const current = await readServerMenu()
            const next = current.workflows.map(candidate => (
              candidate.id === workflow.id ? { ...candidate, homeSessionId: outcome.sessionId } : candidate
            ))
            await persistServerMenu({ workflows: next }, actions)
          },
          onSaveWorkflows: next => persistServerMenu({ workflows: next }, actions),
        }
      },
    }, ServerSidebarRoot),
    'server-sidebar: sidebar slot registration',
  )

  ctx.effect(
    () => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'save-workflow',
      // After the subagent catalog and background jobs (order 20): saving
      // the current conversation as a workflow is a deliberate, occasional
      // action, not process context a user scans routinely.
      order: 30,
      locale: NS,
      inject: (): SaveWorkflowInjected => ({
        onSave: async (sessionId, name, navSnapshot) => {
          const current = await readServerMenu()
          const workflow: ServerMenuWorkflow = {
            id: crypto.randomUUID(),
            name,
            order: nextOrder(current.workflows),
            homeSessionId: sessionId,
            navSnapshot: [...navSnapshot],
            savedAt: Date.now(),
          }
          const next = [...current.workflows, workflow]
          if (sidebarActions !== undefined) {
            await persistServerMenu({ workflows: next }, sidebarActions)
            return
          }
          // Defensive: the sidebar is always resident in the shipped
          // product, so this branch is not expected in practice. Persist
          // anyway so the save is not silently lost even though the
          // sidebar's own list will not reflect it until its next read.
          try {
            await saveServerMenu({ workflows: next })
          } catch (error) {
            console.warn('server-sidebar: failed to save workflow (sidebar not mounted):', error)
          }
        },
      }),
    }, SaveWorkflowAction)),
    'server-sidebar: save-workflow header action',
  )
}
