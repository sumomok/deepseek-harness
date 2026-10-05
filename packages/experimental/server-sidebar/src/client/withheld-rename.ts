/**
 * `dsh-client-ui-workspace`'s rename dialog, withheld on the console.
 *
 * `ui-workspace` draws 重命名会话 through its `shell.overlay` entry
 * `workspace.session-rename` whenever its rename request is set: by the
 * `session.rename` key, which `console-shortcuts.ts` withholds, and by the row
 * menus of the conversation browser in `sidebar.workspaces`, which this shell
 * does not declare. The console offers no rename: a conversation it keeps is
 * named as a workflow. {@link withholdRenameDialog} registers an entry under
 * that id below `ui-workspace`'s priority (`shadowed-overlay.ts`), so
 * `ui-workspace`'s dialog never mounts, and settles every rename request as
 * soon as it is set, through the shadowed face's `settleSessionRename`, so no
 * request is left pending for `ui-workspace`'s dialog to show once the
 * console unloads. A request raised by any path — a Desktop shell's native
 * accelerator included — therefore shows nothing and renames nothing.
 *
 * The entry id and the face's members (`hooks.renameRequest`,
 * `settleSessionRename`) are literal copies: `ui-workspace`'s `/client` entry
 * exports no constant for the id and no type for the face.
 * `tests/withheld-rename.client.spec.ts` checks each copy against the owning
 * source. A face this module does not recognise leaves its request pending;
 * the dialog stays withheld.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/withheld-rename
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls ui-layout's declaration of `shell.overlay`.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { followShadowed, hookOf, isAction, REPLACING_PRIORITY, shadowedFace } from './shadowed-overlay.ts'

/** The id of `ui-workspace`'s rename dialog in `shell.overlay`, which this entry shadows. */
const RENAME_ENTRY_ID = 'workspace.session-rename'

/** The members of the shadowed entry's face this module reads. */
interface RenameFace {
  /** The pending rename request, or null. */
  renameRequest: HostObservable<unknown>
  /** Clear the pending rename request. */
  settleSessionRename: () => unknown
}

/**
 * The members this module reads from the shadowed entry's face.
 * @param face - what the entry's inject factory returned.
 * @returns the request source and its settlement, or undefined when the face lacks either.
 */
function renameFaceOf(face: Record<string, unknown>): RenameFace | undefined {
  const renameRequest = hookOf(face, 'renameRequest')
  const { settleSessionRename } = face
  if (renameRequest === undefined || !isAction(settleSessionRename)) return undefined
  return { renameRequest, settleSessionRename }
}

/**
 * The entry drawn in place of the rename dialog: nothing.
 * @returns nothing to render.
 */
export function WithheldRenameDialog(): null {
  return null
}

/**
 * Settle every rename request `ui-workspace` raises, for as long as the
 * returned disposer has not run.
 * @param ctx - the context holding the slot registry.
 * @returns the disposer that stops settling.
 */
function settleRenameRequests(ctx: ClientContext): () => void {
  const face = shadowedFace(ctx.slots, RENAME_ENTRY_ID, WithheldRenameDialog, renameFaceOf)
  const pending = followShadowed(ctx.slots, face, current => current.renameRequest, raw => (raw === null ? null : true))
  const settle = (): void => {
    if (pending.getSnapshot() !== null) face()?.settleSessionRename()
  }
  const stop = pending.subscribe(settle)
  settle()
  return stop
}

/**
 * Shadow `ui-workspace`'s rename dialog with an entry that draws nothing, and
 * settle its requests, once the shell declares `shell.overlay`.
 * @param ctx - client root context; its unload removes the entry and stops settling.
 */
export function withholdRenameDialog(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => {
    const dispose = ctx.slots.register({
      name: 'shell.overlay', id: 'workspace.session-rename', priority: REPLACING_PRIORITY,
    }, WithheldRenameDialog)
    const stop = settleRenameRequests(ctx)
    return () => {
      stop()
      dispose()
    }
  }), 'server-sidebar: the withheld rename dialog')
}
