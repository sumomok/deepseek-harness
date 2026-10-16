// @vitest-environment jsdom
/**
 * `WorkspaceNotice`: the console's notices, mounted with
 * `dsh-client-ui-workspace`'s own notice entry, keyed notice registrations,
 * and Toast Factory. The console's copy for a default-workspace failure, a
 * refused new conversation, and the two archive notices, in both languages
 * and free of the vocabulary the console keeps off the screen, whichever of
 * the two packages registers first; the archive notices' undo through
 * `uiWorkspace` without `ui-workspace`'s archived-rows filter; each notice's
 * hold; nothing for a failed fork shortcut; `ui-workspace`'s own notice for
 * the kinds nothing on the console raises; and `ui-workspace`'s notices again
 * once the console's plugin unloads.
 */
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { RowToast } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { en as workspaceEn, zh as workspaceZh } from '@deepseek-ai/dsh-client-ui-workspace/src/client/locales.ts'
import { RowActionToast } from '@deepseek-ai/dsh-client-ui-workspace/src/client/session-actions/RowActionToast.tsx'
import { createWorkspaceViewStore } from '@deepseek-ai/dsh-client-ui-workspace/src/client/stores.ts'
import { registerToasts } from '@deepseek-ai/dsh-client-ui-workspace/src/client/toast/register.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { replaceWorkspaceNotice } from '../src/client/WorkspaceNotice.tsx'
import { en, zh } from '../src/client/locales.ts'

/** Words the console keeps off the screen, in either language. */
const BANNED = /工作区|会话|归档|workspace|session|archive/iu

/** The conversation the archive notices below name. */
const ARCHIVED = 'conversation-1' as SessionId

/** Both languages, with the console's and `ui-workspace`'s dictionaries for each. */
const LANGUAGES = [
  { language: 'zh', dictionary: zh, workspace: workspaceZh },
  { language: 'en', dictionary: en, workspace: workspaceEn },
] as const

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** The page frame: `shell.overlay` rendered at the root, as the shell renders it. */
function OverlayFrame({ renderSlot }: PropsRenderSlots<'shell.overlay'>) {
  return renderSlot('shell.overlay', {})
}

/** How {@link noticeSurface} composes the page. */
interface SurfaceOptions {
  /** The page language. */
  language?: 'zh' | 'en'
  /** Whether the console's plugin loads before `ui-workspace` registers its notices. */
  consoleFirst?: boolean
}

/**
 * `ui-workspace`'s notice surface with the console's notices composed over it.
 * @param options - see {@link SurfaceOptions}.
 * @returns a way to raise a notice, the dismissal and un-archive spies,
 * `ui-workspace`'s own toast actions, and the console plugin's handle.
 */
async function noticeSurface({ language = 'zh', consoleFirst = false }: SurfaceOptions = {}) {
  const toast = createSnapshotStore<(RowToast & { seq: number }) | null>(null)
  const dismissToast = vi.fn(() => { toast.set(null) })
  const unarchiveSession = vi.fn((_sessionId: SessionId) => Promise.resolve())
  const owner = { undoArchive: vi.fn(), showArchived: vi.fn(), openForkSource: vi.fn() }
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale(language)
  locale.register('workspace', { en: workspaceEn, zh: workspaceZh })
  locale.register('serverSidebar', { en, zh })
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.ctx.provide('uiWorkspace', { unarchiveSession } as never)
  await runtime.root.declare({ 'shell.overlay': { kind: 'list', scope: 'root' } }, OverlayFrame)
  const mountConsole = () => runtime.mount({ inject: ['slots', 'uiWorkspace'], apply: replaceWorkspaceNotice })
  const early = consoleFirst ? await mountConsole() : undefined
  await act(async () => {
    registerToasts(runtime.ctx, createWorkspaceViewStore(), owner)
    runtime.slots.register({
      name: 'shell.overlay', id: 'workspace.row-toast',
      children: { 'workspace.toast': { kind: 'keyed', scope: 'root' } },
      inject: () => ({ hooks: { toast }, dismissToast }),
    }, RowActionToast)
  })
  const consolePlugin = early ?? await mountConsole()
  runtime.renderRoot()
  let seq = 0
  const notify = (notice: RowToast): void => {
    act(() => { toast.set({ ...notice, seq: ++seq }) })
  }
  return { notify, dismissToast, unarchiveSession, owner, consolePlugin }
}

describe('the console\'s workspace notices', () => {
  it('say a conversation could not be started, with a warning mark, whichever package registers first', async () => {
    for (const consoleFirst of [false, true]) {
      const { notify } = await noticeSurface({ consoleFirst })
      notify({ kind: 'defaultWorkspaceFailed' })
      const alert = screen.getByRole('alert')
      expect({ consoleFirst, text: alert.textContent }).toEqual({ consoleFirst, text: '暂时无法开始对话，请刷新页面后重试' })
      expect(alert.querySelector('svg')).not.toBeNull()
      expect(alert.querySelector('button')).toBeNull()
      cleanup()
    }
  })

  it.each(LANGUAGES)('say a new conversation could not be started, without the Host\'s reason, in $language', async ({ language, dictionary }) => {
    const { notify } = await noticeSurface({ language })
    notify({ kind: 'createFailed', message: 'workspace/refused: no new session' })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe(dictionary['notice.newFailed'])
    expect(alert.textContent).not.toMatch(BANNED)
    expect(alert.querySelector('svg')).not.toBeNull()
    notify({ kind: 'defaultWorkspaceFailed' })
    expect(screen.getByRole('alert').textContent).toBe(dictionary['notice.startFailed'])
    expect(dictionary['notice.startFailed']).not.toMatch(BANNED)
  })

  it.each(LANGUAGES)('say the conversation the archive shortcut archived left the list, with an undo and no filter, in $language', async ({ language, dictionary, workspace }) => {
    const { notify } = await noticeSurface({ language })
    for (const [kind, key] of [['archived', 'notice.removed'], ['stoppedAndArchived', 'notice.stoppedAndRemoved']] as const) {
      notify({ kind, sessionId: ARCHIVED })
      const alert = screen.getByRole('alert')
      expect({ kind, text: alert.textContent }).toEqual({ kind, text: `${dictionary[key]}${dictionary['notice.undo']}` })
      expect(alert.textContent).not.toMatch(BANNED)
      expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([dictionary['notice.undo']])
      expect(screen.queryByRole('button', { name: workspace['toast.archivedFilter'] })).toBeNull()
    }
    expect(`${zh['notice.removed']}${zh['notice.undo']}`).toBe('对话已移出列表，可撤销')
    expect(`${en['notice.stoppedAndRemoved']}${en['notice.undo']}`).toBe('Stopped and removed from the list. You can undo')
  })

  it('takes an archive notice down, then un-archives the conversation it names, on undo', async () => {
    const { notify, dismissToast, unarchiveSession, owner } = await noticeSurface()
    for (const kind of ['archived', 'stoppedAndArchived'] as const) {
      notify({ kind, sessionId: ARCHIVED })
      fireEvent.click(screen.getByRole('button', { name: zh['notice.undo'] }))
      expect(screen.queryByRole('alert')).toBeNull()
    }
    expect(dismissToast).toHaveBeenCalledTimes(2)
    expect(unarchiveSession.mock.calls).toEqual([[ARCHIVED], [ARCHIVED]])
    expect(dismissToast.mock.invocationCallOrder[0]).toBeLessThan(unarchiveSession.mock.invocationCallOrder[0] ?? 0)
    expect(owner.undoArchive).not.toHaveBeenCalled()
    expect(owner.showArchived).not.toHaveBeenCalled()
  })

  it('reports an un-archive the Host refused to the browser console', async () => {
    const { notify, unarchiveSession } = await noticeSurface()
    const refusal = new Error('refused')
    unarchiveSession.mockImplementationOnce(() => Promise.reject(refusal))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    notify({ kind: 'archived', sessionId: ARCHIVED })
    fireEvent.click(screen.getByRole('button', { name: zh['notice.undo'] }))
    await act(async () => {})
    expect(warn).toHaveBeenCalledExactlyOnceWith('server-sidebar: un-archive rejected:', refusal)
  })

  it('holds an archive notice for 6 s and a failure notice for 3 s before each fades', async () => {
    const { notify, dismissToast } = await noticeSurface()
    vi.useFakeTimers()
    try {
      for (const [notice, heldMs] of [
        [{ kind: 'archived', sessionId: ARCHIVED }, 6000],
        [{ kind: 'stoppedAndArchived', sessionId: ARCHIVED }, 6000],
        [{ kind: 'createFailed', message: 'refused' }, 3000],
        [{ kind: 'defaultWorkspaceFailed' }, 3000],
      ] as const) {
        dismissToast.mockClear()
        notify(notice)
        // The toast reports done once its 1 s fade after the hold has run.
        act(() => { vi.advanceTimersByTime(heldMs + 999) })
        expect({ kind: notice.kind, dismissed: dismissToast.mock.calls.length }).toEqual({ kind: notice.kind, dismissed: 0 })
        act(() => { vi.advanceTimersByTime(1) })
        expect({ kind: notice.kind, dismissed: dismissToast.mock.calls.length }).toEqual({ kind: notice.kind, dismissed: 1 })
        expect(screen.queryByRole('alert')).toBeNull()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('show nothing for a failed fork shortcut, for either reason', async () => {
    const { notify } = await noticeSurface()
    for (const reason of ['unavailable', 'failed'] as const) {
      notify({ kind: 'shortcutForkFailed', reason })
      expect({ reason, alert: screen.queryByRole('alert') }).toEqual({ reason, alert: null })
      expect(document.body.textContent).toBe('')
    }
  })

  it.each([
    [{ kind: 'sessionIdCopied' }, 'toast.sessionIdCopied'],
    [{ kind: 'sessionIdCopyFailed' }, 'toast.sessionIdCopyFailed'],
    [{ kind: 'pinFailed' }, 'toast.pinFailed'],
    [{ kind: 'unpinFailed' }, 'toast.unpinFailed'],
    [{ kind: 'archivedNotOpenable' }, 'toast.archivedNotOpenable'],
    [{ kind: 'forkRequiresOpen', sessionId: ARCHIVED }, 'toast.forkRequiresOpen'],
  ] as const)('leave $0.kind, which nothing on the console raises, to ui-workspace\'s own notice', async (notice, key) => {
    const { notify } = await noticeSurface()
    notify(notice)
    expect(screen.getByRole('alert').textContent).toContain(workspaceZh[key])
  })

  it('give the notices back to ui-workspace once the console\'s plugin unloads', async () => {
    const { notify, consolePlugin } = await noticeSurface()
    await consolePlugin.dispose()
    notify({ kind: 'defaultWorkspaceFailed' })
    expect(screen.getByRole('alert').textContent).toBe(workspaceZh['defaultWorkspace.failed'])
  })
})
