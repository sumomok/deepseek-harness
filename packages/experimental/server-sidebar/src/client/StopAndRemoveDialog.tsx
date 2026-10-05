/**
 * The console's stop-and-remove confirmation in place of
 * `dsh-client-ui-workspace`'s stop-and-archive dialog.
 *
 * `ui-workspace`'s `session.archive` keyboard shortcut archives the
 * conversation on screen. When the Host refuses because work still runs in
 * it, `ui-workspace` asks first through its `shell.overlay` entry
 * `workspace.session-archive`: 停止并归档此会话？ over the conversation's display
 * title, which falls back to a directory name or a bare id; a list that calls
 * a running turn 进行中的回合 and names any family its dictionary does not
 * know by its key; the advice to restore the conversation from the sidebar's
 * 全部对话（显示已归档） filter, which this shell does not have; and, for a
 * refused stop, the Host's own reason. {@link replaceArchiveConfirm} registers
 * {@link StopAndRemoveDialog} under that id below `ui-workspace`'s priority
 * (`shadowed-overlay.ts`), so `ui-workspace`'s dialog never mounts.
 *
 * The console's dialog asks 停止并移出列表？ about the conversation on screen,
 * the only one the shortcut acts on, without naming it, and lists the work it
 * would stop in this package's dictionary. A refusal shows fixed copy, and the
 * Host's reason goes to the browser console. The answer stays
 * `ui-workspace`'s: confirming calls the shadowed face's
 * `stopAndArchiveSession` and, once that resolves, `settleSessionArchive`;
 * cancelling or closing calls `settleSessionArchive`. The notice the stop
 * raises is this package's (`WorkspaceNotice.tsx`), with its undo.
 *
 * The activity's `kind`, `items`, `id`, and `label` fields are checked against
 * the exported `SessionActivity` types at compile time ({@link FieldsOf}). The
 * entry id, the face's members (`hooks.archiveRequest`,
 * `settleSessionArchive`, `stopAndArchiveSession`), the request's `sessionId`
 * and `activity` fields, and the four families `ui-workspace` words (`turn`,
 * `subagent`, `job`, `schedule`) are literal copies: `ui-workspace`'s
 * `/client` entry exports no constant for the id and neither the face's type
 * nor the request's, and each family is a key its provider merges into
 * `SessionActivityKindMap`. `tests/stop-and-remove-dialog.client.spec.tsx`
 * checks each copy against the owning source. A renamed entry id un-shadows
 * `ui-workspace`'s dialog; a face or a request this module does not recognise
 * shows no dialog, and nothing is stopped. An unreadable request is reported
 * once to the browser console.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/StopAndRemoveDialog
 */
import { useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionActivity, SessionActivityItem } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls ui-layout's declaration of `shell.overlay`.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import {
  followShadowed, hookOf, isAction, isSessionAction, type OverlayLedger, REPLACING_PRIORITY, shadowedFace,
} from './shadowed-overlay.ts'
import css from './StopAndRemoveDialog.module.css'

/**
 * The id of `ui-workspace`'s confirmation entry in `shell.overlay`, which
 * this entry shadows. {@link replaceArchiveConfirm} writes it out literally as
 * well, so the client slot catalog names the cell.
 */
const CONFIRM_ENTRY_ID = 'workspace.session-archive'

/** Dictionary namespace the dialog reads. */
const NS = 'serverSidebar'

/**
 * A record read by the fields an exported type names, each of unknown value:
 * a field the owner renames fails this package's typecheck where it is read.
 */
type FieldsOf<T> = { readonly [K in keyof T]?: unknown }

/** One family of work the dialog lists. */
export interface StopActivity {
  /** The family's key, as its provider merged it into `SessionActivityKindMap`. */
  kind: string
  /** Each running item's label, or its id when it carries none; empty for a family without items. */
  names: readonly string[]
}

/** A confirmation `ui-workspace` asked for, as this dialog draws it. */
export interface StopRequest {
  /** The conversation the shortcut tried to archive. */
  sessionId: SessionId
  /** What the Host reported running there, in the Host's order. */
  activity: readonly StopActivity[]
}

/** `ui-workspace`'s confirmation, as {@link shadowedStopRequest} hands it on. */
export interface ShadowedStopRequest {
  /** The confirmation asked for, or none. */
  request: HostObservable<StopRequest | null>
  /** Consume or cancel the pending confirmation. */
  settle: () => void
  /**
   * Stop the conversation's running work and archive it, through `ui-workspace`.
   * @param sessionId - the conversation the request names.
   * @returns settles once `ui-workspace`'s archive does.
   */
  stopAndRemove: (sessionId: SessionId) => Promise<void>
}

/** The members of the shadowed entry's face this module reads. */
interface ShadowedFace {
  archiveRequest: HostObservable<unknown>
  settleSessionArchive: () => unknown
  stopAndArchiveSession: (sessionId: SessionId) => unknown
}

/** Business face of the console's entry. */
export interface StopAndRemoveInjected {
  hooks: {
    /** The confirmation asked for, or none. */
    stopRequest: HostObservable<StopRequest | null>
  }
  /** Consume or cancel the pending confirmation. */
  settleStopRequest: () => void
  /**
   * Stop the conversation's running work and take it off the list.
   * @param sessionId - the conversation the request names.
   * @returns settles once the archive does; rejects with the Host's refusal.
   */
  stopAndRemove: (sessionId: SessionId) => Promise<void>
}

/** Props of the console's confirmation entry. */
export type StopAndRemoveDialogProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'serverSidebar'>
  & InjectFace<StopAndRemoveInjected>

/**
 * The members this module reads from the shadowed entry's face.
 * @param face - what the entry's inject factory returned.
 * @returns the request source, its settlement, and the stop-and-archive hop, or undefined when the face lacks any of them.
 */
function shadowedFaceOf(face: Record<string, unknown>): ShadowedFace | undefined {
  const archiveRequest = hookOf(face, 'archiveRequest')
  const { settleSessionArchive, stopAndArchiveSession } = face
  if (archiveRequest === undefined || !isAction(settleSessionArchive) || !isSessionAction(stopAndArchiveSession)) return undefined
  return { archiveRequest, settleSessionArchive, stopAndArchiveSession }
}

/**
 * One running item's name.
 * @param value - one entry of a family's `items`.
 * @returns its label, or its id when it carries no label; undefined when it carries no id.
 */
function itemName(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { id, label }: FieldsOf<SessionActivityItem> = value
  if (typeof id !== 'string') return undefined
  return typeof label === 'string' ? label : id
}

/**
 * One family of the request's work.
 * @param value - one entry of the request's `activity`.
 * @returns the family, or undefined when it or one of its items is unreadable.
 */
function activityOf(value: unknown): StopActivity | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { kind, items = [] }: FieldsOf<SessionActivity> = value
  if (typeof kind !== 'string' || !Array.isArray(items)) return undefined
  const entries: readonly unknown[] = items
  const names: string[] = []
  for (const entry of entries) {
    const name = itemName(entry)
    if (name === undefined) return undefined
    names.push(name)
  }
  return { kind, names }
}

/**
 * One published confirmation, read field by field.
 * @param value - a non-null snapshot of the shadowed request source.
 * @returns the request, or null when any part of it is unreadable.
 */
function readStopRequest(value: unknown): StopRequest | null {
  if (typeof value !== 'object' || value === null || !('sessionId' in value) || !('activity' in value)) return null
  const { sessionId, activity } = value
  if (typeof sessionId !== 'string' || !Array.isArray(activity)) return null
  const entries: readonly unknown[] = activity
  const families: StopActivity[] = []
  for (const entry of entries) {
    const family = activityOf(entry)
    if (family === undefined) return null
    families.push(family)
  }
  return { sessionId: sessionId as SessionId, activity: families }
}

/**
 * One published confirmation, or none. An unreadable one leaves
 * `ui-workspace`'s request pending, stops nothing, and is reported once to the
 * browser console without its content.
 * @param value - the shadowed request source's snapshot.
 * @returns the request, or null when there is none or it is unreadable: the
 * dialog does not ask to stop work it cannot list.
 */
function stopRequestOf(value: unknown): StopRequest | null {
  if (value === null) return null
  const request = readStopRequest(value)
  if (request === null) console.warn('server-sidebar: ignored a stop-and-archive confirmation this console cannot read; nothing was stopped')
  return request
}

/**
 * `ui-workspace`'s pending confirmation, read through the entry this module shadows.
 * @param ledger - the slot ledger the two entries are registered on.
 * @returns the request source, its settlement, and the stop-and-archive hop;
 * all three are inert while no `ui-workspace` entry is registered.
 */
export function shadowedStopRequest(ledger: OverlayLedger): ShadowedStopRequest {
  const face = shadowedFace(ledger, CONFIRM_ENTRY_ID, StopAndRemoveDialog, shadowedFaceOf)
  return {
    request: followShadowed(ledger, face, current => current.archiveRequest, stopRequestOf),
    settle: () => { face()?.settleSessionArchive() },
    stopAndRemove: async (sessionId) => { await face()?.stopAndArchiveSession(sessionId) },
  }
}

/**
 * One family's line: its count and its items' names. A family this
 * dictionary does not word takes the generic line, without its key.
 * @param activity - the family.
 * @param t - the dialog's lookup.
 * @returns the line.
 */
function activityLine(activity: StopActivity, t: StopAndRemoveDialogProps['t']): string {
  const n = activity.names.length
  const names = activity.names.join(t('stopRemove.listSeparator'))
  const plural = n === 1 ? 'one' : 'other'
  switch (activity.kind) {
    case 'turn': return t('stopRemove.turn')
    case 'subagent': return t(`stopRemove.subagents.${plural}`, { n, names })
    case 'job': return t(`stopRemove.jobs.${plural}`, { n, names })
    case 'schedule': return t(`stopRemove.schedules.${plural}`, { n, names })
    // `SessionActivityKindMap` is each provider's to extend.
    default: return t(`stopRemove.other.${plural}`, { n })
  }
}

/** Props of one request's dialog. */
interface StopAndRemoveFormProps {
  /** The request the dialog answers. */
  request: StopRequest
  /** The stop-and-remove hop. */
  stopAndRemove: StopAndRemoveInjected['stopAndRemove']
  /** Consume or cancel the request. */
  onSettle: () => void
  /** The dialog's lookup. */
  t: StopAndRemoveDialogProps['t']
}

/**
 * One request's dialog; its in-flight and failure state end with it.
 * @param props - see {@link StopAndRemoveFormProps}.
 * @returns the dialog.
 */
function StopAndRemoveForm({ request, stopAndRemove, onSettle, t }: StopAndRemoveFormProps) {
  const [stopping, setStopping] = useState(false)
  const [failed, setFailed] = useState(false)
  const close = () => {
    if (stopping) return
    onSettle()
  }
  const confirm = () => {
    setStopping(true)
    setFailed(false)
    stopAndRemove(request.sessionId).then(() => {
      setStopping(false)
      onSettle()
    }).catch((reason: unknown) => {
      // The refusal is the Host's own text, in the vocabulary this console
      // keeps off the screen; the dialog says only that it did not go through.
      console.warn('server-sidebar: could not stop this conversation\'s work and take it off the list:', reason)
      setStopping(false)
      setFailed(true)
    })
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('stopRemove.close')}
      title={t('stopRemove.title')}
      description={t('stopRemove.desc')}
      footer={(
        <>
          <Button variant="outline" disabled={stopping} onClick={close}>{t('stopRemove.cancel')}</Button>
          <Button variant="outline" className={css.stopAction} disabled={stopping} onClick={confirm}>
            {t('stopRemove.action')}
          </Button>
        </>
      )}
    >
      <ul className={css.activity} aria-label={t('stopRemove.activity')}>
        {request.activity.map((entry, index) => (
          <li key={`${entry.kind}-${String(index)}`}>{activityLine(entry, t)}</li>
        ))}
      </ul>
      {stopping && <div className={css.status} role="status">{t('stopRemove.pending')}</div>}
      {failed && <div className={css.error} role="alert">{t('stopRemove.error')}</div>}
    </Modal>
  )
}

/**
 * Render the pending confirmation, one dialog per request.
 * @param props - see {@link StopAndRemoveDialogProps}; only `useStopRequest`, `settleStopRequest`, `stopAndRemove`, and `t` are read.
 * @returns the dialog, or null.
 */
export function StopAndRemoveDialog({
  useStopRequest, settleStopRequest, stopAndRemove, t,
}: Pick<StopAndRemoveDialogProps, 'useStopRequest' | 'settleStopRequest' | 'stopAndRemove' | 't'>) {
  const request = useStopRequest(pending => pending)
  if (request === null) return null
  return (
    <StopAndRemoveForm
      key={request.sessionId}
      request={request}
      stopAndRemove={stopAndRemove}
      onSettle={settleStopRequest}
      t={t}
    />
  )
}

/**
 * Shadow `ui-workspace`'s stop-and-archive confirmation, once the shell declares `shell.overlay`.
 * @param ctx - client root context; its unload removes the entry.
 */
export function replaceArchiveConfirm(ctx: ClientContext): void {
  const { request, settle, stopAndRemove } = shadowedStopRequest(ctx.slots)
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'workspace.session-archive',
    priority: REPLACING_PRIORITY,
    locale: NS,
    inject: (): StopAndRemoveInjected => ({ hooks: { stopRequest: request }, settleStopRequest: settle, stopAndRemove }),
  }, StopAndRemoveDialog)), 'server-sidebar: the console\'s stop-and-remove confirmation')
}
