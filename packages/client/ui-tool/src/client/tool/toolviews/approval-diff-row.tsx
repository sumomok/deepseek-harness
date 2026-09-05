/** Approval-time preview of the change a pending file-mutation call will make. @module */
import type { Context } from '@deepseek-ai/cordis'
import { DiffBlock, type DiffHunk } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-approval/client'
import { diffCardModel } from '../models/diff-card-model.ts'
import { diffBlockLabels } from '../models/primitive-labels.ts'
import { relativizeToCwd } from '../models/tool-call-model.ts'
import { CONVERSATION_NS as NS } from '../../locale.ts'
import css from './approval-diff-row.module.css'

/**
 * Diff-body lines the approval card shows before collapsing the middle. The
 * card is a decision surface, not a summary: the reader answers for content
 * they have not seen anywhere else yet, so the cap sits far above the chat
 * row's {@link CHAT_DIFF_MAX_LINES} and the primitive's own default, and the
 * fold toggle still reaches the rest. The card body scrolls at the composer's
 * height, so a long preview never pushes the decision buttons off screen. A
 * design constant of this surface, not a deployment choice.
 */
export const APPROVAL_DIFF_MAX_LINES = 40

type ApprovalDiffProps =
  PropsRuntime<'conversation.approval.detail'>
  & PropsLocale<'conversation'>

/**
 * Render the file change the correlated pending call intends to make.
 *
 * Hunk paths display relative to the session workspace when they are rooted
 * there and verbatim otherwise, so a write that leaves the workspace shows
 * that it does.
 * @param props - Approval identity and the Session-standard Chat and Session hooks.
 * @returns the intended diff, or nothing when no pending call supplies one.
 */
export function ApprovalDiffPreview({ callId, useChat, useSessions, sessionId, t }: ApprovalDiffProps) {
  const cwd = useSessions(s => s.byId[sessionId]?.cwd)
  const pending = useChat((snapshot) => {
    for (const node of snapshot.nodes.values()) {
      const root = node.kind === 'tool-call' ? (node as ChatNode<'tool-call'>).data.root : undefined
      if (root !== undefined && root.callId === callId && !('kind' in root)) return root
    }
    return undefined
  })
  const model = pending === undefined ? null : diffCardModel(pending)
  if (model === null) return null
  const diffs: DiffHunk[] = model.card.diffs.map(hunk => ({
    ...hunk,
    path: relativizeToCwd(hunk.path, cwd),
  }))
  return (
    <DiffBlock
      diffs={diffs}
      labels={diffBlockLabels(t)}
      maxLines={APPROVAL_DIFF_MAX_LINES}
      className={css.diff}
    />
  )
}

/**
 * Registers the approval-time preview for every file-mutation tool
 * {@link diffCardModel} derives an intended diff for. A tool absent here keeps
 * the approval card's reason-only body.
 */
export const approvalDiffPreview = {
  name: 'approval-diff-preview',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('conversation.approval.detail', function* () {
      yield ctx.slots.register({ name: 'conversation.approval.detail', key: 'write', locale: NS }, ApprovalDiffPreview)
      yield ctx.slots.register({ name: 'conversation.approval.detail', key: 'edit', locale: NS }, ApprovalDiffPreview)
      yield ctx.slots.register({
        name: 'conversation.approval.detail', key: 'str_replace_editor', locale: NS,
      }, ApprovalDiffPreview)
    })
  },
}
