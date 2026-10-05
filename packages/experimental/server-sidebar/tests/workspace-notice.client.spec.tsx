// @vitest-environment jsdom
/**
 * `WorkspaceNotice`: the console's copy for the two `dsh-client-ui-workspace`
 * notices the console can raise, in both languages and free of the
 * vocabulary the console keeps off the screen; nothing for the kinds only the
 * session list's row actions raise; and the source that reads
 * `ui-workspace`'s notice through the entry this package shadows, whichever
 * of the two registers first.
 */
import { Context } from '@deepseek-ai/cordis'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
 * @returns the render result.
 */
function renderNotice(state: WorkspaceNoticeState | null, dictionary: typeof zh, dismissNotice = vi.fn()) {
  return render(
    <WorkspaceNotice
      useNotice={select => select(state)}
      dismissNotice={dismissNotice}
      t={lookup(dictionary)}
    />,
  )
}

/** `ui-workspace`'s notice store and the face its entry injects, as that package builds them. */
function ownerFace() {
  const toast = createSnapshotStore<{ kind: string; seq: number } | null>(null)
  const dismissToast = vi.fn(() => { toast.set(null) })
  return { toast, dismissToast, inject: () => ({ hooks: { toast }, dismissToast, undoArchive: vi.fn(), showArchived: vi.fn() }) }
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
  if (typeof hooks !== 'object' || hooks === null || !('notice' in hooks) || typeof dismissNotice !== 'function') {
    throw new Error('the console notice entry injects no notice face')
  }
  return {
    hooks: { notice: hooks.notice as HostObservable<WorkspaceNoticeState | null> },
    dismissNotice: dismissNotice as () => void,
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

  it('draws nothing while no notice is up, nor for the kinds only the session list\'s row actions raise', () => {
    for (const state of [null, ...['archived', 'stoppedAndArchived', 'pinFailed', 'unpinFailed', 'archivedNotOpenable'].map(kind => ({ kind, seq: 3 }))]) {
      renderNotice(state, zh)
      expect(screen.queryByRole('alert')).toBeNull()
      cleanup()
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
})

describe('shadowedNoticeSource', () => {
  it('shows nothing, and dismisses nothing, while `ui-workspace` has no entry', () => {
    const source = shadowedNoticeSource({ entries: () => [], subscribe: () => () => {} })
    expect(source.notice.getSnapshot()).toBeNull()
    expect(() => { source.dismiss() }).not.toThrow()
  })

  it('shows nothing for a face or a notice it does not recognise', () => {
    const faces = [
      { hooks: {}, dismissToast: () => {} },
      { hooks: { toast: { getSnapshot: () => null } }, dismissToast: () => {} },
      { hooks: { toast: createSnapshotStore(null) } },
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
      entries: () => [{ component: null, options: { id: 'workspace.row-toast' }, inject: () => ({ hooks: { toast }, dismissToast: () => {} }) }],
      subscribe: () => () => {},
    })
    expect(source.notice.getSnapshot()).toBeNull()
    toast.set({ kind: 'createFailed', seq: 2 })
    expect(source.notice.getSnapshot()).toEqual({ kind: 'createFailed', seq: 2 })
  })

  it('renders the notice through the console\'s entry end to end', async () => {
    const ctx = await overlayBench()
    const owner = ownerFace()
    ctx.slots.register({ name: 'shell.overlay', id: 'workspace.row-toast', inject: owner.inject } as never, () => null)
    replaceWorkspaceNotice(ctx)
    const { hooks: { notice }, dismissNotice } = consoleFace(ctx)
    function Seat() {
      const state = useSyncExternalStore(listener => notice.subscribe(listener), () => notice.getSnapshot())
      return <WorkspaceNotice useNotice={select => select(state)} dismissNotice={dismissNotice} t={lookup(zh)} />
    }
    render(<Seat />)
    expect(screen.queryByRole('alert')).toBeNull()
    act(() => { owner.toast.set({ kind: 'defaultWorkspaceFailed', seq: 1 }) })
    expect(screen.getByRole('alert').textContent).toBe(zh['notice.startFailed'])
  })
})
