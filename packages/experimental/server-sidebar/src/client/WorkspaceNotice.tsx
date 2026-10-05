/**
 * The console's notice in place of `dsh-client-ui-workspace`'s.
 *
 * `ui-workspace` raises its notices through one `shell.overlay` entry,
 * `workspace.row-toast`, and words the two the console can raise in the
 * vocabulary it keeps off the screen: a page that could not prepare a place to
 * hold conversations shows 无法创建默认工作区，请通过“选择工作区”选择文件夹,
 * which names the workspace and a picker the console hides, and a new
 * conversation the Host refused shows 新建会话失败： with the Host's own reason.
 * `shell.overlay` is a list slot whose cell is the entry id, and only a cell's
 * lowest-priority entry renders (`SlotCore.register`'s shadowing rule), so
 * {@link replaceWorkspaceNotice} registers {@link WorkspaceNotice} at priority
 * -1 under that id, and `ui-workspace`'s own toast never mounts.
 *
 * Which notice is up is still `ui-workspace`'s to say: the shadowed entry's
 * inject face carries it (`hooks.toast`, `dismissToast`), and nothing else
 * does. {@link shadowedNoticeSource} reads that face off the slot ledger,
 * follows the ledger so an entry registered after this one is still found, and
 * checks the face's members before using them, since the ledger erases their
 * types. The fields it reads (`kind`, `seq`) and the two kind names are literal
 * copies of `ui-workspace`'s `RowToast`, which exports no constant for them. A
 * renamed entry id un-shadows `ui-workspace`'s toast; a renamed kind, or a face
 * this module no longer recognises, shows no notice at all.
 *
 * The other kinds `ui-workspace` raises belong to the session list's row
 * actions (pin, archive, opening an archived row), which only its
 * `sidebar.workspaces` browser offers; this shell does not declare that slot,
 * so they never fire here, and this entry draws nothing for them.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/WorkspaceNotice
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls ui-layout's declaration of `shell.overlay`.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

/**
 * The id of `ui-workspace`'s notice entry in `shell.overlay`, which this
 * entry shadows. {@link replaceWorkspaceNotice} writes it out literally as
 * well, so the client slot catalog names the cell.
 */
const NOTICE_ENTRY_ID = 'workspace.row-toast'

/** Shadowing rank of the console's entry: below `ui-workspace`'s default 0. */
const REPLACING_PRIORITY = -1

/** Dictionary namespace the notice reads. */
const NS = 'serverSidebar'

/** One notice as `ui-workspace` publishes it: what happened, and a number that restarts a repeated notice's hold. */
export interface WorkspaceNoticeState {
  /** `ui-workspace`'s notice kind. */
  kind: string
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
}

/** The members of the shadowed entry's face this module reads. */
interface ShadowedFace {
  toast: HostObservable<unknown>
  dismissToast: () => void
}

/** Business face of the console's entry. */
export interface WorkspaceNoticeInjected {
  hooks: {
    /** The notice up now, or none. */
    notice: HostObservable<WorkspaceNoticeState | null>
  }
  /** Take the notice down. */
  dismissNotice: () => void
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
 * The members this module reads from the shadowed entry's face.
 * @param face - what the entry's inject factory returned.
 * @returns the toast source and its dismissal, or undefined when the face carries neither.
 */
function shadowedFaceOf(face: Record<string, unknown>): ShadowedFace | undefined {
  const { hooks, dismissToast } = face
  if (!isAction(dismissToast) || typeof hooks !== 'object' || hooks === null || !('toast' in hooks)) return undefined
  const { toast } = hooks
  if (!isObservable(toast)) return undefined
  return { toast, dismissToast }
}

/**
 * One published notice, read field by field.
 * @param value - the shadowed toast source's snapshot.
 * @returns the notice, or null when the snapshot carries none.
 */
function noticeOf(value: unknown): WorkspaceNoticeState | null {
  if (typeof value !== 'object' || value === null || !('kind' in value) || !('seq' in value)) return null
  const { kind, seq } = value
  return typeof kind === 'string' && typeof seq === 'number' ? { kind, seq } : null
}

/**
 * `ui-workspace`'s notice stream, read through the entry this module shadows.
 * @param ledger - the slot ledger the two entries are registered on.
 * @returns the notice source and its dismissal; both are inert while no
 * `ui-workspace` entry is registered.
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
  return { notice, dismiss: () => { shadowed()?.dismissToast() } }
}

/**
 * The console's copy for one notice kind.
 * @param kind - `ui-workspace`'s notice kind.
 * @param t - the locale seat.
 * @returns the sentence, or undefined for a kind this shell draws nothing for.
 */
function noticeText(kind: string, t: WorkspaceNoticeProps['t']): string | undefined {
  switch (kind) {
    case 'defaultWorkspaceFailed': return t('notice.startFailed')
    case 'createFailed': return t('notice.newFailed')
    // `ui-workspace`'s kinds are its own to extend; the rest come from row
    // actions this shell does not offer (see the module doc).
    default: return undefined
  }
}

/**
 * Render the notice up now, if this shell has copy for it.
 * @param props - see {@link WorkspaceNoticeProps}; only `useNotice`, `dismissNotice`, and `t` are read.
 * @returns the notice, or null.
 */
export function WorkspaceNotice({ useNotice, dismissNotice, t }: Pick<WorkspaceNoticeProps, 'useNotice' | 'dismissNotice' | 't'>) {
  const notice = useNotice(current => current)
  if (notice === null) return null
  const text = noticeText(notice.kind, t)
  if (text === undefined) return null
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
  const { notice, dismiss } = shadowedNoticeSource(ctx.slots)
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'workspace.row-toast',
    priority: REPLACING_PRIORITY,
    locale: NS,
    inject: (): WorkspaceNoticeInjected => ({ hooks: { notice }, dismissNotice: dismiss }),
  }, WorkspaceNotice)), 'server-sidebar: the console\'s workspace notice')
}
