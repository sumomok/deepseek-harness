/**
 * The 我的工作流 (my workflows) section: a user's own named shortcuts back to
 * long-running conversations they taught the agent something in, filed under
 * groups they name themselves.
 *
 * The order on screen is derived, never stored as a list: pinned groups
 * first, then the remaining groups by `order`, then every workflow filed
 * under no group, at the section's own top level. Pure presentation over
 * `workflow-actions.ts` — every list this component draws and every list it
 * saves comes from a transform there; the local state it owns is which row or
 * group is mid-rename, which row's 移动到… menu is open, and what an in-flight
 * drag is hovering, none of it persisted. Which groups are folded shut is a
 * display preference the store owns (see `workflow-store.ts`) and this
 * component only reads and toggles.
 *
 * Reordering is native HTML5 drag-and-drop: a row's `dragstart` records it as
 * the dragged workflow, `dragover` tracks which half of the hovered row's own
 * bounding box the pointer sits over (top half inserts before it, bottom half
 * inserts after), and `drop` states the destination lane's complete next
 * sequence through {@link reorderWithinGroup} — which both reorders and
 * re-files, so a drag within one group and a drag across two are the same
 * call. A group's own header is a drop target as well, so a folded group and
 * an empty one can still receive a row. The top level has no header, so an
 * empty top level draws its own placeholder while a drag is in flight, and
 * only then: a console whose workflows are all filed has an empty top level
 * as its ordinary state, and a standing "drop here" would be noise in it.
 * Drag-and-drop has no touch equivalent, so every cross-group move is also
 * reachable from a row's 移动到… menu, which a row draws only while some other
 * lane exists to move it to. Neither path serves the keyboard: the
 * menu's list is portaled to the end of `document.body` and the primitive
 * drawing it neither takes focus nor answers arrow keys, so its rows sit
 * behind every other focusable element on the page (see the package README's
 * Known Limitations). Focus leaving the row closes the menu, so the list
 * never outlives the hover-or-focus reveal that drew its trigger.
 *
 * Creating and renaming use in-place inputs (the idiom `SaveWorkflowAction`
 * already established for naming a workflow) revealed from hover icon buttons
 * rather than a native `contextmenu` popup: same outcomes, better
 * keyboard/touch discoverability, and no new interaction pattern introduced
 * for one feature.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/WorkflowGroup
 */
import { useState } from 'react'
import type { DragEvent } from 'react'
import {
  IconChevronDownOutline14, IconChevronUpOutline14, IconEditOutline16, IconFolderOpenOutline16,
  IconPlusOutline16, IconTrashOutline16, IconTriangleRightFill14, Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { MAX_GROUP_NAME_LENGTH } from '../menu-constants.ts'
import type { ServerMenuGroup, ServerMenuPatch, ServerMenuWorkflow } from './workflow-api.ts'
import type { ServerSidebarKey } from './locales.ts'
import {
  createGroup, deleteGroup, moveWorkflow, otherGroups, pinGroup, pinnedGroups, renameGroup,
  reorderWithinGroup, ungroupedWorkflows, workflowsInGroup,
} from './workflow-actions.ts'
import css from './SidebarGroups.module.css'

/** Menu id the 移动到… list uses for the ungrouped destination; no group may carry an empty id. */
const UNGROUPED_MENU_ID = ''

/**
 * The group name element's id, so a lane can name itself to a reader that
 * cannot see the indentation.
 * @param groupId - the group's stored id.
 * @returns the DOM id.
 */
function laneNameId(groupId: string): string {
  return `server-sidebar-lane-${groupId}-name`
}

/**
 * The lane's member list id, so the fold caret can name what it folds.
 * @param groupId - the group's stored id.
 * @returns the DOM id.
 */
function laneListId(groupId: string): string {
  return `server-sidebar-lane-${groupId}-list`
}

/** Which row or group (if any) is mid-rename, or whether a new group is being named; never persisted. */
type EditState =
  | { readonly mode: 'idle' }
  | { readonly mode: 'creatingGroup' }
  | { readonly mode: 'renamingGroup'; readonly id: string }
  | { readonly mode: 'renamingWorkflow'; readonly id: string }

/** Which half of a hovered row an in-flight drag currently sits over — the drop-position indicator this implies. */
interface DropTarget {
  readonly id: string
  readonly half: 'before' | 'after'
}

/** One block of the section: a group and its members, or the top-level lane (`group === undefined`). */
export interface WorkflowLane {
  /** The group this lane draws a header for, or `undefined` for the top-level lane. */
  group: ServerMenuGroup | undefined
  /** The lane's workflows, already in display order. */
  items: ServerMenuWorkflow[]
}

/** Full props of the workflow section. */
export interface WorkflowGroupProps {
  /** Every workflow, in no particular storage order — this component derives its lanes and their order. */
  workflows: readonly ServerMenuWorkflow[]
  /** Every stored group, in no particular storage order — pinned ones sort ahead of the rest. */
  groups: readonly ServerMenuGroup[]
  /** Which groups are folded shut, by group id; a group absent from the map is expanded. */
  collapsed: Readonly<Record<string, boolean>>
  /** Fold one group shut or open it; a display preference the store persists per browser. */
  onSetCollapsed: (groupId: string, collapsed: boolean) => void
  /**
   * The session currently open, or `undefined` in the no-session state. A
   * workflow whose `homeSessionId` matches draws the active highlight — see
   * the package README's Selection highlight section.
   */
  current: string | undefined
  /**
   * Home session ids with unread produce (decision ④: the session list's own
   * `completed` bit — "finished while not selected and not yet opened" —
   * reused verbatim rather than a second last-seen bookkeeping mechanism;
   * see the package README). A workflow bound to one of these ids draws the
   * green dot; opening it clears the dot for free, since `completed` clears
   * the instant `sessions.open` selects the session.
   */
  unreadHomeSessionIds: ReadonlySet<string>
  /** Open a workflow, degrading to a fresh conversation when its bound one is gone. Not awaited by this component. */
  onOpenWorkflow: (workflow: ServerMenuWorkflow) => Promise<void>
  /**
   * Persist one server-menu patch: every create, rename, pin, delete, remove,
   * reorder and move funnels through this. Not awaited by this component.
   */
  onSaveMenu: (patch: ServerMenuPatch) => Promise<void>
  /** Mint a group's stable id; injected so this component's saves are reproducible in a test. */
  newGroupId: () => string
  /** The last save's failure message, when one is pending. */
  error: string | undefined
  /** Locale seat. */
  t: (key: ServerSidebarKey, vars?: Record<string, string>) => string
}

/** Half of a row's own bounding box the pointer currently sits over. */
function rowHalf(event: { clientY: number; currentTarget: HTMLElement }): 'before' | 'after' {
  const rect = event.currentTarget.getBoundingClientRect()
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

/**
 * State one lane's complete next id sequence after a drop.
 * @param lane - the destination lane's current members, in display order.
 * @param dragId - the dragged workflow's id; removed from the lane first, so
 * a drag arriving from another lane and one moving within this lane produce
 * the same sequence.
 * @param overId - the row it was dropped onto, or `undefined` when the drop
 * landed on the lane as a whole (its header, or the placeholder an empty lane
 * draws), which puts the dragged row first.
 * @param half - which half of `overId`'s row the pointer sat over.
 * @returns the ids in their next display order.
 */
function nextSequence(
  lane: readonly ServerMenuWorkflow[], dragId: string, overId: string | undefined, half: 'before' | 'after',
): string[] {
  const ids = lane.map(workflow => workflow.id).filter(id => id !== dragId)
  if (overId === undefined) return [dragId, ...ids]
  const at = ids.indexOf(overId) + (half === 'before' ? 0 : 1)
  return [...ids.slice(0, at), dragId, ...ids.slice(at)]
}

/**
 * Render the workflow section.
 * @param props - see {@link WorkflowGroupProps}.
 * @returns the section element tree.
 */
export function WorkflowGroup({
  workflows, groups, collapsed, onSetCollapsed, current, unreadHomeSessionIds,
  onOpenWorkflow, onSaveMenu, newGroupId, error, t,
}: WorkflowGroupProps) {
  const [edit, setEdit] = useState<EditState>({ mode: 'idle' })
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [dropLane, setDropLane] = useState<{ readonly groupId: string | undefined } | null>(null)
  const [moveMenuFor, setMoveMenuFor] = useState<string | null>(null)
  const lanes: WorkflowLane[] = [
    ...[...pinnedGroups(groups), ...otherGroups(groups)].map(group => ({
      group, items: workflowsInGroup(workflows, group.id),
    })),
    { group: undefined, items: ungroupedWorkflows(workflows, groups) },
  ]

  const commitNewGroup = (draft: string): void => {
    setEdit({ mode: 'idle' })
    const name = draft.trim()
    if (name.length === 0) return
    void onSaveMenu({ groups: createGroup(groups, newGroupId(), name) })
  }
  const commitGroupRename = (groupId: string, draft: string): void => {
    setEdit({ mode: 'idle' })
    const name = draft.trim()
    if (name.length === 0) return
    void onSaveMenu({ groups: renameGroup(groups, groupId, name) })
  }
  const commitWorkflowRename = (workflowId: string, draft: string): void => {
    setEdit({ mode: 'idle' })
    const name = draft.trim()
    if (name.length === 0) return
    void onSaveMenu({
      workflows: workflows.map(workflow => (workflow.id === workflowId ? { ...workflow, name } : workflow)),
    })
  }
  const endDrag = (): void => {
    setDraggedId(null)
    setDropTarget(null)
    setDropLane(null)
  }
  const commitDrop = (lane: WorkflowLane, overId: string | undefined, half: 'before' | 'after'): void => {
    // `dragOver*` only calls `preventDefault` (the browser precondition for a
    // `drop` event to fire at all) once a drag from one of this section's own
    // rows is in flight, so `draggedId` is set by the time a real drop lands.
    /* v8 ignore next -- defensive: only a `dragover` this component itself allowed reaches `drop`. */
    if (draggedId === null) return
    void onSaveMenu({
      workflows: reorderWithinGroup(workflows, lane.group?.id, nextSequence(lane.items, draggedId, overId, half)),
    })
    endDrag()
  }
  /**
   * Track the hovered half while a drag from this section's own rows passes
   * over `overId`; anything else declines (no indicator, no drop).
   */
  const dragOverRow = (event: DragEvent<HTMLLIElement>, overId: string): void => {
    if (draggedId === null || draggedId === overId) return
    event.preventDefault()
    setDropLane(null)
    setDropTarget({ id: overId, half: rowHalf(event) })
  }
  /** Accept a drag onto a lane as a whole — its header, or the placeholder an empty lane draws. */
  const dragOverLane = (event: DragEvent<HTMLElement>, lane: WorkflowLane): void => {
    if (draggedId === null) return
    event.preventDefault()
    setDropTarget(null)
    setDropLane({ groupId: lane.group?.id })
  }

  /**
   * The 移动到… rows for one workflow: every lane except the one it already
   * sits in. Empty for a console that has no group at all, whose single lane
   * is the one every row already sits in — the control is then left out
   * (see {@link renderRow}).
   */
  const moveEntries = (lane: WorkflowLane): MenuEntry[] => lanes
    .filter(candidate => candidate.group?.id !== lane.group?.id)
    .map(candidate => ({
      id: candidate.group?.id ?? UNGROUPED_MENU_ID,
      label: candidate.group?.name ?? t('groups.ungrouped'),
    }))

  const renderRow = (workflow: ServerMenuWorkflow, lane: WorkflowLane) => {
    const renaming = edit.mode === 'renamingWorkflow' && edit.id === workflow.id
    // A console with no group at all has one lane, and it is the one this row
    // already sits in: there is nowhere to send it, so the control is left out
    // rather than opening an empty menu.
    const destinations = moveEntries(lane)
    return (
      <li
        key={workflow.id}
        className={css.workflowRow}
        draggable={!renaming}
        data-dragging={draggedId === workflow.id}
        data-drop-position={dropTarget?.id === workflow.id ? dropTarget.half : undefined}
        onDragStart={(event) => {
          setDraggedId(workflow.id)
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', workflow.id)
        }}
        onDragEnd={endDrag}
        onDragOver={(event) => { dragOverRow(event, workflow.id) }}
        onDrop={(event) => {
          event.preventDefault()
          commitDrop(lane, workflow.id, rowHalf(event))
        }}
        onBlur={(event) => {
          // The list is portaled to `document.body`, so the row does not
          // contain it; React's own bubbling carries the menu's focus events
          // here all the same, and only this component opens a menu at a
          // time. Without this the anchor's reveal rule would take the
          // trigger away (`:focus-within` fails once the focus leaves) and
          // leave the list standing where it was placed.
          const next = event.relatedTarget
          const stays = next instanceof HTMLElement
            && (event.currentTarget.contains(next) || next.closest('[role="menu"]') !== null)
          if (!stays) setMoveMenuFor(null)
        }}
      >
        {renaming ? (
          <input
            className={css.renameInput}
            autoFocus
            aria-label={t('workflows.namePlaceholder')}
            placeholder={t('workflows.namePlaceholder')}
            defaultValue={workflow.name}
            onBlur={(event) => { commitWorkflowRename(workflow.id, event.currentTarget.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              else if (event.key === 'Escape') setEdit({ mode: 'idle' })
            }}
          />
        ) : (
          <button
            type="button"
            className={css.itemButton}
            data-active={current !== undefined && current === workflow.homeSessionId}
            onClick={() => { void onOpenWorkflow(workflow) }}
          >
            {unreadHomeSessionIds.has(workflow.homeSessionId) && <span className={css.dot} aria-hidden="true" />}
            {workflow.name}
          </button>
        )}
        <div className={css.workflowActions}>
          {destinations.length > 0 && (
            <Menu
              open={moveMenuFor === workflow.id}
              portal
              items={destinations}
              onSelect={(id) => {
                setMoveMenuFor(null)
                void onSaveMenu({
                  workflows: moveWorkflow(workflows, workflow.id, id === UNGROUPED_MENU_ID ? undefined : id),
                })
              }}
              onClose={() => { setMoveMenuFor(null) }}
              anchor={(
                <Tooltip label={t('groups.moveTo')} side="bottom" delayMs={500}>
                  <button
                    type="button"
                    className={css.iconButton}
                    aria-label={t('groups.moveTo')}
                    aria-haspopup="menu"
                    onClick={() => { setMoveMenuFor(workflow.id) }}
                  >
                    <IconFolderOpenOutline16 size={12} />
                  </button>
                </Tooltip>
              )}
            />
          )}
          <Tooltip label={t('workflows.rename')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('workflows.rename')}
              onClick={() => { setEdit({ mode: 'renamingWorkflow', id: workflow.id }) }}
            >
              <IconEditOutline16 size={12} />
            </button>
          </Tooltip>
          <Tooltip label={t('workflows.remove')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('workflows.remove')}
              onClick={() => {
                void onSaveMenu({ workflows: workflows.filter(candidate => candidate.id !== workflow.id) })
              }}
            >
              <IconTrashOutline16 size={12} />
            </button>
          </Tooltip>
        </div>
      </li>
    )
  }

  const renderGroupHead = (group: ServerMenuGroup, lane: WorkflowLane, folded: boolean) => (
    <div
      className={css.laneHead}
      data-drop-lane={dropLane?.groupId === group.id}
      onDragOver={(event) => { dragOverLane(event, lane) }}
      onDrop={(event) => {
        event.preventDefault()
        commitDrop(lane, undefined, 'before')
      }}
    >
      <button
        type="button"
        className={css.caret}
        data-expanded={!folded}
        aria-label={folded ? t('groups.expand') : t('groups.collapse')}
        aria-expanded={!folded}
        aria-controls={folded || lane.items.length === 0 ? undefined : laneListId(group.id)}
        onClick={() => { onSetCollapsed(group.id, !folded) }}
      >
        <IconTriangleRightFill14 size={10} />
      </button>
      {edit.mode === 'renamingGroup' && edit.id === group.id ? (
        <input
          id={laneNameId(group.id)}
          className={css.renameInput}
          autoFocus
          maxLength={MAX_GROUP_NAME_LENGTH}
          aria-label={t('groups.namePlaceholder')}
          placeholder={t('groups.namePlaceholder')}
          defaultValue={group.name}
          onBlur={(event) => { commitGroupRename(group.id, event.currentTarget.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            else if (event.key === 'Escape') setEdit({ mode: 'idle' })
          }}
        />
      ) : (
        <span id={laneNameId(group.id)} className={css.laneName}>{group.name}</span>
      )}
      {group.pinned && <span className={css.pinBadge} role="img" aria-label={t('groups.pinned')} />}
      <div className={css.workflowActions}>
        <Tooltip label={t('groups.rename')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('groups.rename')}
            onClick={() => { setEdit({ mode: 'renamingGroup', id: group.id }) }}
          >
            <IconEditOutline16 size={12} />
          </button>
        </Tooltip>
        <Tooltip label={group.pinned ? t('groups.unpin') : t('groups.pin')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={group.pinned ? t('groups.unpin') : t('groups.pin')}
            onClick={() => { void onSaveMenu({ groups: pinGroup(groups, group.id, !group.pinned) }) }}
          >
            {group.pinned ? <IconChevronDownOutline14 size={12} /> : <IconChevronUpOutline14 size={12} />}
          </button>
        </Tooltip>
        <Tooltip label={t('groups.remove')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('groups.remove')}
            onClick={() => { void onSaveMenu(deleteGroup(groups, workflows, group.id)) }}
          >
            <IconTrashOutline16 size={12} />
          </button>
        </Tooltip>
      </div>
    </div>
  )

  // A group is the one level of hierarchy this section has, and indentation
  // is the only thing stating it on screen: the lane names itself through its
  // own header, and the top level, which has no header, is the section — its
  // heading names that.
  const renderLane = (lane: WorkflowLane) => {
    const folded = lane.group !== undefined && collapsed[lane.group.id] === true
    return (
      <div
        key={lane.group?.id ?? UNGROUPED_MENU_ID}
        className={css.lane}
        data-pinned={lane.group?.pinned === true}
        role={lane.group === undefined ? undefined : 'group'}
        aria-labelledby={lane.group === undefined ? undefined : laneNameId(lane.group.id)}
      >
        {lane.group !== undefined && renderGroupHead(lane.group, lane, folded)}
        {!folded && lane.items.length > 0 && (
          <ul id={lane.group === undefined ? undefined : laneListId(lane.group.id)} className={css.list}>
            {lane.items.map(workflow => renderRow(workflow, lane))}
          </ul>
        )}
        {!folded && lane.items.length === 0 && (lane.group !== undefined || draggedId !== null) && (
          <p
            className={css.empty}
            data-drop-lane={dropLane !== null && dropLane.groupId === lane.group?.id}
            onDragOver={(event) => { dragOverLane(event, lane) }}
            onDrop={(event) => {
              event.preventDefault()
              commitDrop(lane, undefined, 'before')
            }}
          >
            {lane.group === undefined ? t('groups.dropToUngroup') : t('groups.empty')}
          </p>
        )}
      </div>
    )
  }

  return (
    <section className={css.group} data-server-sidebar-section="workflows">
      <div className={css.groupHead}>
        <h3 className={css.groupTitle}>{t('workflows.title')}</h3>
        <Tooltip label={t('groups.new')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('groups.new')}
            onClick={() => { setEdit({ mode: 'creatingGroup' }) }}
          >
            <IconPlusOutline16 size={12} />
          </button>
        </Tooltip>
      </div>
      {error !== undefined && <p className={css.error} role="alert">{t('workflows.error', { message: error })}</p>}
      {edit.mode === 'creatingGroup' && (
        <input
          className={css.renameInput}
          autoFocus
          maxLength={MAX_GROUP_NAME_LENGTH}
          aria-label={t('groups.namePlaceholder')}
          placeholder={t('groups.namePlaceholder')}
          onBlur={(event) => { commitNewGroup(event.currentTarget.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            else if (event.key === 'Escape') setEdit({ mode: 'idle' })
          }}
        />
      )}
      {workflows.length === 0 && groups.length === 0
        ? <p className={css.empty}>{t('workflows.empty')}</p>
        : lanes.map(renderLane)}
    </section>
  )
}
