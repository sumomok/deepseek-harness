/**
 * The console's notices in place of `dsh-client-ui-workspace`'s.
 *
 * `ui-workspace` raises its notices through its `shell.overlay` entry
 * `workspace.row-toast`, which hands the notice on display to the keyed slot
 * `workspace.toast` under the notice's kind. The entry under that kind says
 * what the notice shows, and `ui-workspace`'s Toast Factory
 * `workspace.toast.content` draws it. Only a key's lowest-priority entry
 * renders (`SlotCore.register`'s shadowing rule), and `ui-workspace` registers
 * every kind at the default priority 0, so {@link replaceWorkspaceNotice}
 * registers the console's entries at {@link REPLACING_PRIORITY} under the
 * kinds the console words itself, and `ui-workspace`'s entries under those
 * kinds never mount.
 *
 * A page that could not prepare a place to hold conversations
 * (`defaultWorkspaceFailed`) shows 无法创建默认工作区，请通过“选择工作区”选择文件夹
 * from `ui-workspace`, which names the workspace and a picker the console
 * hides; a new conversation the Host refused (`createFailed`) shows 新建会话失败：
 * with the Host's reason. The console shows its own copy for both, without
 * the Host's reason. The `session.archive` keyboard shortcut archives the
 * conversation on screen, and its two outcomes (`archived`,
 * `stoppedAndArchived`) show 会话已归档 or 已停止并归档 from `ui-workspace`, with
 * an undo and a filter for archived rows this shell does not have. The
 * console shows its own copy with the undo alone, held for the same 6 s; the
 * undo takes the notice down and un-archives through `ctx.uiWorkspace`, and a
 * refused un-archive is reported to the browser console. The `session.fork`
 * shortcut's failure (`shortcutForkFailed`) shows 当前会话没有已结束的轮次 or
 * 无法分叉会话，请重试 from `ui-workspace`; the console shows nothing for it
 * ({@link WithheldNotice}), since a fork that succeeds shows nothing on the
 * console either: the new conversation is listed nowhere, and the page stays
 * on the conversation it was on. The console withholds both shortcuts' keys
 * (`console-shortcuts.ts`), so these three notices are raised only where those
 * commands still run: a Desktop shell's native accelerator.
 *
 * The other kinds keep `ui-workspace`'s entries because nothing raises them
 * here: `sessionIdCopied`, `sessionIdCopyFailed`, `pinFailed`, and
 * `unpinFailed` come from the row actions of `ui-workspace`'s
 * `sidebar.workspaces` browser, which this shell does not declare;
 * `forkRequiresOpen` comes only from that browser's fork row action; and
 * `archivedNotOpenable` comes from that browser and from `forkRequiresOpen`'s
 * own action.
 *
 * The kind names, the archive notices' `sessionId` field, and the Factory's
 * display fields are typed through `ui-workspace`'s declarations of
 * `workspace.toast` and `workspace.toast.content`, so a renamed kind or field
 * fails this package's typecheck. `ui-workspace` registering any kind below
 * the default priority would rank its own entry first;
 * `tests/workspace-notice.client.spec.tsx` pins the shadow against
 * `ui-workspace`'s own registrations.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/WorkspaceNotice
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  FactoryComponentPropsOf, InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls ui-workspace's ctx.uiWorkspace Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: ui-workspace declares `workspace.toast` and
// `workspace.toast.content` in its toast contract, which the declarations of
// its `/client` entry do not reach.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/src/client/contract/toast.ts'
import { REPLACING_PRIORITY } from './shadowed-overlay.ts'

/** Hold of the two archive notices, which carry an action to react to; `ui-workspace` holds its own for the same 6 s. */
const ARCHIVE_NOTICE_HOLD_MS = 6000

/** Dictionary namespace the notices read. */
const NS = 'serverSidebar'

/** What one notice shows: the Toast Factory's props without the occurrence's own number and dismissal. */
export type NoticeDisplay = Pick<FactoryComponentPropsOf<'workspace.toast.content'>, 'text' | 'tone' | 'holdMs' | 'actions'>

/** Runtime props of the notice dispatched under one or more kinds. */
type NoticeOf<K extends PropsRuntime<'workspace.toast'>['kind']> = PropsRuntime<'workspace.toast', K>

/** Business face of one console notice entry. */
export interface WorkspaceNoticeInjected<P> {
  /**
   * What the notice shows.
   * @param notice - the notice on display, as `ui-workspace` dispatches it.
   * @param t - this package's lookup.
   * @param dismiss - takes the notice down.
   * @returns the text, tone, hold, and actions the Toast Factory draws.
   */
  display: (notice: P, t: PropsLocale<'serverSidebar'>['t'], dismiss: () => void) => NoticeDisplay
}

/** Props of one console notice entry: the dispatched notice, this package's `t`, the Factory renderer, and the entry's face. */
export type WorkspaceNoticeProps<P extends PropsRuntime<'workspace.toast'>> =
  P & PropsLocale<'serverSidebar'> & PropsRenderFactories & InjectFace<WorkspaceNoticeInjected<P>>

/**
 * Draw the notice on display through `ui-workspace`'s Toast Factory.
 * @param props - see {@link WorkspaceNoticeProps}.
 * @returns the Toast; its `seq` restarts the hold for a repeated notice, and it calls `dismissToast` once it has faded.
 */
export function WorkspaceNotice<P extends PropsRuntime<'workspace.toast'>>(props: WorkspaceNoticeProps<P>) {
  const { dismissToast, display, t, renderFactorySlot, seq } = props
  return renderFactorySlot('workspace.toast.content', { ...display(props, t, dismissToast), seq, onDone: dismissToast })
}

/**
 * The entry of a notice the console does not show.
 * @returns nothing.
 */
export function WithheldNotice() {
  return null
}

/**
 * Register the console's notices over `ui-workspace`'s, once `ui-workspace`
 * declares `workspace.toast`.
 * @param ctx - client root context with `uiWorkspace` injected; its unload removes the entries.
 */
export function replaceWorkspaceNotice(ctx: ClientContext): void {
  const undo = (sessionId: SessionId): void => {
    ctx.uiWorkspace.unarchiveSession(sessionId).catch((reason: unknown) => {
      console.warn('server-sidebar: un-archive rejected:', reason)
    })
  }
  const archive = (key: 'notice.removed' | 'notice.stoppedAndRemoved'): WorkspaceNoticeInjected<NoticeOf<'archived' | 'stoppedAndArchived'>> => ({
    display: (notice, t, dismiss) => ({
      text: t(key), tone: 'success', holdMs: ARCHIVE_NOTICE_HOLD_MS,
      actions: [{ label: t('notice.undo'), onClick: () => { dismiss(); undo(notice.sessionId) } }],
    }),
  })
  ctx.effect(() => ctx.slots.inject('workspace.toast', function* () {
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'defaultWorkspaceFailed', priority: REPLACING_PRIORITY, locale: NS,
      inject: (): WorkspaceNoticeInjected<NoticeOf<'defaultWorkspaceFailed'>> => ({
        display: (_notice, t) => ({ text: t('notice.startFailed'), tone: 'warning' }),
      }),
    }, WorkspaceNotice<NoticeOf<'defaultWorkspaceFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'createFailed', priority: REPLACING_PRIORITY, locale: NS,
      inject: (): WorkspaceNoticeInjected<NoticeOf<'createFailed'>> => ({
        display: (_notice, t) => ({ text: t('notice.newFailed'), tone: 'warning' }),
      }),
    }, WorkspaceNotice<NoticeOf<'createFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'archived', priority: REPLACING_PRIORITY, locale: NS,
      inject: () => archive('notice.removed'),
    }, WorkspaceNotice<NoticeOf<'archived'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'stoppedAndArchived', priority: REPLACING_PRIORITY, locale: NS,
      inject: () => archive('notice.stoppedAndRemoved'),
    }, WorkspaceNotice<NoticeOf<'stoppedAndArchived'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'shortcutForkFailed', priority: REPLACING_PRIORITY,
    }, WithheldNotice)
  }), 'server-sidebar: the console\'s workspace notices')
}
