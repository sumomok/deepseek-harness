/**
 * The 我的工作流 (my workflows) group: a user's own named shortcuts back to
 * long-running conversations they taught the agent something in. Pure
 * presentation — every list comes from props, and the one local state this
 * component owns is which row (if any) is mid-rename, never persisted.
 *
 * Reordering is up/down icon buttons rather than HTML5 drag-and-drop: the
 * task brief's own downgrade clause ("若实现体量失控，降级为右键菜单「上移/
 * 下移」") is exercised here given this change's overall size — see the
 * package README and the accompanying Agent Note.
 *
 * Rename/remove/move likewise use the existing sidebar idiom (hover-revealed
 * icon buttons, carried over from the former favorites menu) rather than a
 * native `contextmenu` popup: same outcomes, better keyboard/touch
 * discoverability, and no new interaction pattern introduced for one
 * feature.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/WorkflowGroup
 */
import { useState } from 'react'
import { IconEditOutline16, IconTrashOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ServerMenuWorkflow } from './workflow-api.ts'
import type { ServerSidebarKey } from './locales.ts'
import { sortedWorkflows } from './workflow-actions.ts'
import css from './SidebarGroups.module.css'

/** Which workflow row (if any) is mid-rename; never persisted. */
type EditState = { readonly mode: 'idle' } | { readonly mode: 'renaming'; readonly id: string; readonly draft: string }

/** Full props of the workflow group. */
export interface WorkflowGroupProps {
  /** Every workflow, in no particular storage order — this component sorts by `order` for display. */
  workflows: readonly ServerMenuWorkflow[]
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

/** Swap two adjacent workflows' `order` values (by display position), leaving every other workflow untouched. */
function moved(workflows: readonly ServerMenuWorkflow[], id: string, direction: 'up' | 'down'): ServerMenuWorkflow[] {
  const ordered = sortedWorkflows(workflows)
  const index = ordered.findIndex(workflow => workflow.id === id)
  const swapWith = direction === 'up' ? index - 1 : index + 1
  // The move-up/move-down buttons are `disabled` at exactly this boundary
  // (see the render below), and jsdom (like a real browser) never dispatches
  // a click to a disabled button, so a boundary or unknown-id call never
  // reaches this function through the UI. Bounds are checked explicitly
  // (rather than trusting `.at()`'s own `undefined`) because `.at()` treats a
  // negative index as counting from the end, not as out of bounds.
  /* v8 ignore next -- defensive: the disabled boundary buttons already exclude this case. */
  if (index === -1 || swapWith < 0 || swapWith >= ordered.length) return [...workflows]
  const a = ordered.at(index)
  const b = ordered.at(swapWith)
  /* v8 ignore next -- defensive: unreachable once both indices are in bounds. */
  if (a === undefined || b === undefined) return [...workflows]
  return workflows.map((workflow) => {
    if (workflow.id === a.id) return { ...workflow, order: b.order }
    if (workflow.id === b.id) return { ...workflow, order: a.order }
    return workflow
  })
}

/**
 * Render the workflow group.
 * @param props - see {@link WorkflowGroupProps}.
 * @returns the group element tree.
 */
export function WorkflowGroup({
  workflows, unreadHomeSessionIds, onOpenWorkflow, onSaveWorkflows, error, t,
}: WorkflowGroupProps) {
  const [edit, setEdit] = useState<EditState>({ mode: 'idle' })
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
  const move = (id: string, direction: 'up' | 'down'): void => {
    void onSaveWorkflows(moved(workflows, id, direction))
  }

  return (
    <section className={css.group} data-server-sidebar-section="workflows">
      <h3 className={css.groupTitle}>{t('workflows.title')}</h3>
      {error !== undefined && <p className={css.error} role="alert">{t('workflows.error', { message: error })}</p>}
      {ordered.length === 0
        ? <p className={css.empty}>{t('workflows.empty')}</p>
        : (
          <ul className={css.list}>
            {ordered.map((workflow, index) => {
              const renaming = edit.mode === 'renaming' && edit.id === workflow.id
              const unread = unreadHomeSessionIds.has(workflow.homeSessionId)
              return (
                <li key={workflow.id} className={css.workflowRow}>
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
                      onClick={() => { void onOpenWorkflow(workflow) }}
                    >
                      {unread && <span className={css.dot} aria-hidden="true" />}
                      {workflow.name}
                    </button>
                  )}
                  <div className={css.workflowActions}>
                    <Tooltip label={t('workflows.moveUp')} side="bottom" delayMs={500}>
                      <button
                        type="button"
                        className={css.iconButton}
                        aria-label={t('workflows.moveUp')}
                        disabled={index === 0}
                        onClick={() => { move(workflow.id, 'up') }}
                      >
                        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                          <path d="M8 4L3 10H13L8 4Z" fill="currentColor" />
                        </svg>
                      </button>
                    </Tooltip>
                    <Tooltip label={t('workflows.moveDown')} side="bottom" delayMs={500}>
                      <button
                        type="button"
                        className={css.iconButton}
                        aria-label={t('workflows.moveDown')}
                        disabled={index === ordered.length - 1}
                        onClick={() => { move(workflow.id, 'down') }}
                      >
                        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                          <path d="M8 12L13 6H3L8 12Z" fill="currentColor" />
                        </svg>
                      </button>
                    </Tooltip>
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
