/**
 * "存为工作流" (save as workflow) session-header action: the regular-channel
 * seat for decision ③'s conditional entry point, registered into
 * `dsh-client-ui-conversation`'s `'conversation.session.header.actions'` list
 * seat rather than a sidebar-local "+" button (a documented, additive header
 * seat exists — see the package README's Composition section for why this
 * was chosen over the sidebar fallback the task brief allows).
 *
 * Renders nothing until the current session has produced at least one user
 * message (decision ③): the conversation snapshot's settled node list is
 * scanned for a `'user'`-kind node, the same window `StatsLine` folds its own
 * counts from. This is a v1 approximation, not an exact answer — a node
 * before a compaction boundary or an unloaded earlier page is invisible to
 * this window, so a very long conversation whose only user turn fell out of
 * the loaded window could hide the action; see the package README's Known
 * Limitations.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/SaveWorkflowAction
 */
import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { captureNavSnapshot } from './nav-snapshot.ts'
import css from './SaveWorkflowAction.module.css'

/** This action's own injected face, wired in `client/index.ts`. */
export interface SaveWorkflowInjected {
  /**
   * Save the current session as a new workflow under `name`, capturing its
   * current navigation snapshot. Not awaited by this component — the
   * commit is fire-and-forget, matching every other write in this package's
   * menu (see `WorkflowGroup.tsx`).
   */
  onSave: (sessionId: string, name: string, navSnapshot: readonly string[]) => Promise<void>
}

/** Full props: session-scope runtime share + this action's own injected face + the locale seat. */
export type SaveWorkflowActionProps =
  PropsRuntime<'conversation.session.header.actions'> & SaveWorkflowInjected & PropsLocale<'serverSidebar'>

/**
 * Render the header's "存为工作流" trigger, or nothing until the current
 * session has a user message on record.
 * @param props - see {@link SaveWorkflowActionProps}.
 * @returns the trigger (or its in-place name field), or `null`.
 */
export function SaveWorkflowAction({ sessionId, useSession, useProjection, onSave, t }: SaveWorkflowActionProps) {
  const [adding, setAdding] = useState(false)
  const hasUserMessage = useSession(s => s.chat.legacy.nodes.some(node => node.kind === 'user'))
  const contentSurface = useProjection('contentSurface')

  if (!hasUserMessage) return null

  const commit = (draft: string): void => {
    setAdding(false)
    const name = draft.trim()
    if (name.length === 0) return
    void onSave(sessionId, name, captureNavSnapshot(contentSurface))
  }

  return adding
    ? (
      <input
        className={css.nameField}
        autoFocus
        aria-label={t('workflows.namePlaceholder')}
        placeholder={t('workflows.namePlaceholder')}
        onBlur={(event) => { commit(event.currentTarget.value) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          else if (event.key === 'Escape') setAdding(false)
        }}
      />
    )
    : (
      <button type="button" className={css.trigger} onClick={() => { setAdding(true) }}>
        {t('saveWorkflow.action')}
      </button>
    )
}
