/**
 * The 我的工作流 (my workflows) group: a user's own named shortcuts back to
 * long-running conversations they taught the agent something in. Pure
 * presentation — every list comes from props; the local state this
 * component owns is which row (if any) is mid-rename, and which row an
 * in-flight drag is hovering, neither persisted.
 *
 * Reordering is native HTML5 drag-and-drop: a row's `dragstart` records it
 * as the dragged workflow, `dragover` tracks which half of the hovered
 * row's own bounding box the pointer sits over (top half inserts before it,
 * bottom half inserts after), and `drop` commits through the pure
 * {@link reordered} transform, which rewrites the complete list's `order`
 * fields to the resulting display sequence (0..n-1).
 *
 * Rename/remove use the existing sidebar idiom (hover-revealed icon
 * buttons, carried over from the former favorites menu) rather than a
 * native `contextmenu` popup: same outcomes, better keyboard/touch
 * discoverability, and no new interaction pattern introduced for one
 * feature.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/WorkflowGroup
 */
import { useState } from 'react'
import type { DragEvent } from 'react'
import { IconEditOutline16, IconTrashOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ServerMenuWorkflow } from './workflow-api.ts'
import type { ServerSidebarKey } from './locales.ts'
import { reordered, sortedWorkflows } from './workflow-actions.ts'
import css from './SidebarGroups.module.css'

/** Which workflow row (if any) is mid-rename; never persisted. */
type EditState = { readonly mode: 'idle' } | { readonly mode: 'renaming'; readonly id: string; readonly draft: string }

/** Which half of a hovered row an in-flight drag currently sits over — the drop-position indicator this implies. */
interface DropTarget {
  readonly id: string
  readonly half: 'before' | 'after'
}

/** Full props of the workflow group. */
export interface WorkflowGroupProps {
  /** Every workflow, in no particular storage order — this component sorts by `order` for display. */
  workflows: readonly ServerMenuWorkflow[]
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
  /** Persist the complete next workflow list (rename/remove/reorder all funnel through this). Not awaited by this component. */
  onSaveWorkflows: (next: ServerMenuWorkflow[]) => Promise<void>
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

/** Resolve the `reordered`-shaped `beforeId` a drop onto `overId`'s given half implies. */
function beforeIdFor(ordered: readonly ServerMenuWorkflow[], overId: string, half: 'before' | 'after'): string | undefined {
  if (half === 'before') return overId
  return ordered[ordered.findIndex(workflow => workflow.id === overId) + 1]?.id
}

/**
 * Render the workflow group.
 * @param props - see {@link WorkflowGroupProps}.
 * @returns the group element tree.
 */
export function WorkflowGroup({
  workflows, current, unreadHomeSessionIds, onOpenWorkflow, onSaveWorkflows, error, t,
}: WorkflowGroupProps) {
  const [edit, setEdit] = useState<EditState>({ mode: 'idle' })
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const ordered = sortedWorkflows(workflows)

  const commitRename = (id: string, draft: string): void => {
    setEdit({ mode: 'idle' })
    const name = draft.trim()
    if (name.length === 0) return
    void onSaveWorkflows(workflows.map(workflow => (workflow.id === id ? { ...workflow, name } : workflow)))
  }
  const remove = (id: string): void => {
    void onSaveWorkflows(workflows.filter(workflow => workflow.id !== id))
  }
  const endDrag = (): void => {
    setDraggedId(null)
    setDropTarget(null)
  }
  /** Track the hovered half while a drag from this list's own rows passes over `overId`; anything else declines (no indicator, no drop). */
  const dragOver = (event: DragEvent<HTMLLIElement>, overId: string): void => {
    if (draggedId === null || draggedId === overId) return
    event.preventDefault()
    setDropTarget({ id: overId, half: rowHalf(event) })
  }
  const drop = (event: DragEvent<HTMLLIElement>, overId: string): void => {
    event.preventDefault()
    // `dragOver` only calls `preventDefault` (the browser precondition for a
    // `drop` event to fire at all) once a drag from one of this list's own
    // rows is in flight, so `draggedId` is already set by the time a real
    // `drop` reaches here.
    /* v8 ignore next -- defensive: only a `dragover` this component itself allowed reaches `drop`. */
    if (draggedId === null) return
    void onSaveWorkflows(reordered(workflows, draggedId, beforeIdFor(ordered, overId, rowHalf(event))))
    endDrag()
  }

  return (
    <section className={css.group} data-server-sidebar-section="workflows">
      <h3 className={css.groupTitle}>{t('workflows.title')}</h3>
      {error !== undefined && <p className={css.error} role="alert">{t('workflows.error', { message: error })}</p>}
      {ordered.length === 0
        ? <p className={css.empty}>{t('workflows.empty')}</p>
        : (
          <ul className={css.list}>
            {ordered.map((workflow) => {
              const renaming = edit.mode === 'renaming' && edit.id === workflow.id
              const unread = unreadHomeSessionIds.has(workflow.homeSessionId)
              const active = current !== undefined && current === workflow.homeSessionId
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
                  onDragOver={(event) => { dragOver(event, workflow.id) }}
                  onDrop={(event) => { drop(event, workflow.id) }}
                >
                  {renaming ? (
                    <input
                      className={css.renameInput}
                      autoFocus
                      aria-label={t('workflows.namePlaceholder')}
                      placeholder={t('workflows.namePlaceholder')}
                      defaultValue={workflow.name}
                      onBlur={(event) => { commitRename(workflow.id, event.currentTarget.value) }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur()
                        else if (event.key === 'Escape') setEdit({ mode: 'idle' })
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className={css.itemButton}
                      data-active={active}
                      onClick={() => { void onOpenWorkflow(workflow) }}
                    >
                      {unread && <span className={css.dot} aria-hidden="true" />}
                      {workflow.name}
                    </button>
                  )}
                  <div className={css.workflowActions}>
                    <Tooltip label={t('workflows.rename')} side="bottom" delayMs={500}>
                      <button
                        type="button"
                        className={css.iconButton}
                        aria-label={t('workflows.rename')}
                        onClick={() => { setEdit({ mode: 'renaming', id: workflow.id, draft: workflow.name }) }}
                      >
                        <IconEditOutline16 size={12} />
                      </button>
                    </Tooltip>
                    <Tooltip label={t('workflows.remove')} side="bottom" delayMs={500}>
                      <button
                        type="button"
                        className={css.iconButton}
                        aria-label={t('workflows.remove')}
                        onClick={() => { remove(workflow.id) }}
                      >
                        <IconTrashOutline16 size={12} />
                      </button>
                    </Tooltip>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
    </section>
  )
}
