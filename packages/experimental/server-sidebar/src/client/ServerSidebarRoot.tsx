/**
 * Sidebar shell: the product console's fixed-width column (decision ①: no
 * collapse rail, no fold interaction — this shell never toggles it and
 * always renders its full content regardless of the `collapsed` owner prop,
 * see below for the residual coupling this leaves with the surrounding
 * shell's own track geometry). Four sections between the brand row and the
 * footer: 工作台 (workbench, a persistent default conversation), 导航
 * (navigation, the deployment's configured pages and views — see
 * `nav-catalog.ts`), 我的工作流 (my workflows, a user's own named shortcuts to
 * conversations they taught the agent something in, filed under groups they
 * name themselves), and 临时工作流 (the conversations none of those rows
 * already shows — derived here and drawn by `TemporaryGroup`).
 *
 * `collapsed`/`width` remain part of this component's props only because
 * they are part of `PropsRuntime<'sidebar'>`'s owner-share contract (declared
 * by whichever shell composes this sidebar); `width` still sizes this
 * column's inline CSS width exactly as the original shell did, but `collapsed`
 * is read nowhere here. The shell's own track geometry
 * (`dsh-experimental-server-layout`'s `solveTracks`) still allocates this
 * column a *proportional* share of the frame width — literally fixing this
 * column at 240px regardless of frame width would require a change to that
 * package's frozen ratio, which is out of this change's scope (see the
 * package README's Known Limitations for the full account).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
// Type-only: pulls `dsh-client-ui-sidebar`'s `sidebar.*` SlotMap declarations
// for the four child slots this shell still honors (brand mark/name,
// settings, footer actions) — reused here rather than redeclared so
// ui-settings's existing registration, and any brand package filling the two
// identity slots, keep working unchanged. `sidebar.workspaces` is
// deliberately NOT reused: decision ① removes the whole session-browsing
// region this sidebar used to seat (see the package README and Agent Note).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { NavGroup } from './NavGroup.tsx'
import { WorkflowGroup } from './WorkflowGroup.tsx'
import { TemporaryGroup } from './TemporaryGroup.tsx'
import type { TemporaryRow } from './TemporaryGroup.tsx'
import type { NavItem } from './nav-catalog.ts'
import { TEMPORARY_GROUP_ID } from '../menu-constants.ts'
import type { NavSnapshotItem } from '../workflows.ts'
import type { ServerMenuPatch, ServerMenuWorkflow } from './workflow-api.ts'
import type { createWorkflowStore } from './workflow-store.ts'
import {
  hasShownHome, isCleanWorkbenchDraft, temporarySessions,
  type ContentSurfaceEntryLike, type TemporarySessionFacts,
} from './workflow-actions.ts'
import css from './ServerSidebarRoot.module.css'

/**
 * How long the column's scrollbars stay drawn after the pointer leaves it.
 * The bar is a pointer affordance here, and hiding it on the leave event
 * itself makes it blink out while the pointer is only crossing the column's
 * edge — on the way to the conversation, or around a portalled menu.
 * Carried over unchanged from the original shell; independent of decision
 * ①'s removed collapse mechanism.
 */
const SCROLLBAR_LINGER_MS = 2000

/**
 * Read one session's content-surface entries defensively off the standard
 * session-list feed's `projectionValues`, matching
 * `dsh-experimental-server-layout`'s `ShellFrame` (see its own module doc):
 * this package composes `dsh-experimental-content-surface` for real, but the
 * read still stays untyped at this exact point rather than trusting an
 * imported projection type, so a session missing the key (the capability was
 * never composed, or nothing has ever been shown) degrades to an empty list
 * instead of throwing mid-render.
 * @param byId - the `useSessions` snapshot's row-by-id map.
 * @param sessionId - the session to read; `undefined` reads as no entries.
 * @returns the session's content-surface entries (each of unknown shape,
 * narrowed defensively by `isCleanWorkbenchDraft`/`hasShownHome`), or an
 * empty array when there is nothing to read.
 */
function contentSurfaceEntries(
  byId: Record<string, { projectionValues?: unknown }>, sessionId: string | undefined,
): readonly ContentSurfaceEntryLike[] {
  if (sessionId === undefined) return []
  const projectionValues = byId[sessionId]?.projectionValues as Record<string, unknown> | undefined
  const contentSurface = projectionValues?.contentSurface as { entries?: readonly ContentSurfaceEntryLike[] } | undefined
  return contentSurface?.entries ?? []
}

/**
 * Session-list facts the 临时工作流 section needs, per session. It extends
 * `temporarySessions`'s own membership fields (see `workflow-actions.ts`)
 * with the two a row draws — the durable title and the unread bit — so one
 * value carries both the filter's inputs and the row's own.
 */
interface TemporaryFacts extends TemporarySessionFacts {
  /** The session's latest durable title, absent until the host projects one. */
  readonly title?: string
  /** Whether it finished while unselected and unopened (decision ④'s green dot). */
  readonly completed?: boolean
}

/**
 * Reduce one temporary member to the row the section draws.
 *
 * The title is the session's own durable title and nothing else: the session
 * list's `displayTitle` falls back to a directory basename and then to a bare
 * id, both of which are the internal vocabulary this console keeps off the
 * screen (see the package README's De-terminology section). A session with
 * none gets the section's own fixed copy instead.
 * @param facts - one member of the temporary group.
 * @param current - the session currently open, or `undefined`.
 * @returns the row.
 */
function temporaryRow(facts: TemporaryFacts, current: string | undefined): TemporaryRow {
  const title = facts.title?.trim()
  return {
    id: facts.id,
    title: title === undefined || title.length === 0 ? undefined : title,
    updatedAt: facts.updatedAt,
    unread: facts.completed === true,
    active: facts.id === current,
  }
}

/**
 * Registrant-private injected share: the shell's own workbench/navigation/
 * workflow actions.
 */
export interface ServerSidebarInjected {
  /** The deployment's configured navigation rows, in menu order (see `nav-catalog.ts`). */
  navItems: readonly NavItem[]
  /**
   * The deployment's configured automatic home (content-frame's `homePage`
   * or component-surface's `homeView`, whichever one is configured), or
   * `undefined` when neither is — merged alongside `navItems`
   * (`client/index.ts`'s `mergeNavCatalogs`) and consulted here only for the
   * workbench click's own clean-draft judgment (see `workbenchIsClean`
   * below); the auto-open call itself stays in `client/index.ts`.
   */
  home?: NavSnapshotItem
  /**
   * Show one configured navigation target, creating a session first when none
   * is current. The menu does not await this — it returns a promise so tests
   * can.
   */
  onOpenNavItem: (target: NavSnapshotItem) => Promise<void>
  /**
   * Land on the workbench once the sidebar first loads with no session
   * selected: continuity semantics — reopens the recorded session whenever
   * it is still live, whatever content it already carries. Re-creates only
   * when the recorded session is gone. Fired once by the mount-time effect,
   * not awaited by it. Contrast `onOpenWorkbench`, the click path.
   */
  onOpenWorkbenchOnLoad: (workbenchSessionId: string | undefined, isLive: boolean) => Promise<void>
  /**
   * Open the workbench on a click: clean-draft semantics — always lands on
   * an empty page, reusing the recorded session only when it is both live
   * and still clean (no turn run, and its content column carries nothing
   * beyond the configured automatic home — see `workbenchIsClean` below). Not
   * awaited by the component. Contrast `onOpenWorkbenchOnLoad`, the
   * auto-open-on-load path.
   * @param workbenchSessionId - the recorded id, or `undefined` before first use.
   * @param isLive - whether that id names a session the workspace domain still lists.
   * @param isClean - whether that session is a clean draft; irrelevant when `isLive` is `false`.
   * @param homeAlreadyShown - whether that session's content column already
   * shows the configured automatic home — lets the caller skip a repeat
   * command on a reused clean draft that already carries it; meaningless (and
   * never consulted) on a freshly created session, which always needs the
   * call.
   */
  onOpenWorkbench: (
    workbenchSessionId: string | undefined, isLive: boolean, isClean: boolean, homeAlreadyShown: boolean,
  ) => Promise<void>
  /**
   * Open a workflow, degrading to a fresh conversation with its navigation
   * snapshot replayed when its bound one is gone. Not awaited by the component.
   */
  onOpenWorkflow: (workflow: ServerMenuWorkflow, isLive: boolean) => Promise<void>
  /**
   * Persist one server-menu patch — the complete next workflow list, the
   * complete next group list, or both when one change touches both (deleting
   * a group clears its members' `groupId` in the same write). The menu does
   * not await this — it returns a promise so tests can.
   */
  onSaveMenu: (patch: ServerMenuPatch) => Promise<void>
  /** Open one unnamed conversation from the 临时工作流 section. Not awaited by the component. */
  onOpenTemporary: (sessionId: string) => Promise<void>
  /**
   * Take one unnamed conversation off the 临时工作流 section. It is archived,
   * not deleted — the log survives on the host, but this console offers no way
   * back to it. Archiving the conversation on screen leaves none selected, so
   * this carries the same two workbench facts the click path takes and lands
   * there when that is what happened (see `client/index.ts`). Not awaited by
   * the component.
   * @param sessionId - the conversation to take off the list.
   * @param workbenchSessionId - the recorded workbench id, or `undefined` before first use.
   * @param isLive - whether that id names a session the workspace domain still lists.
   */
  onDismissTemporary: (
    sessionId: string, workbenchSessionId: string | undefined, isLive: boolean,
  ) => Promise<void>
  /** Sign the visitor out. Not awaited by the component: the page is leaving. */
  onSignOut: () => void
  hooks: {
    /**
     * Who the deployment's access token says is signed in, absent while
     * there is no readable name. Display only, never authority — see
     * `client/identity.ts`.
     */
    displayName: HostObservable<string | undefined>
  }
}

/** Full component props: layout owner state/actions, the declared holes, the workflow store, and this package's own share. */
export type ServerSidebarRootComponentProps =
  PropsRuntime<'sidebar'>
  & PropsRenderSlots<'sidebar.brand.mark' | 'sidebar.brand.name' | 'sidebar.settings' | 'sidebar.footer.action'>
  & PropsStore<ReturnType<typeof createWorkflowStore>>
  & InjectFace<ServerSidebarInjected> & PropsLocale<'serverSidebar'>

/**
 * Render the sidebar column shell.
 * @param props - composed slot props (runtime share + store share + injected callbacks).
 * @returns the sidebar element tree.
 */
export function ServerSidebarRoot({
  width, t, renderSlot,
  navItems, home, onOpenNavItem, onOpenWorkbenchOnLoad, onOpenWorkbench, onOpenWorkflow, onSaveMenu,
  onOpenTemporary, onDismissTemporary, onSignOut,
  useStore, actions, useSessions, useWorkspaces, useDisplayName,
}: ServerSidebarRootComponentProps) {
  const displayName = useDisplayName(name => name)
  const workflows = useStore(state => state.workflows)
  const groups = useStore(state => state.groups)
  const workbenchSessionId = useStore(state => state.workbenchSessionId)
  const workflowsError = useStore(state => state.error)
  const temporaryFailed = useStore(state => state.temporaryFailed)
  const view = useStore(state => state.view)

  // Session liveness for the workbench and workflow group: read fresh on
  // every relevant change rather than captured once, so a re-created or
  // deleted session is reflected without a save round trip.
  const sessionIds = useSessions(state => state.ids)
  const byId = useSessions(state => state.byId)
  const current = useSessions(state => state.current)
  const phase = useSessions(state => state.phase)
  const liveSessionIds = useMemo(() => new Set(Object.keys(byId)), [byId])
  const blankSessionIds = useMemo(
    () => new Set(Object.entries(byId).filter(([, summary]) => summary.blank).map(([id]) => id)),
    [byId],
  )
  const workbenchIsLive = workbenchSessionId !== undefined && liveSessionIds.has(workbenchSessionId)
  const workbenchIsBlank = workbenchSessionId !== undefined && blankSessionIds.has(workbenchSessionId)
  const workbenchEntries = contentSurfaceEntries(byId, workbenchSessionId)
  const workbenchIsClean = isCleanWorkbenchDraft(workbenchIsBlank, workbenchEntries, home)
  const workbenchHomeShown = hasShownHome(workbenchEntries, home)
  // Decision ④'s green dot reuses the session list's own `completed` bit
  // ("finished while not selected and not yet opened") rather than a second
  // last-seen bookkeeping mechanism — see the package README.
  const unreadHomeSessionIds = useMemo(
    () => new Set(Object.entries(byId).filter(([, summary]) => summary.completed === true).map(([id]) => id)),
    [byId],
  )
  // A session a workflow already binds wins the active highlight over the
  // workbench, so a session named by both never lights up two rows at once
  // (see the package README's Selection highlight section).
  const boundHomeSessionIds = useMemo(() => new Set(workflows.map(workflow => workflow.homeSessionId)), [workflows])
  const workbenchActive = current !== undefined && current === workbenchSessionId && !boundHomeSessionIds.has(current)

  // 临时工作流: the conversations no other row in this shell already shows.
  // `archivedSessionIds` is the same list the shipped browser hides rows by,
  // read here so a conversation taken off this list stays off it.
  const archivedSessionIds = useWorkspaces(state => state.archivedSessionIds)
  const archived = useMemo(() => new Set<string>(archivedSessionIds), [archivedSessionIds])
  const temporaryRows = useMemo(() => temporarySessions(
    sessionIds.flatMap<TemporaryFacts>((id) => {
      const summary = byId[id]
      // A session listed in `ids` always has a row in `byId` (one snapshot,
      // one source); the empty branch keeps the read total rather than
      // asserting across the store's own boundary.
      return summary === undefined ? [] : [{ ...summary, id }]
    }),
    {
      boundHomeSessionIds,
      workbenchSessionId,
      currentSessionId: current,
      archivedSessionIds: archived,
    },
  ).map(facts => temporaryRow(facts, current)), [sessionIds, byId, boundHomeSessionIds, workbenchSessionId, current, archived])

  // Land on the workbench automatically when the sidebar loads with no
  // current session — evaluated at most once per mount, a "settle then
  // decide, never retry" shape. Waiting for
  // `phase === 'ready'` matters: deciding `liveSessionIds` membership while
  // the list is still `'pending'` would read a real workbench session as
  // stale (not yet loaded into `byId`) and needlessly re-create it.
  //
  // The attempt is withheld (not consumed) while reopening a live recorded
  // session is not possible AND creating one has nowhere to create it yet:
  // reopening needs no Workspace at all, but creating one needs the
  // Workspace baseline settled first — `hasWorkspace` reads false both
  // before that baseline lands and in a genuine zero-Workspace deployment,
  // and this effect cannot tell those apart, so it waits for either a live
  // session or a settled non-empty Workspace list before spending its one
  // shot (never spending it at all is the correct outcome for a deployment
  // that never gets a Workspace — see the package README's Known
  // Limitations for that already-accepted edge case).
  const hasWorkspace = useWorkspaces(state => state.phase === 'ready' && state.items.length > 0)
  const attemptedAutoOpen = useRef(false)
  useEffect(() => {
    if (attemptedAutoOpen.current || phase !== 'ready') return
    if (current !== undefined) {
      attemptedAutoOpen.current = true
      return
    }
    if (!workbenchIsLive && !hasWorkspace) return
    attemptedAutoOpen.current = true
    void onOpenWorkbenchOnLoad(workbenchSessionId, workbenchIsLive)
  }, [current, phase, workbenchSessionId, workbenchIsLive, hasWorkspace, onOpenWorkbenchOnLoad])

  /* jscpd:ignore-start -- pointer-driven scrollbar behavior ported verbatim
   * from dsh-client-ui-sidebar's SidebarRoot (this file's module doc explains
   * why this is a copy, not an import); unrelated to decision ①'s removed
   * collapse mechanism.
   */
  const column = useRef<HTMLDivElement>(null)
  const [pointerInside, setPointerInside] = useState(false)
  const lingerTimer = useRef<number | undefined>(undefined)
  const armLinger = (): void => {
    if (lingerTimer.current !== undefined) return
    lingerTimer.current = window.setTimeout(() => {
      lingerTimer.current = undefined
      setPointerInside(false)
    }, SCROLLBAR_LINGER_MS)
  }
  const cancelLinger = (): void => {
    window.clearTimeout(lingerTimer.current)
    lingerTimer.current = undefined
  }
  useEffect(() => {
    if (!pointerInside) return
    const onMove = (event: PointerEvent): void => {
      const rect = column.current?.getBoundingClientRect()
      /* v8 ignore next -- the listener only exists while the column is mounted and revealed. */
      if (rect === undefined) return
      const inside = event.clientX >= rect.left && event.clientX < rect.right
        && event.clientY >= rect.top && event.clientY < rect.bottom
      if (inside) cancelLinger()
      else armLinger()
    }
    document.addEventListener('pointermove', onMove)
    return () => {
      document.removeEventListener('pointermove', onMove)
      cancelLinger()
    }
  }, [pointerInside])
  /* jscpd:ignore-end */

  return (
    <div
      ref={column}
      data-server-sidebar
      className={clsx(css.root, !pointerInside && css.quietBars)}
      style={{ width }}
      onPointerEnter={() => {
        cancelLinger()
        setPointerInside(true)
      }}
      onPointerLeave={() => { armLinger() }}
    >
      <div className={css.brandRow}>
        <span className={css.brandMark} aria-hidden="true">
          {renderSlot('sidebar.brand.mark', { size: 24 })}
        </span>
        <span className={css.brandName}>
          {renderSlot('sidebar.brand.name', {}, {
            fallback: <span className={css.fallbackBrandName}>{t('brand.name.fallback')}</span>,
          })}
        </span>
      </div>

      <button
        type="button"
        className={css.workbench}
        data-server-sidebar-section="workbench"
        data-active={workbenchActive}
        onClick={() => {
          void onOpenWorkbench(workbenchSessionId, workbenchIsLive, workbenchIsClean, workbenchHomeShown)
        }}
      >
        {t('workbench.label')}
      </button>

      <div className={css.regionArea}>
        <NavGroup items={navItems} onOpenNavItem={onOpenNavItem} t={t} />
        <WorkflowGroup
          workflows={workflows}
          groups={groups}
          collapsed={view.collapsed}
          onSetCollapsed={(groupId, collapsed) => { actions.setGroupCollapsed(groupId, collapsed) }}
          current={current}
          unreadHomeSessionIds={unreadHomeSessionIds}
          onOpenWorkflow={workflow => onOpenWorkflow(workflow, liveSessionIds.has(workflow.homeSessionId))}
          onSaveMenu={onSaveMenu}
          newGroupId={() => randomUUID()}
          error={workflowsError}
          t={t}
        />
        <TemporaryGroup
          rows={temporaryRows}
          collapsed={view.collapsed[TEMPORARY_GROUP_ID] === true}
          onSetCollapsed={(collapsed) => { actions.setGroupCollapsed(TEMPORARY_GROUP_ID, collapsed) }}
          expanded={view.temporaryExpanded}
          onSetExpanded={(expanded) => { actions.setTemporaryExpanded(expanded) }}
          onOpen={onOpenTemporary}
          onDismiss={sessionId => onDismissTemporary(sessionId, workbenchSessionId, workbenchIsLive)}
          failed={temporaryFailed}
          t={t}
        />
      </div>

      <div className={css.footArea}>
        <div className={css.footerActions}>{renderSlot('sidebar.footer.action', { wide: true })}</div>
        <div className={css.identityRow} data-server-sidebar-section="identity">
          <div className={css.avatarRow}>
            <span className={css.avatarCircle} aria-hidden="true" />
            <span className={css.avatarName}>{displayName ?? t('avatar.namePlaceholder')}</span>
            <button
              type="button"
              className={css.signOut}
              data-server-sidebar-action="sign-out"
              onClick={onSignOut}
            >
              {t('signOut.action')}
            </button>
          </div>
          {/* `wide: false` asks the settings occupant for its compact form: a
              36px icon button in place of icon + label. Its labeled form is
              wider than what this row has left after the avatar, the name and
              退出登录, in both locales this console ships, and this band is one
              row (see `.identityRow` in the stylesheet). The compact form also
              draws no connection indicator, which is this console's only
              reconnect control — a Known Limitation in the package README. */}
          <div className={css.settingsArea}>{renderSlot('sidebar.settings', { wide: false })}</div>
        </div>
      </div>
    </div>
  )
}
