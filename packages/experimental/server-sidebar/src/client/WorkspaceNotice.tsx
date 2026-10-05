/**
 * The console's notice in place of `dsh-client-ui-workspace`'s.
 *
 * `ui-workspace` raises its notices through one `shell.overlay` entry,
 * `workspace.row-toast`, and words the four the console can raise in the
 * vocabulary it keeps off the screen. A page that could not prepare a place to
 * hold conversations shows 无法创建默认工作区，请通过“选择工作区”选择文件夹,
 * which names the workspace and a picker the console hides. A new conversation
 * the Host refused shows 新建会话失败： with the Host's own reason. The
 * `session.archive` keyboard shortcut archives the conversation on screen, and
 * its two outcomes, archived and stopped-and-archived, show 会话已归档 or
 * 已停止并归档 with an undo and a filter for archived rows this shell does not
 * have. {@link replaceWorkspaceNotice} registers {@link WorkspaceNotice} under
 * that id below `ui-workspace`'s priority (`shadowed-overlay.ts`), so
 * `ui-workspace`'s own toast never mounts. The two archive notices keep their
 * undo, which un-archives through `ui-workspace`, on the same 6 s hold
 * `ui-workspace` gives them.
 *
 * Which notice is up is still `ui-workspace`'s to say: the shadowed entry's
 * inject face carries it (`hooks.toast`, `dismissToast`, `undoArchive`), and
 * nothing else does. {@link shadowedNoticeSource} reads that face off the slot
 * ledger through `shadowed-overlay.ts`. The kind names and the archive
 * notices' `sessionId` field are checked against `ui-workspace`'s exported
 * `RowToast` type at compile time ({@link NOTICE_COPY}, {@link SESSION_FIELD}).
 * The entry id, the face's member names, and the notice's `seq` field are
 * literal copies: `ui-workspace`'s `/client` entry exports no constant for the
 * id, and neither the face's type nor the published notice's
 * (`RowToastInjected`, `RowToastState`). `tests/workspace-notice.client.spec.tsx`
 * checks each copy against `ui-workspace`'s source. A renamed entry id
 * un-shadows `ui-workspace`'s toast; a face this module no longer recognises
 * shows no notice at all.
 *
 * The other kinds `ui-workspace` raises belong to its `sidebar.workspaces`
 * browser's row actions (pin, unpin, opening an archived row); this shell does
 * not declare that slot, so they never fire here, and this entry draws nothing
 * for them.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/WorkspaceNotice
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RowToast } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls ui-layout's declaration of `shell.overlay`.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ServerSidebarKey } from './locales.ts'
import {
  followShadowed, hookOf, isAction, isSessionAction, type OverlayLedger, REPLACING_PRIORITY, shadowedFace,
} from './shadowed-overlay.ts'

/**
 * The id of `ui-workspace`'s notice entry in `shell.overlay`, which this
 * entry shadows. {@link replaceWorkspaceNotice} writes it out literally as
 * well, so the client slot catalog names the cell.
 */
const NOTICE_ENTRY_ID = 'workspace.row-toast'

/** Hold of the two archive notices, which carry an action to react to; `ui-workspace` holds its own for the same 6 s. */
const ARCHIVE_NOTICE_HOLD_MS = 6000

/** Dictionary namespace the notice reads. */
const NS = 'serverSidebar'

/**
 * The console's copy for each `ui-workspace` notice kind it draws. Every key
 * must be one of `RowToast`'s kinds, so a kind `ui-workspace` renames fails
 * this package's typecheck.
 */
const NOTICE_COPY = {
  defaultWorkspaceFailed: 'notice.startFailed',
  createFailed: 'notice.newFailed',
  archived: 'notice.removed',
  stoppedAndArchived: 'notice.stoppedAndRemoved',
} as const satisfies Partial<Record<RowToast['kind'], ServerSidebarKey>>

/** The notice kinds that report an archive and offer its undo. */
type ArchiveKind = Extract<keyof typeof NOTICE_COPY, 'archived' | 'stoppedAndArchived'>

/**
 * The field an archive notice names its conversation in. It must be one of
 * the archive kinds' `RowToast` fields, so a field `ui-workspace` renames
 * fails this package's typecheck.
 */
const SESSION_FIELD = 'sessionId' satisfies keyof Extract<RowToast, { kind: ArchiveKind }>

/**
 * One notice this shell draws, as `ui-workspace` publishes it: what happened,
 * the archived conversation for the two archive notices, and a number that
 * restarts a repeated notice's hold.
 */
export type WorkspaceNoticeState =
  | {
    /** `ui-workspace`'s notice kind. */
    kind: Exclude<keyof typeof NOTICE_COPY, ArchiveKind>
    /** Increments with every notice raised. */
    seq: number
  }
  | {
    /** `ui-workspace`'s notice kind. */
    kind: ArchiveKind
    /** The conversation the shortcut archived. */
    sessionId: SessionId
    /** Increments with every notice raised. */
    seq: number
  }

/** `ui-workspace`'s notice, as {@link shadowedNoticeSource} hands it on. */
export interface ShadowedNotice {
  /** The notice up now, or none. */
  notice: HostObservable<WorkspaceNoticeState | null>
  /** Take the notice down. */
  dismiss: () => void
  /**
   * Un-archive a conversation through `ui-workspace`.
   * @param sessionId - the conversation an archive notice names.
   */
  undoArchive: (sessionId: SessionId) => void
}

/** The members of the shadowed entry's face this module reads. */
interface ShadowedFace {
  toast: HostObservable<unknown>
  dismissToast: () => unknown
  undoArchive: (sessionId: SessionId) => unknown
}

/** Business face of the console's entry. */
export interface WorkspaceNoticeInjected {
  hooks: {
    /** The notice up now, or none. */
    notice: HostObservable<WorkspaceNoticeState | null>
  }
  /** Take the notice down. */
  dismissNotice: () => void
  /**
   * Un-archive the conversation an archive notice names.
   * @param sessionId - that conversation.
   */
  undoArchive: (sessionId: SessionId) => void
}

/** Props of the console's notice entry. */
export type WorkspaceNoticeProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'serverSidebar'>
  & InjectFace<WorkspaceNoticeInjected>

/**
 * The members this module reads from the shadowed entry's face.
 * @param face - what the entry's inject factory returned.
 * @returns the toast source, its dismissal, and the archive undo, or undefined when the face lacks any of them.
 */
function shadowedFaceOf(face: Record<string, unknown>): ShadowedFace | undefined {
  const toast = hookOf(face, 'toast')
  const { dismissToast, undoArchive } = face
  if (toast === undefined || !isAction(dismissToast) || !isSessionAction(undoArchive)) return undefined
  return { toast, dismissToast, undoArchive }
}

/**
 * One published notice, read field by field.
 * @param value - the shadowed toast source's snapshot.
 * @returns the notice, or null when the snapshot carries none this shell draws.
 */
function noticeOf(value: unknown): WorkspaceNoticeState | null {
  if (typeof value !== 'object' || value === null || !('kind' in value) || !('seq' in value)) return null
  const { kind, seq } = value
  if (typeof seq !== 'number') return null
  switch (kind) {
    case 'defaultWorkspaceFailed':
    case 'createFailed':
      return { kind, seq }
    case 'archived':
    case 'stoppedAndArchived': {
      const sessionId = SESSION_FIELD in value ? value[SESSION_FIELD] : undefined
      return typeof sessionId === 'string' ? { kind, sessionId: sessionId as SessionId, seq } : null
    }
    // `RowToast` is `ui-workspace`'s to extend; the other kinds come from row
    // actions this shell does not offer (see the module doc).
    default:
      return null
  }
}

/**
 * `ui-workspace`'s notice stream, read through the entry this module shadows.
 * @param ledger - the slot ledger the two entries are registered on.
 * @returns the notice source, its dismissal, and the archive undo; all three
 * are inert while no `ui-workspace` entry is registered.
 */
export function shadowedNoticeSource(ledger: OverlayLedger): ShadowedNotice {
  const face = shadowedFace(ledger, NOTICE_ENTRY_ID, WorkspaceNotice, shadowedFaceOf)
  return {
    notice: followShadowed(ledger, face, current => current.toast, noticeOf),
    dismiss: () => { face()?.dismissToast() },
    undoArchive: (sessionId) => { face()?.undoArchive(sessionId) },
  }
}

/**
 * Render the notice up now.
 * @param props - see {@link WorkspaceNoticeProps}; only `useNotice`, `dismissNotice`, `undoArchive`, and `t` are read.
 * @returns the notice, or null.
 */
export function WorkspaceNotice({ useNotice, dismissNotice, undoArchive, t }: Pick<WorkspaceNoticeProps, 'useNotice' | 'dismissNotice' | 'undoArchive' | 't'>) {
  const notice = useNotice(current => current)
  if (notice === null) return null
  const text = t(NOTICE_COPY[notice.kind])
  if (notice.kind === 'archived' || notice.kind === 'stoppedAndArchived') {
    const { sessionId } = notice
    return (
      <Toast
        key={`notice-${String(notice.seq)}`}
        text={text}
        tone="success"
        holdMs={ARCHIVE_NOTICE_HOLD_MS}
        actions={[{ label: t('notice.undo'), onClick: () => { dismissNotice(); undoArchive(sessionId) } }]}
        onDone={dismissNotice}
      />
    )
  }
  return (
    <Toast
      key={`notice-${String(notice.seq)}`}
      text={text}
      icon={<IconWarningOutlineRegular />}
      onDone={dismissNotice}
    />
  )
}

/**
 * Shadow `ui-workspace`'s notice entry, once the shell declares `shell.overlay`.
 * @param ctx - client root context; its unload removes the entry.
 */
export function replaceWorkspaceNotice(ctx: ClientContext): void {
  const { notice, dismiss, undoArchive } = shadowedNoticeSource(ctx.slots)
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'workspace.row-toast',
    priority: REPLACING_PRIORITY,
    locale: NS,
    inject: (): WorkspaceNoticeInjected => ({ hooks: { notice }, dismissNotice: dismiss, undoArchive }),
  }, WorkspaceNotice)), 'server-sidebar: the console\'s workspace notice')
}
