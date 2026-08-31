/**
 * Sidebar shell: the product console's fixed-width column (decision ①: no
 * collapse rail, no fold interaction — this shell never toggles it and
 * always renders its full content regardless of the `collapsed` owner prop,
 * see below for the residual coupling this leaves with the surrounding
 * shell's own track geometry). Three sections between the brand row and the
 * footer: 工作台 (workbench, a persistent default conversation), 导航
 * (navigation, `dsh-experimental-content-frame`'s configured pages), and 我的
 * 工作流 (my workflows, a user's own named shortcuts to conversations they
 * taught the agent something in).
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
import type { PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { NavGroup } from './NavGroup.tsx'
import { WorkflowGroup } from './WorkflowGroup.tsx'
import type { MenuPage } from './pages.ts'
import type { ServerMenuWorkflow } from './workflow-api.ts'
import type { createWorkflowStore } from './workflow-store.ts'
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
 * Registrant-private injected share: the shell's own workbench/navigation/
 * workflow actions.
 */
export interface ServerSidebarInjected {
  /** The deployment's configured content-column pages, in declaration order. */
  pages: readonly MenuPage[]
  /**
   * Open a configured page, creating a session first when none is current.
   * The menu does not await this — it returns a promise so tests can.
   */
  onOpenPage: (pageId: string) => Promise<void>
  /**
   * Land on the workbench once the sidebar first loads with no session
   * selected: continuity semantics — reopens the recorded session whenever
   * it is still live, whatever content it already carries. Re-creates only
   * when the recorded session is gone. Fired once by the mount-time effect,
   * not awaited by it. Contrast `onOpenWorkbench`, the click path.
   */
  onOpenWorkbenchOnLoad: (workbenchSessionId: string | undefined, isLive: boolean) => Promise<void>
  /**
   * Open the workbench on a click: blank-draft semantics — always lands on
   * an empty page, reusing the recorded session only when it is both live
   * and still blank. Not awaited by the component. Contrast
   * `onOpenWorkbenchOnLoad`, the auto-open-on-load path.
   */
  onOpenWorkbench: (workbenchSessionId: string | undefined, isLive: boolean, isBlank: boolean) => Promise<void>
  /**
   * Open a workflow, degrading to a fresh conversation with its navigation
   * snapshot replayed when its bound one is gone. Not awaited by the component.
   */
  onOpenWorkflow: (workflow: ServerMenuWorkflow, isLive: boolean) => Promise<void>
  /**
   * Persist the complete next workflow list. The menu does not await this —
   * it returns a promise so tests can.
   */
  onSaveWorkflows: (next: ServerMenuWorkflow[]) => Promise<void>
}

/** Full component props: layout owner state/actions, the declared holes, the workflow store, and this package's own share. */
export type ServerSidebarRootComponentProps =
  PropsRuntime<'sidebar'>
  & PropsRenderSlots<'sidebar.brand.mark' | 'sidebar.brand.name' | 'sidebar.settings' | 'sidebar.footer.action'>
  & PropsStore<ReturnType<typeof createWorkflowStore>>
  & ServerSidebarInjected & PropsLocale<'serverSidebar'>

/**
 * Render the sidebar column shell.
 * @param props - composed slot props (runtime share + store share + injected callbacks).
 * @returns the sidebar element tree.
 */
export function ServerSidebarRoot({
  width, t, renderSlot,
  pages, onOpenPage, onOpenWorkbenchOnLoad, onOpenWorkbench, onOpenWorkflow, onSaveWorkflows,
  useStore, useSessions, useWorkspaces,
}: ServerSidebarRootComponentProps) {
  const workflows = useStore(state => state.workflows)
  const workbenchSessionId = useStore(state => state.workbenchSessionId)
  const workflowsError = useStore(state => state.error)

  // Session liveness for the workbench and workflow group: read fresh on
  // every relevant change rather than captured once, so a re-created or
  // deleted session is reflected without a save round trip.
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

  // Land on the workbench automatically when the sidebar loads with no
  // current session — evaluated at most once per mount, the same "settle
  // then decide, never retry" shape `dsh-client-runtime`'s own
  // startInitialSelection uses for its Workspace check. Waiting for
  // `phase === 'ready'` matters: deciding `liveSessionIds` membership while
  // the list is still `'pending'` would read a real workbench session as
  // stale (not yet loaded into `byId`) and needlessly re-create it.
  //
  // The attempt is withheld (not consumed) while reopening a live recorded
  // session is not possible AND creating one has nowhere to create it yet:
  // reopening needs no Workspace at all, but creating one needs the
  // Workspace baseline settled first — `recentWorkspaceId` reads `undefined`
  // both before that baseline lands and in a genuine zero-Workspace
  // deployment, and this effect cannot tell those apart, so it waits for
  // either a live session or a resolved Workspace before spending its one
  // shot (never spending it at all is the correct outcome for a deployment
  // that never gets a Workspace — see the package README's Known
  // Limitations for that already-accepted edge case).
  const recentWorkspaceId = useWorkspaces(state => state.recentWorkspaceId)
  const attemptedAutoOpen = useRef(false)
  useEffect(() => {
    if (attemptedAutoOpen.current || phase !== 'ready') return
    if (current !== undefined) {
      attemptedAutoOpen.current = true
      return
    }
    if (!workbenchIsLive && recentWorkspaceId === undefined) return
    attemptedAutoOpen.current = true
    void onOpenWorkbenchOnLoad(workbenchSessionId, workbenchIsLive)
  }, [current, phase, workbenchSessionId, workbenchIsLive, recentWorkspaceId, onOpenWorkbenchOnLoad])

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
          void onOpenWorkbench(workbenchSessionId, workbenchIsLive, workbenchIsBlank)
        }}
      >
        {t('workbench.label')}
      </button>

      <div className={css.regionArea}>
        <NavGroup pages={pages} onOpenPage={onOpenPage} t={t} />
        <WorkflowGroup
          workflows={workflows}
          current={current}
          unreadHomeSessionIds={unreadHomeSessionIds}
          onOpenWorkflow={workflow => onOpenWorkflow(workflow, liveSessionIds.has(workflow.homeSessionId))}
          onSaveWorkflows={onSaveWorkflows}
          error={workflowsError}
          t={t}
        />
      </div>

      <div className={css.footArea}>
        <div className={css.footerActions}>{renderSlot('sidebar.footer.action', { wide: true })}</div>
        <div className={css.identityRow} data-server-sidebar-section="identity">
          <div className={css.avatarRow}>
            <span className={css.avatarCircle} aria-hidden="true" />
            <span className={css.avatarName}>{t('avatar.namePlaceholder')}</span>
          </div>
          <div className={css.settingsArea}>{renderSlot('sidebar.settings', { wide: true })}</div>
        </div>
      </div>
    </div>
  )
}
