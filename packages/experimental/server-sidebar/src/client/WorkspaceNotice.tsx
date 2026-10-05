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
 * have. `shell.overlay` is a list slot whose cell is the entry id, and only a
 * cell's lowest-priority entry renders (`SlotCore.register`'s shadowing rule),
 * so {@link replaceWorkspaceNotice} registers {@link WorkspaceNotice} at
 * priority -1 under that id, and `ui-workspace`'s own toast never mounts. The
 * two archive notices keep their undo, which un-archives through
 * `ui-workspace`, on the same 6 s hold `ui-workspace` gives them.
 *
 * Which notice is up is still `ui-workspace`'s to say: the shadowed entry's
 * inject face carries it (`hooks.toast`, `dismissToast`, `undoArchive`), and
 * nothing else does. {@link shadowedNoticeSource} reads that face off the slot
 * ledger, follows the ledger so an entry registered after this one is still
 * found, and checks the face's members before using them, since the ledger
 * erases their types. The kind names are checked against `ui-workspace`'s
 * exported `RowToast` type at compile time ({@link NOTICE_COPY}); the entry
 * id, the face's member names, and the notice's `seq` and `sessionId` fields
 * are literal copies, since `ui-workspace` exports neither a constant for them
 * nor its face type. A renamed entry id un-shadows `ui-workspace`'s toast; a
 * face this module no longer recognises shows no notice at all.
 *
 * The other kinds `ui-workspace` raises belong to its `sidebar.workspaces`
 * browser's row actions (pin, unpin, opening an archived row); this shell does
 * not declare that slot, so they never fire here, and this entry draws nothing
 * for them.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/WorkspaceNotice
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { RowToast } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls ui-layout's declaration of `shell.overlay`.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ServerSidebarKey } from './locales.ts'

/**
 * The id of `ui-workspace`'s notice entry in `shell.overlay`, which this
 * entry shadows. {@link replaceWorkspaceNotice} writes it out literally as
 * well, so the client slot catalog names the cell.
 */
const NOTICE_ENTRY_ID = 'workspace.row-toast'

/** Shadowing rank of the console's entry: below `ui-workspace`'s default 0. */
const REPLACING_PRIORITY = -1

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

/** The share of the slot ledger {@link shadowedNoticeSource} reads. */
export interface NoticeLedger {
  /**
   * Every entry registered into the slot, shadowed ones included.
   * @param key - the slot key.
   * @returns the entries.
   */
  entries(key: 'shell.overlay'): readonly StoredEntry[]
  /**
   * Follow the slot's registrations.
   * @param key - the slot key.
   * @param fn - called after each change.
   * @returns the unsubscribe.
   */
  subscribe(key: 'shell.overlay', fn: () => void): () => void
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
  dismissToast: () => void
  undoArchive: (sessionId: SessionId) => void
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
 * Whether a value is an observable snapshot source.
 * @param value - the candidate.
 * @returns true when it carries `getSnapshot` and `subscribe` functions.
 */
function isObservable(value: unknown): value is HostObservable<unknown> {
  return typeof value === 'object' && value !== null
    && 'getSnapshot' in value && typeof value.getSnapshot === 'function'
    && 'subscribe' in value && typeof value.subscribe === 'function'
}

/**
 * Whether a value is a function the face's caller invokes with no argument.
 * @param value - the candidate.
 * @returns true for any function.
 */
function isAction(value: unknown): value is () => void {
  return typeof value === 'function'
}

/**
 * Whether a value is a function the face's caller invokes with a conversation id.
 * @param value - the candidate.
 * @returns true for any function.
 */
function isSessionAction(value: unknown): value is (sessionId: SessionId) => void {
  return typeof value === 'function'
}

/**
 * The members this module reads from the shadowed entry's face.
 * @param face - what the entry's inject factory returned.
 * @returns the toast source, its dismissal, and the archive undo, or undefined when the face lacks any of them.
 */
function shadowedFaceOf(face: Record<string, unknown>): ShadowedFace | undefined {
  const { hooks, dismissToast, undoArchive } = face
  if (!isAction(dismissToast) || !isSessionAction(undoArchive)) return undefined
  if (typeof hooks !== 'object' || hooks === null || !('toast' in hooks)) return undefined
  const { toast } = hooks
  if (!isObservable(toast)) return undefined
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
      const sessionId = 'sessionId' in value ? value.sessionId : undefined
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
export function shadowedNoticeSource(ledger: NoticeLedger): ShadowedNotice {
  const faces = new WeakMap<StoredEntry, ShadowedFace | null>()
  const shadowed = (): ShadowedFace | undefined => {
    const entry = ledger.entries('shell.overlay')
      .find(candidate => candidate.options.id === NOTICE_ENTRY_ID && candidate.component !== WorkspaceNotice)
    if (entry?.inject === undefined) return undefined
    let face = faces.get(entry)
    if (face === undefined) {
      face = shadowedFaceOf(entry.inject()) ?? null
      faces.set(entry, face)
    }
    return face ?? undefined
  }
  // A snapshot must keep its identity while nothing changed, so the parsed
  // notice is reused for as long as the shadowed source returns the same value.
  let lastRaw: unknown = null
  let last: WorkspaceNoticeState | null = null
  const notice: HostObservable<WorkspaceNoticeState | null> = {
    getSnapshot: () => {
      const raw = shadowed()?.toast.getSnapshot() ?? null
      if (raw !== lastRaw) {
        lastRaw = raw
        last = noticeOf(raw)
      }
      return last
    },
    subscribe: (listener) => {
      let current = shadowed()
      let release = current?.toast.subscribe(listener) ?? (() => {})
      const stopLedger = ledger.subscribe('shell.overlay', () => {
        const next = shadowed()
        if (next === current) return
        release()
        current = next
        release = current?.toast.subscribe(listener) ?? (() => {})
        listener()
      })
      return () => {
        stopLedger()
        release()
      }
    },
  }
  return {
    notice,
    dismiss: () => { shadowed()?.dismissToast() },
    undoArchive: (sessionId) => { shadowed()?.undoArchive(sessionId) },
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
