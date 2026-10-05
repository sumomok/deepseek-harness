/**
 * Product console sidebar, browser half: a drop-in replacement for the
 * shipped `dsh-client-ui-sidebar` root registration, composed by disabling
 * that row and inserting this one (`overlay/sidebar-menu.patch.yml`). Both
 * cannot load together — `sidebar` is a single slot and its child slots may
 * be declared only once.
 *
 * Decision ① replaces the shipped shell's whole session-browsing contract
 * with a fixed three-section console: 工作台 (workbench, a persistent default
 * conversation), 导航 (navigation, the deployment's configured pages and
 * views — see `nav-catalog.ts`), and 我的工作流 (my workflows, a user's own
 * named shortcuts). The four child slots this shell keeps —
 * `sidebar.brand.mark`/`sidebar.brand.name`/`sidebar.settings`/
 * `sidebar.footer.action` — are reused by type import exactly as the prior
 * design did (see `ServerSidebarRoot.tsx`'s module doc); `sidebar.workspaces`
 * is dropped outright, which leaves `ui-workspace`'s registration for that
 * hole inert while the package itself stays composed (see the package
 * README) — `dsh-client-ui-conversation` requires its `uiWorkspace` service,
 * and `session-resolution.ts` uses it to connect a Workspace.
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
 *
 * A fourth registration seats `UntitledTitle.tsx` in the same
 * `conversation.session.header.actions` list, ahead of every other action: the
 * label the sidebar gives a conversation with no durable title, which
 * `terminology-guard.ts` puts in place of the header's crumb. It learns which
 * conversation is the workbench from `workbench-source.ts`, which every
 * server-menu answer feeds alongside the sidebar's store. A fifth set of
 * entries withholds every Settings → General row but the keyboard shortcuts
 * and the current version, and the Settings header's configuration-file
 * action, by shadowing their list ids (`settings-entries.ts`),
 * a sixth replaces the conversation's rows for a compaction that landed or
 * failed by shadowing their node keys (`CompactionRows.tsx`), and a seventh
 * and an eighth replace `dsh-client-ui-workspace`'s notice and its
 * stop-and-archive confirmation by shadowing their `shell.overlay` ids
 * (`WorkspaceNotice.tsx`, `StopAndRemoveDialog.tsx`). A ninth withholds the
 * keyboard shortcuts the console has no place for, their keys and their rows
 * in the shortcut reference (`console-shortcuts.ts`), and a tenth shadows
 * `ui-workspace`'s rename dialog with nothing (`withheld-rename.ts`).
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls ui-layout's ctx.layout Context merge (unused directly here,
// but required for `PropsRuntime<'sidebar'>`'s owner-share type to resolve).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls dsh-client-ui-conversation's SlotMap declaration for
// 'conversation.session.header.actions'.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import { mergeNavCatalogs, readContentPages, readContentViews } from './nav-catalog.ts'
import { createDisplayNameSource, readIdentitySettings } from './identity.ts'
import { readAuthGateSettings, signOut, windowSignOutBrowser } from './sign-out.ts'
import { openHome, openNavItem } from './open-nav.ts'
import { mainViewSessionId } from './session-resolution.ts'
import {
  readServerMenu, saveServerMenu, ServerMenuUnplacedError, type ServerMenuPatch, type ServerMenuWorkflow,
} from './workflow-api.ts'
import { createWorkflowStore } from './workflow-store.ts'
import {
  dismissTemporarySession, nextOrder, openTemporarySession,
  openWorkbenchOnClick, openWorkbenchOnLoad, openWorkflow,
} from './workflow-actions.ts'
import { ServerSidebarRoot, type ServerSidebarInjected } from './ServerSidebarRoot.tsx'
import { SaveWorkflowAction, type SaveWorkflowInjected } from './SaveWorkflowAction.tsx'
import { withholdSettingsEntries } from './settings-entries.ts'
import { replaceCompactionRows } from './CompactionRows.tsx'
import { replaceWorkspaceNotice } from './WorkspaceNotice.tsx'
import { replaceArchiveConfirm } from './StopAndRemoveDialog.tsx'
import { withholdShortcuts } from './console-shortcuts.ts'
import { withholdRenameDialog } from './withheld-rename.ts'
import { installTerminologyGuard } from './terminology-guard.ts'
import { UntitledTitle, type UntitledTitleInjected } from './UntitledTitle.tsx'
import { createWorkbenchSource, type WorkbenchSource } from './workbench-source.ts'
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

/**
 * The untitled-conversation title's place in the header's action list: below
 * every shipped action's order (the lowest is the subagent catalog's -30), so
 * it sits first, where the crumb it replaces was.
 */
const UNTITLED_TITLE_ORDER = -100

/** Bound workflow-store actions, as both registrations' inject factories may receive or reuse them. */
type BoundWorkflowActions = BoundActions<ReturnType<typeof createWorkflowStore>>

/**
 * Required services: the slot registry, sessions/workspaces, locale, and
 * remote commands. `layout`/`ui-conversation` are pulled type-only above.
 */
export const inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'locale', 'remote', 'remote.commands']

/** This package's dictionary lookup, as `ctx.locale.bind` returns it. */
type Translate = (key: ServerSidebarKey) => string

/**
 * Persist a server-menu patch and commit the server's authoritative answer
 * into the given bound actions and the header's workbench source, or surface
 * the failure inline. A save that reached no member's menu
 * ({@link ServerMenuUnplacedError}) is reported in fixed copy, and its refusal
 * goes to the browser console: that text is the server's, not the console's.
 * @param patch - the fields to change (see `workflow-api.ts#saveServerMenu`).
 * @param actions - the bound actions to commit the result (or the failure) into.
 * @param workbench - the header's copy of the workbench id, published from the same answer.
 * @param t - this package's dictionary lookup.
 */
async function persistServerMenu(
  patch: ServerMenuPatch, actions: BoundWorkflowActions, workbench: WorkbenchSource, t: Translate,
): Promise<void> {
  try {
    const saved = await saveServerMenu(patch)
    actions.setServerMenu(saved)
    workbench.publish(saved.workbenchSessionId)
  } catch (error) {
    if (error instanceof ServerMenuUnplacedError) {
      console.warn('server-sidebar: the menu could not be saved:', error)
      actions.setError(t('workflows.retry'))
      return
    }
    actions.setError(error instanceof Error ? error.message : String(error))
  }
}

/**
 * Refuse an entry that would save the menu, show a navigation target, or open,
 * create, or archive a conversation, while the menu the page loaded is unread,
 * and report it to the browser console. The 我的工作流 section already says the menu could not be
 * read (`workflows.unreadable`), so nothing new is drawn.
 * @returns an already-resolved promise, matching the asynchronous face of the
 * entry the refusal stands in for.
 */
function refuseUnread(): Promise<void> {
  console.warn('server-sidebar: the menu could not be read when the page loaded, so nothing is saved and no workbench is opened or created until the page is reloaded')
  return Promise.resolve()
}

/**
 * Land the console on the workbench, recording the id of a conversation this
 * had to create. Shared by the load-time auto-open and by a dismissal that
 * archives the conversation on screen: both have to leave the console resting
 * on a conversation, and both reopen the recorded one whenever it is still
 * live (see `workflow-actions.ts#openWorkbenchOnLoad` for the reuse rule).
 * @param ctx - client root context.
 * @param workbenchSessionId - the recorded id, or `undefined` before first use.
 * @param isLive - whether that id names a session the workspace domain still lists.
 * @param actions - the bound actions a created id is committed through.
 * @param workbench - the header's copy of the workbench id, published with it.
 * @param t - this package's dictionary lookup.
 */
async function landOnWorkbench(
  ctx: ClientContext, workbenchSessionId: string | undefined, isLive: boolean,
  actions: BoundWorkflowActions, workbench: WorkbenchSource, t: Translate,
): Promise<void> {
  const outcome = await openWorkbenchOnLoad(ctx, workbenchSessionId, isLive)
  if (outcome?.created === true) await persistServerMenu({ workbenchSessionId: outcome.sessionId }, actions, workbench, t)
}

/**
 * Client plugin body: dictionaries, the terminology guard, the hero
 * brand-mark takeover, the withheld Settings entries, the compaction rows, the
 * workspace notice, the stop-and-remove confirmation, the withheld keyboard
 * shortcuts, and the withheld rename dialog, then the
 * read-before-register fetches (this package's own
 * settings-read pattern, matching `dsh-experimental-content-frame`'s), then the
 * sidebar and the two session-header entries.
 * @param ctx - client root context.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'server-sidebar: dictionaries')
  const t: Translate = ctx.locale.bind(NS)
  ctx.effect(() => installTerminologyGuard(), 'server-sidebar: terminology guard')
  ctx.effect(
    () => ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register(
      { name: 'conversation.hero.brand.mark', priority: -1 },
      () => null,
    )),
    'server-sidebar: hero brand-mark takeover',
  )
  withholdSettingsEntries(ctx)
  replaceCompactionRows(ctx)
  replaceWorkspaceNotice(ctx)
  replaceArchiveConfirm(ctx)
  withholdShortcuts(ctx)
  withholdRenameDialog(ctx)

  const [pageCatalog, viewCatalog, initialMenu, identity, authGate] = await Promise.all([
    readContentPages(),
    readContentViews(),
    readServerMenu(),
    readIdentitySettings(),
    // Read on the same read-before-register pass as the rest, and contained
    // the same way: a composition without `dsh-experimental-auth-gate` leaves
    // the sign-out button in place and reports the missing login page when it
    // is pressed (see the package README's Known Limitations).
    readAuthGateSettings().catch((error: unknown) => {
      console.warn('server-sidebar: sign-out has no login page to return to:', error)
      return undefined
    }),
  ])
  // Loud at load, unlike the two contained reads it merges: two configured
  // automatic homes is a deployment mistake nothing downstream can resolve
  // (see `mergeNavCatalogs`).
  const { items: navItems, home } = mergeNavCatalogs(pageCatalog, viewCatalog)
  // An unread menu seeds the store marked unreadable, and stays unread for
  // the page's life: every entry below that would save the menu, open or
  // create the workbench, show a navigation target (which creates a
  // conversation when none is on screen), create a workflow's conversation,
  // or archive a conversation refuses while it is (`refuseUnread`), so no
  // save answers it.
  // Unknown, the menu cannot say which conversations are the member's
  // workbench and workflows, and the temporary list then shows those too.
  const menuUnread = initialMenu === undefined
  const workflowStore = createWorkflowStore(initialMenu)
  const workbench = createWorkbenchSource(initialMenu?.workbenchSessionId)
  const displayName = createDisplayNameSource(identity?.displayNameClaim)

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
          navItems,
          ...home === undefined ? {} : { home },
          onOpenNavItem: target => (menuUnread ? refuseUnread() : openNavItem(ctx, target)),
          onOpenWorkbenchOnLoad: (workbenchSessionId, isLive) => (menuUnread
            ? refuseUnread()
            : landOnWorkbench(ctx, workbenchSessionId, isLive, actions, workbench, t)),
          onOpenWorkbench: async (workbenchSessionId, isLive, isClean, homeAlreadyShown) => {
            if (menuUnread) return refuseUnread()
            const outcome = await openWorkbenchOnClick(ctx, workbenchSessionId, isLive, isClean)
            if (outcome === undefined) return
            if (outcome.created) await persistServerMenu({ workbenchSessionId: outcome.sessionId }, actions, workbench, t)
            // Every outcome of a click lands on a clean draft (reused-clean or
            // freshly created — see `openWorkbenchOnClick`'s own doc), so a
            // configured automatic home always belongs on it; a reused draft
            // that already shows it — the only content a clean draft may carry
            // — skips the repeat call so it does not append a second record
            // for the same target. The auto-open-on-load path (above) leaves
            // whatever the reopened session already shows untouched
            // (continuity semantics) and never calls this at all.
            if (home !== undefined && (outcome.created || !homeAlreadyShown)) {
              await openHome(ctx, outcome.sessionId, home)
            }
          },
          onOpenWorkflow: async (workflow, isLive) => {
            // Opening a live conversation writes nothing; the degrade creates one.
            if (menuUnread && !isLive) return refuseUnread()
            const outcome = await openWorkflow(ctx, workflow, isLive)
            if (outcome?.created !== true) return
            // The degrade repoints one workflow's homeSessionId; the array
            // field is a whole-value replace within the patch (see
            // `src/index.ts`), so the current list is read fresh rather than
            // trusted from this closure's own stale capture. A list that
            // could not be read is not written back as an empty one.
            const current = await readServerMenu()
            if (current === undefined) {
              actions.setError(t('workflows.retry'))
              return
            }
            const next = current.workflows.map(candidate => (
              candidate.id === workflow.id ? { ...candidate, homeSessionId: outcome.sessionId } : candidate
            ))
            await persistServerMenu({ workflows: next }, actions, workbench, t)
          },
          // One patch rather than a call per list: deleting a group has to
          // clear its members' `groupId` in the same write, and the route
          // refuses the intermediate document either half would leave behind
          // (see `src/index.ts` and `validateServerMenu`).
          onSaveMenu: patch => (menuUnread ? refuseUnread() : persistServerMenu(patch, actions, workbench, t)),
          onOpenTemporary: sessionId => openTemporarySession(ctx, sessionId),
          onDismissTemporary: async (sessionId, workbenchSessionId, workbenchIsLive) => {
            if (menuUnread) return refuseUnread()
            // Read the selection before the archive, not after: the workspace
            // domain sweeps an archived selection into the no-conversation
            // state as part of the same call, so afterwards there is nothing
            // left to compare against.
            const wasOnScreen = mainViewSessionId(ctx) === sessionId
            try {
              await dismissTemporarySession(ctx, sessionId)
            } catch (error) {
              // Reported inline the way a failed save is — not as an unhandled
              // rejection out of a click the component never awaits — but in
              // its own section and its own fixed words: nothing here is a
              // save, and the refusal's own text is the host runtime's (see
              // `locales.ts`), which is why it goes to the console instead.
              console.warn('server-sidebar: could not take this conversation off the list:', error)
              actions.setTemporaryFailed(true)
              return
            }
            actions.setTemporaryFailed(false)
            // The console always rests on a conversation: archiving the one on
            // screen leaves none selected, and the shell's own load-time
            // landing is a one-shot that never fires a second time.
            if (wasOnScreen) await landOnWorkbench(ctx, workbenchSessionId, workbenchIsLive, actions, workbench, t)
          },
          onSignOut: () => {
            if (authGate === undefined) {
              console.warn('server-sidebar: cannot sign out, the login page and mirror cookie are unknown')
              return
            }
            // `signOut` reports each step's own refusal and never rejects (see
            // its doc), so there is nothing here to catch.
            void signOut(windowSignOutBrowser(ctx), authGate)
          },
          hooks: { displayName },
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
        navItems,
        onSave: async (sessionId, name, navSnapshot) => {
          if (menuUnread) return refuseUnread()
          const current = await readServerMenu()
          // The new workflow joins the list as read; a list that could not
          // be read is not replaced by one holding the new workflow alone.
          if (current === undefined) {
            if (sidebarActions !== undefined) sidebarActions.setError(t('workflows.retry'))
            else console.warn('server-sidebar: did not save the workflow (sidebar not mounted): the menu could not be read')
            return
          }
          const workflow: ServerMenuWorkflow = {
            id: randomUUID(),
            name,
            order: nextOrder(current.workflows),
            homeSessionId: sessionId,
            navSnapshot: [...navSnapshot],
            savedAt: Date.now(),
          }
          const next = [...current.workflows, workflow]
          if (sidebarActions !== undefined) {
            await persistServerMenu({ workflows: next }, sidebarActions, workbench, t)
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

  ctx.effect(
    () => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'untitled-title',
      order: UNTITLED_TITLE_ORDER,
      locale: NS,
      inject: (): UntitledTitleInjected => ({ hooks: { workbenchSessionId: workbench } }),
    }, UntitledTitle)),
    'server-sidebar: untitled conversation title',
  )
}
