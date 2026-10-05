// @vitest-environment jsdom
/**
 * `WorkspaceNotice`: the console's copy for the four `dsh-client-ui-workspace`
 * notices the console can raise, in both languages and free of the
 * vocabulary the console keeps off the screen, with the archive notices'
 * undo; nothing for the kinds only the session list's row actions raise; the
 * source that reads `ui-workspace`'s notice through the entry this package
 * shadows, whichever of the two registers first, until that entry leaves;
 * and the entry id, the face's members, and the notice's fields, checked
 * against `ui-workspace`'s own source.
 */
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import {
  replaceWorkspaceNotice, shadowedNoticeSource, WorkspaceNotice,
  type WorkspaceNoticeInjected, type WorkspaceNoticeProps, type WorkspaceNoticeState,
} from '../src/client/WorkspaceNotice.tsx'
import { en, zh } from '../src/client/locales.ts'

/** Words the console keeps off the screen, in either language. */
const BANNED = /工作区|会话|workspace|session/iu

/** The conversation the archive notices below name. */
const ARCHIVED = 'conversation-1' as SessionId

/**
 * A `t` over one dictionary.
 * @param dictionary - the locale table to read.
 * @returns the lookup the notice receives.
 */
function lookup(dictionary: typeof zh): WorkspaceNoticeProps['t'] {
  return key => (dictionary as Record<string, string>)[key] ?? key
}

/**
 * Render the notice over a fixed state.
 * @param state - the notice up, or none.
 * @param dictionary - the locale table.
 * @param dismissNotice - the dismissal the notice is handed.
 * @param undoArchive - the archive undo the notice is handed.
 * @returns the render result.
 */
function renderNotice(state: WorkspaceNoticeState | null, dictionary: typeof zh, dismissNotice = vi.fn(), undoArchive = vi.fn()) {
  return render(
    <WorkspaceNotice
      useNotice={select => select(state)}
      dismissNotice={dismissNotice}
      undoArchive={undoArchive}
      t={lookup(dictionary)}
    />,
  )
}

/** `ui-workspace`'s notice store and the face its entry injects, as that package builds them. */
function ownerFace() {
  const toast = createSnapshotStore<{ kind: string; seq: number; sessionId?: string } | null>(null)
  const dismissToast = vi.fn(() => { toast.set(null) })
  const undoArchive = vi.fn()
  return { toast, dismissToast, undoArchive, inject: () => ({ hooks: { toast }, dismissToast, undoArchive, showArchived: vi.fn() }) }
}

/** A root context with the slot registry and `shell.overlay` declared, as the shell declares it. */
async function overlayBench(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({ name: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' } } } as never, () => null)
  return ctx
}

/**
 * The console entry's inject face.
 * @param ctx - the bench context.
 * @returns the face this package's entry hands its component.
 */
function consoleFace(ctx: Context): WorkspaceNoticeInjected {
  const ours = ctx.slots.entries('shell.overlay').find(entry => entry.component === WorkspaceNotice)
  const face = ours?.inject?.()
  const hooks = face?.['hooks']
  const dismissNotice = face?.['dismissNotice']
  const undoArchive = face?.['undoArchive']
  if (typeof hooks !== 'object' || hooks === null || !('notice' in hooks)
    || typeof dismissNotice !== 'function' || typeof undoArchive !== 'function') {
    throw new Error('the console notice entry injects no notice face')
  }
  return {
    hooks: { notice: hooks.notice as HostObservable<WorkspaceNoticeState | null> },
    dismissNotice: dismissNotice as () => void,
    undoArchive: undoArchive as (sessionId: SessionId) => void,
  }
}

afterEach(() => {
  cleanup()
})

describe('WorkspaceNotice', () => {
  it('says a conversation could not be started and that a refresh tries again, in place of the default-workspace notice', () => {
    renderNotice({ kind: 'defaultWorkspaceFailed', seq: 1 }, zh)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('暂时无法开始对话，请刷新页面后重试')
    expect(alert.textContent).not.toMatch(BANNED)
  })

  it('reads in English under the English dictionary', () => {
    renderNotice({ kind: 'defaultWorkspaceFailed', seq: 1 }, en)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('Couldn’t start a conversation. Refresh the page to try again.')
    expect(alert.textContent).not.toMatch(BANNED)
  })

  it('says a new conversation could not be started, without the Host\'s reason, in place of the refused-creation notice', () => {
    for (const dictionary of [zh, en]) {
      renderNotice({ kind: 'createFailed', seq: 2 }, dictionary)
      expect(screen.getByRole('alert').textContent).toBe(dictionary['notice.newFailed'])
      expect(dictionary['notice.newFailed']).not.toMatch(BANNED)
      cleanup()
    }
  })

  it('says the conversation the archive shortcut archived left the list, with an undo, in place of the archived notices', () => {
    for (const dictionary of [zh, en]) {
      for (const [kind, key] of [['archived', 'notice.removed'], ['stoppedAndArchived', 'notice.stoppedAndRemoved']] as const) {
        renderNotice({ kind, sessionId: ARCHIVED, seq: 4 }, dictionary)
        const alert = screen.getByRole('alert')
        expect(alert.textContent).toBe(`${dictionary[key]}${dictionary['notice.undo']}`)
        expect(alert.textContent).not.toMatch(BANNED)
        expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([dictionary['notice.undo']])
        cleanup()
      }
    }
    expect(`${zh['notice.removed']}${zh['notice.undo']}`).toBe('对话已移出列表，可撤销')
    expect(`${en['notice.stoppedAndRemoved']}${en['notice.undo']}`).toBe('Stopped and removed from the list. You can undo')
  })

  it('takes the archive notice down and un-archives the conversation it names on undo', () => {
    const dismissNotice = vi.fn()
    const undoArchive = vi.fn()
    renderNotice({ kind: 'archived', sessionId: ARCHIVED, seq: 5 }, zh, dismissNotice, undoArchive)
    fireEvent.click(screen.getByRole('button', { name: zh['notice.undo'] }))
    expect(dismissNotice).toHaveBeenCalledOnce()
    expect(undoArchive).toHaveBeenCalledExactlyOnceWith(ARCHIVED)
  })

  it('holds an archive notice for 6 s and a failure notice for the default 3 s before each fades', () => {
    vi.useFakeTimers()
    try {
      for (const [state, heldMs] of [
        [{ kind: 'archived', sessionId: ARCHIVED, seq: 6 }, 6000],
        [{ kind: 'createFailed', seq: 7 }, 3000],
      ] as const) {
        const dismissNotice = vi.fn()
        renderNotice(state, zh, dismissNotice)
        // The toast reports done once its 1 s fade after the hold has run.
        act(() => { vi.advanceTimersByTime(heldMs + 999) })
        expect(dismissNotice).not.toHaveBeenCalled()
        act(() => { vi.advanceTimersByTime(1) })
        expect(dismissNotice).toHaveBeenCalledOnce()
        cleanup()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('draws nothing while no notice is up, nor for the kinds only the session list\'s row actions raise', () => {
    renderNotice(null, zh)
    expect(screen.queryByRole('alert')).toBeNull()
    cleanup()
    const owner = ownerFace()
    const source = shadowedNoticeSource({
      entries: () => [{ component: null, options: { id: 'workspace.row-toast' }, inject: owner.inject }],
      subscribe: () => () => {},
    })
    for (const kind of ['pinFailed', 'unpinFailed', 'archivedNotOpenable']) {
      owner.toast.set({ kind, seq: 3 })
      expect({ kind, notice: source.notice.getSnapshot() }).toEqual({ kind, notice: null })
    }
  })

  it('hands the dismissal to the toast, which calls it once the notice has faded', () => {
    vi.useFakeTimers()
    try {
      const dismissNotice = vi.fn()
      renderNotice({ kind: 'defaultWorkspaceFailed', seq: 1 }, zh, dismissNotice)
      act(() => { vi.advanceTimersByTime(4000) })
      expect(dismissNotice).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('replaceWorkspaceNotice', () => {
  it('shadows `ui-workspace`\'s notice entry at priority -1, in this package\'s locale', async () => {
    const ctx = await overlayBench()
    replaceWorkspaceNotice(ctx)
    const owner = ownerFace()
    ctx.slots.register({ name: 'shell.overlay', id: 'workspace.row-toast', inject: owner.inject } as never, () => null)
    const [winner, ...others] = ctx.slots.entriesOfSlot('shell.overlay')
    expect(others).toEqual([])
    expect(winner?.component).toBe(WorkspaceNotice)
    expect(winner?.options).toMatchObject({ id: 'workspace.row-toast', priority: -1 })
    expect(winner?.locale).toBe('serverSidebar')
  })

  it('shows `ui-workspace`\'s notice and dismisses it through that package, whichever entry registers first', async () => {
    for (const ownerFirst of [true, false]) {
      const ctx = await overlayBench()
      const owner = ownerFace()
      const registerOwner = () => ctx.slots.register({ name: 'shell.overlay', id: 'workspace.row-toast', inject: owner.inject } as never, () => null)
      if (ownerFirst) registerOwner()
      replaceWorkspaceNotice(ctx)
      const { hooks: { notice }, dismissNotice } = consoleFace(ctx)
      const seen: (WorkspaceNoticeState | null)[] = []
      const stop = notice.subscribe(() => { seen.push(notice.getSnapshot()) })
      if (!ownerFirst) {
        registerOwner()
        // The ledger reports a registration on a microtask; the source then
        // follows the new entry and tells its listener to read again.
        await new Promise((resolve) => { setTimeout(resolve, 0) })
        expect(seen).toEqual([null])
      }
      expect(notice.getSnapshot()).toBeNull()
      owner.toast.set({ kind: 'defaultWorkspaceFailed', seq: 1 })
      expect(notice.getSnapshot()).toEqual({ kind: 'defaultWorkspaceFailed', seq: 1 })
      // The same published value keeps one snapshot identity.
      expect(notice.getSnapshot()).toBe(notice.getSnapshot())
      expect(seen.at(-1)).toEqual({ kind: 'defaultWorkspaceFailed', seq: 1 })
      dismissNotice()
      expect(owner.dismissToast).toHaveBeenCalledOnce()
      expect(notice.getSnapshot()).toBeNull()
      stop()
    }
  })

  it('stops showing `ui-workspace`\'s notice once its entry leaves the ledger', async () => {
    const ctx = await overlayBench()
    const owner = ownerFace()
    const disposeOwner = ctx.slots.register({ name: 'shell.overlay', id: 'workspace.row-toast', inject: owner.inject } as never, () => null)
    replaceWorkspaceNotice(ctx)
    const { hooks: { notice } } = consoleFace(ctx)
    const listener = vi.fn()
    const stop = notice.subscribe(listener)
    owner.toast.set({ kind: 'createFailed', seq: 1 })
    expect(listener).toHaveBeenCalledOnce()
    expect(notice.getSnapshot()).toEqual({ kind: 'createFailed', seq: 1 })
    disposeOwner()
    // The ledger reports the removal on a microtask.
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(notice.getSnapshot()).toBeNull()
    owner.toast.set({ kind: 'createFailed', seq: 2 })
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
  })
})

describe('shadowedNoticeSource', () => {
  it('shows nothing, and dismisses nothing, while `ui-workspace` has no entry', () => {
    const source = shadowedNoticeSource({ entries: () => [], subscribe: () => () => {} })
    expect(source.notice.getSnapshot()).toBeNull()
    expect(() => { source.dismiss() }).not.toThrow()
  })

  it('shows nothing for a face or a notice it does not recognise', () => {
    const live = createSnapshotStore<object>({ kind: 'createFailed', seq: 1 })
    const faces = [
      { hooks: {}, dismissToast: () => {}, undoArchive: () => {} },
      { hooks: { toast: { getSnapshot: () => null } }, dismissToast: () => {}, undoArchive: () => {} },
      { hooks: { toast: live }, undoArchive: () => {} },
      { hooks: { toast: live }, dismissToast: () => {} },
    ]
    for (const face of faces) {
      const source = shadowedNoticeSource({
        entries: () => [{ component: null, options: { id: 'workspace.row-toast' }, inject: () => face }],
        subscribe: () => () => {},
      })
      expect(source.notice.getSnapshot()).toBeNull()
    }
    const toast = createSnapshotStore<object>({ kind: 7, seq: 1 })
    const source = shadowedNoticeSource({
      entries: () => [{ component: null, options: { id: 'workspace.row-toast' }, inject: () => ({ hooks: { toast }, dismissToast: () => {}, undoArchive: () => {} }) }],
      subscribe: () => () => {},
    })
    expect(source.notice.getSnapshot()).toBeNull()
    // An archive notice that names no conversation has no undo to offer.
    toast.set({ kind: 'archived', seq: 2 })
    expect(source.notice.getSnapshot()).toBeNull()
    toast.set({ kind: 'createFailed', seq: '3' })
    expect(source.notice.getSnapshot()).toBeNull()
    toast.set({ kind: 'createFailed', seq: 4 })
    expect(source.notice.getSnapshot()).toEqual({ kind: 'createFailed', seq: 4 })
  })

  it('hands an archive notice on with the conversation it names, and routes its undo to `ui-workspace`', () => {
    const owner = ownerFace()
    const source = shadowedNoticeSource({
      entries: () => [{ component: null, options: { id: 'workspace.row-toast' }, inject: owner.inject }],
      subscribe: () => () => {},
    })
    owner.toast.set({ kind: 'stoppedAndArchived', sessionId: ARCHIVED, seq: 8 })
    expect(source.notice.getSnapshot()).toEqual({ kind: 'stoppedAndArchived', sessionId: ARCHIVED, seq: 8 })
    source.undoArchive(ARCHIVED)
    expect(owner.undoArchive).toHaveBeenCalledExactlyOnceWith(ARCHIVED)
  })

  it('undoes nothing while `ui-workspace` has no entry', () => {
    const source = shadowedNoticeSource({ entries: () => [], subscribe: () => () => {} })
    expect(() => { source.undoArchive(ARCHIVED) }).not.toThrow()
  })

  it('renders the notice through the console\'s entry end to end', async () => {
    const ctx = await overlayBench()
    const owner = ownerFace()
    ctx.slots.register({ name: 'shell.overlay', id: 'workspace.row-toast', inject: owner.inject } as never, () => null)
    replaceWorkspaceNotice(ctx)
    const { hooks: { notice }, dismissNotice, undoArchive } = consoleFace(ctx)
    function Seat() {
      const state = useSyncExternalStore(listener => notice.subscribe(listener), () => notice.getSnapshot())
      return <WorkspaceNotice useNotice={select => select(state)} dismissNotice={dismissNotice} undoArchive={undoArchive} t={lookup(zh)} />
    }
    render(<Seat />)
    expect(screen.queryByRole('alert')).toBeNull()
    act(() => { owner.toast.set({ kind: 'defaultWorkspaceFailed', seq: 1 }) })
    expect(screen.getByRole('alert').textContent).toBe(zh['notice.startFailed'])
    act(() => { owner.toast.set({ kind: 'archived', sessionId: ARCHIVED, seq: 2 }) })
    expect(screen.getByRole('alert').textContent).toBe(`${zh['notice.removed']}${zh['notice.undo']}`)
    act(() => { fireEvent.click(screen.getByRole('button', { name: zh['notice.undo'] })) })
    expect(owner.dismissToast).toHaveBeenCalledOnce()
    expect(owner.undoArchive).toHaveBeenCalledExactlyOnceWith(ARCHIVED)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the shadowed entry', () => {
  /** `ui-workspace`'s client source directory. */
  const owner = resolvePath(import.meta.dirname, '../../../client/ui-workspace/src/client')

  it('is the id `ui-workspace` registers its notice under in `shell.overlay`', () => {
    // A literal copy: `ui-workspace` exports no constant for the id, and a
    // renamed id there would bring its own toast back beside this one.
    expect(readFileSync(resolvePath(owner, 'index.ts'), 'utf8'))
      .toMatch(/name: 'shell\.overlay', id: 'workspace\.row-toast',[^}]*\}, RowActionToast\)/u)
  })

  it('carries the face members and notice fields `ui-workspace` declares for its toast', () => {
    // Literal copies: the `/client` entry exports neither `RowToastInjected`
    // nor `RowToastState`, and a renamed member there leaves this entry with
    // no notice to show.
    const contract = readFileSync(resolvePath(owner, 'contract/slots.ts'), 'utf8')
    const face = /^export interface RowToastInjected \{\n([\s\S]*?)^\}$/mu.exec(contract)?.[1]
    expect(face).toMatch(/^ {2}hooks: \{\n(?: {4}.*\n)* {4}toast: HostObservable<RowToastState \| null>\n {2}\}$/mu)
    expect(face).toMatch(/^ {2}dismissToast: \(\) => void$/mu)
    expect(face).toMatch(/^ {2}undoArchive: \(sessionId: SessionId\) => void$/mu)
    expect(contract).toMatch(/^export type RowToastState = RowToast & \{ seq: number \}$/mu)
    // The kinds this entry draws, and the archive kinds' conversation field,
    // which the compiler checks as well.
    const kinds = /^export type RowToast =\n([\s\S]*?)\n\n/mu.exec(contract)?.[1]
    for (const kind of ['defaultWorkspaceFailed', 'createFailed']) expect(kinds).toContain(`| { kind: '${kind}'`)
    for (const kind of ['archived', 'stoppedAndArchived']) expect(kinds).toContain(`| { kind: '${kind}'; sessionId: SessionId }`)
  })
})
