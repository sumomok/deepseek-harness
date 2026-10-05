// @vitest-environment jsdom
/**
 * `StopAndRemoveDialog`: the console's copy for `dsh-client-ui-workspace`'s
 * stop-and-archive confirmation, in both languages and free of the vocabulary
 * the console keeps off the screen; the work it would stop, counted and never
 * named; confirming and cancelling handed back to `ui-workspace`; a refusal in
 * fixed copy; the source that reads `ui-workspace`'s pending confirmation
 * through the entry this package shadows, and nothing for a request it cannot
 * read; and the entry id, the face's members, and the request's fields,
 * checked against their owners' source.
 */
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import {
  replaceArchiveConfirm, shadowedStopRequest, StopAndRemoveDialog,
  type StopAndRemoveDialogProps, type StopAndRemoveInjected, type StopRequest,
} from '../src/client/StopAndRemoveDialog.tsx'
import { en, zh } from '../src/client/locales.ts'

/** Words the console keeps off the screen, in either language. */
const BANNED = /工作区|会话|归档|workspace|session|archive/iu

/** The conversation the requests below name. */
const BUSY = 'conversation-1' as SessionId

/** The lookups the dialog receives, one per dictionary. */
const tZh: StopAndRemoveDialogProps['t'] = makeTranslate(zh)
const tEn: StopAndRemoveDialogProps['t'] = makeTranslate(en)

/** A reply in progress, two subagents, a job, and a schedule: five items of work. */
const BUSY_REQUEST: StopRequest = { sessionId: BUSY, running: 5 }

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/**
 * The dialog over a test-owned request source; settling clears the request the way `ui-workspace` does.
 * @param stopAndRemove - the stop-and-remove hop the dialog is handed.
 * @param t - the dialog's lookup.
 * @returns the settlement spy and a way to raise a request.
 */
function dialog(stopAndRemove: StopAndRemoveInjected['stopAndRemove'], t = tZh) {
  const request = createSnapshotStore<StopRequest | null>(null)
  const settleStopRequest = vi.fn(() => { request.set(null) })
  render(
    <StopAndRemoveDialog
      useStopRequest={bindSnapshotSelector(request)}
      settleStopRequest={settleStopRequest}
      stopAndRemove={stopAndRemove}
      t={t}
    />,
  )
  const ask = (next: StopRequest): void => {
    act(() => { request.set(next) })
  }
  return { settleStopRequest, ask }
}

/** `ui-workspace`'s confirmation store and the face its entry injects, as that package builds them. */
function ownerFace() {
  const archiveRequest = createSnapshotStore<unknown>(null)
  const settleSessionArchive = vi.fn(() => { archiveRequest.set(null) })
  const stopAndArchiveSession = vi.fn(async (_sessionId: SessionId) => {})
  return {
    archiveRequest,
    settleSessionArchive,
    stopAndArchiveSession,
    inject: () => ({ hooks: { archiveRequest }, settleSessionArchive, stopAndArchiveSession }),
  }
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
function consoleFace(ctx: Context): StopAndRemoveInjected {
  const ours = ctx.slots.entries('shell.overlay').find(entry => entry.component === StopAndRemoveDialog)
  const face = ours?.inject?.()
  const hooks = face?.['hooks']
  const settleStopRequest = face?.['settleStopRequest']
  const stopAndRemove = face?.['stopAndRemove']
  if (typeof hooks !== 'object' || hooks === null || !('stopRequest' in hooks)
    || typeof settleStopRequest !== 'function' || typeof stopAndRemove !== 'function') {
    throw new Error('the console confirmation entry injects no request face')
  }
  return {
    hooks: { stopRequest: hooks.stopRequest as HostObservable<StopRequest | null> },
    settleStopRequest: settleStopRequest as () => void,
    stopAndRemove: stopAndRemove as (sessionId: SessionId) => Promise<void>,
  }
}

describe('StopAndRemoveDialog', () => {
  it('draws nothing until a confirmation is asked for', () => {
    dialog(vi.fn(async () => {}))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('asks to stop the work and remove the conversation from the list, saying how much work runs, in Chinese', () => {
    dialog(vi.fn(async () => {}))
      .ask(BUSY_REQUEST)
    const open = screen.getByRole('dialog', { name: '停止并移出列表？' })
    expect(open.textContent).toContain('这个对话仍有正在进行的工作。移出列表会先停止这些工作，被停止的工作不会自动继续。')
    expect(open.textContent).toContain('还有 5 项工作在运行')
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label') ?? button.textContent))
      .toEqual(['关闭', '取消', '停止并移出'])
    expect(open.textContent).not.toMatch(BANNED)
  })

  it('reads in English under the English dictionary, singular or plural by count', () => {
    for (const [running, line] of [[1, '1 item of work is still running'], [3, '3 items of work are still running']] as const) {
      dialog(vi.fn(async () => {}), tEn)
        .ask({ sessionId: BUSY, running })
      const open = screen.getByRole('dialog', { name: 'Stop and remove from the list?' })
      expect(open.textContent).toContain(line)
      expect(open.textContent).not.toMatch(BANNED)
      cleanup()
    }
  })

  it('leaves the count out when the request counts no work', () => {
    dialog(vi.fn(async () => {}))
      .ask({ sessionId: BUSY, running: 0 })
    expect(screen.getByRole('dialog').textContent).not.toContain('项工作在运行')
  })

  it('stops and removes on confirm, holds the dialog while that runs, and settles once it lands', async () => {
    const pending = Promise.withResolvers<undefined>()
    const stopAndRemove = vi.fn(() => pending.promise)
    const { settleStopRequest, ask } = dialog(stopAndRemove)
    ask(BUSY_REQUEST)
    fireEvent.click(screen.getByRole('button', { name: '停止并移出' }))
    expect(stopAndRemove).toHaveBeenCalledExactlyOnceWith(BUSY)
    expect(screen.getByRole('status').textContent).toBe('正在停止并移出列表…')
    expect(screen.getByRole('button', { name: '取消' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '停止并移出' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(settleStopRequest).not.toHaveBeenCalled()
    await act(async () => { pending.resolve(undefined) })
    expect(settleStopRequest).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says only that a refused stop did not go through, sends the reason to the browser console, and lets the visitor try again or cancel', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refusal = new Error('session archive failed: workspace/session-active')
    const stopAndRemove = vi.fn<StopAndRemoveInjected['stopAndRemove']>().mockRejectedValueOnce(refusal)
    const { settleStopRequest, ask } = dialog(stopAndRemove)
    ask({ sessionId: BUSY, running: 1 })
    fireEvent.click(screen.getByRole('button', { name: '停止并移出' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('停止或移出失败，请稍后重试') })
    expect(screen.getByRole('dialog').textContent).not.toMatch(BANNED)
    expect(warn).toHaveBeenCalledWith('server-sidebar: could not stop this conversation\'s work and take it off the list:', refusal)
    expect(screen.queryByRole('status')).toBeNull()
    expect(settleStopRequest).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '停止并移出' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(settleStopRequest).toHaveBeenCalledOnce()
    expect(stopAndRemove).toHaveBeenCalledOnce()
  })

  it('reads the English refusal under the English dictionary, and every copy key is free of the banned words', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ask } = dialog(vi.fn<StopAndRemoveInjected['stopAndRemove']>().mockRejectedValueOnce('plain failure'), tEn)
    ask({ sessionId: BUSY, running: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Stop and remove' }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('Couldn’t stop the work and remove it from the list. Try again shortly.')
    })
    for (const dictionary of [zh, en]) {
      const banned = Object.entries(dictionary).filter(([key, text]) => key.startsWith('stopRemove.') && BANNED.test(text))
      expect(banned).toEqual([])
    }
  })

  it('cancels from the close button and from Escape while nothing runs', () => {
    for (const close of [() => { fireEvent.click(screen.getByRole('button', { name: '关闭' })) }, () => { fireEvent.keyDown(document, { key: 'Escape' }) }]) {
      const stopAndRemove = vi.fn(async () => {})
      const { settleStopRequest, ask } = dialog(stopAndRemove)
      ask(BUSY_REQUEST)
      close()
      expect(settleStopRequest).toHaveBeenCalledOnce()
      expect(stopAndRemove).not.toHaveBeenCalled()
      expect(screen.queryByRole('dialog')).toBeNull()
      cleanup()
    }
  })
})

describe('shadowedStopRequest', () => {
  it('shows nothing, settles nothing, and stops nothing while `ui-workspace` has no entry', async () => {
    const source = shadowedStopRequest({ entries: () => [], subscribe: () => () => {} })
    expect(source.request.getSnapshot()).toBeNull()
    expect(() => { source.settle() }).not.toThrow()
    await expect(source.stopAndRemove(BUSY)).resolves.toBeUndefined()
  })

  it('hands on `ui-workspace`\'s request as a count of its work, without the families or the items, and routes the answer back to that package', async () => {
    const owner = ownerFace()
    const source = shadowedStopRequest({
      entries: () => [{ component: null, options: { id: 'workspace.session-archive' }, inject: owner.inject }],
      subscribe: () => () => {},
    })
    owner.archiveRequest.set({
      sessionId: BUSY,
      displayTitle: '/projects/alpha',
      activity: [{ kind: 'turn' }, { kind: 'subagent', items: [{ id: 'child-1', label: 'reviewer' }, { id: 'child-2' }] }, { kind: 'job', items: [] }],
    })
    expect(source.request.getSnapshot()).toEqual({ sessionId: BUSY, running: 3 })
    await source.stopAndRemove(BUSY)
    expect(owner.stopAndArchiveSession).toHaveBeenCalledExactlyOnceWith(BUSY)
    source.settle()
    expect(owner.settleSessionArchive).toHaveBeenCalledOnce()
    expect(source.request.getSnapshot()).toBeNull()
  })

  it('passes the Host\'s refusal on to the dialog', async () => {
    const owner = ownerFace()
    const refusal = new Error('refused')
    owner.stopAndArchiveSession.mockRejectedValueOnce(refusal)
    const source = shadowedStopRequest({
      entries: () => [{ component: null, options: { id: 'workspace.session-archive' }, inject: owner.inject }],
      subscribe: () => () => {},
    })
    await expect(source.stopAndRemove(BUSY)).rejects.toBe(refusal)
  })

  it('shows nothing for a face it does not recognise', () => {
    const live = createSnapshotStore<object>({ sessionId: BUSY, activity: [] })
    const settle = () => {}
    const stop = async () => {}
    for (const face of [
      { hooks: {}, settleSessionArchive: settle, stopAndArchiveSession: stop },
      { hooks: { archiveRequest: live }, stopAndArchiveSession: stop },
      { hooks: { archiveRequest: live }, settleSessionArchive: settle },
    ]) {
      const source = shadowedStopRequest({
        entries: () => [{ component: null, options: { id: 'workspace.session-archive' }, inject: () => face }],
        subscribe: () => () => {},
      })
      expect(source.request.getSnapshot()).toBeNull()
    }
  })

  it('asks nothing for a request any part of which it cannot read, so nothing is stopped unlisted, and says so once per request in the browser console', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const owner = ownerFace()
    const source = shadowedStopRequest({
      entries: () => [{ component: null, options: { id: 'workspace.session-archive' }, inject: owner.inject }],
      subscribe: () => () => {},
    })
    for (const request of [
      'request',
      { activity: [] },
      { sessionId: BUSY },
      { sessionId: 7, activity: [] },
      { sessionId: BUSY, activity: 'turn' },
      { sessionId: BUSY, activity: ['turn'] },
      { sessionId: BUSY, activity: [null] },
      { sessionId: BUSY, activity: [{}] },
      { sessionId: BUSY, activity: [{ kind: 7 }] },
      { sessionId: BUSY, activity: [{ kind: 'job', items: 'bash-1' }] },
      { sessionId: BUSY, activity: [{ kind: 'turn' }, { kind: 'job', items: {} }] },
    ]) {
      owner.archiveRequest.set(request)
      expect({ request, read: source.request.getSnapshot() }).toEqual({ request, read: null })
      expect(source.request.getSnapshot()).toBeNull()
    }
    expect(warn).toHaveBeenCalledTimes(11)
    expect(warn.mock.calls.every(call => call.length === 1 && !JSON.stringify(call).includes(BUSY))).toBe(true)
    warn.mockClear()
    owner.archiveRequest.set(null)
    expect(source.request.getSnapshot()).toBeNull()
    expect(warn).not.toHaveBeenCalled()
    // The items are counted, never read.
    owner.archiveRequest.set({ sessionId: BUSY, activity: [{ kind: 'job', items: [{ id: 'bash-1', label: 'pnpm run build' }, null] }] })
    expect(source.request.getSnapshot()).toEqual({ sessionId: BUSY, running: 2 })
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('replaceArchiveConfirm', () => {
  it('shadows `ui-workspace`\'s confirmation entry at priority -1, in this package\'s locale', async () => {
    const ctx = await overlayBench()
    replaceArchiveConfirm(ctx)
    const owner = ownerFace()
    ctx.slots.register({ name: 'shell.overlay', id: 'workspace.session-archive', inject: owner.inject } as never, () => null)
    const [winner, ...others] = ctx.slots.entriesOfSlot('shell.overlay')
    expect(others).toEqual([])
    expect(winner?.component).toBe(StopAndRemoveDialog)
    expect(winner?.options).toMatchObject({ id: 'workspace.session-archive', priority: -1 })
    expect(winner?.locale).toBe('serverSidebar')
  })

  it('asks through the console\'s entry and answers through `ui-workspace`\'s, end to end', async () => {
    const ctx = await overlayBench()
    replaceArchiveConfirm(ctx)
    const owner = ownerFace()
    ctx.slots.register({ name: 'shell.overlay', id: 'workspace.session-archive', inject: owner.inject } as never, () => null)
    // The ledger reports the registration on a microtask.
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const { hooks: { stopRequest }, settleStopRequest, stopAndRemove } = consoleFace(ctx)
    function Seat() {
      const state = useSyncExternalStore(listener => stopRequest.subscribe(listener), () => stopRequest.getSnapshot())
      return (
        <StopAndRemoveDialog
          useStopRequest={select => select(state)}
          settleStopRequest={settleStopRequest}
          stopAndRemove={stopAndRemove}
          t={tZh}
        />
      )
    }
    render(<Seat />)
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => { owner.archiveRequest.set({ sessionId: BUSY, displayTitle: 'busy', activity: [{ kind: 'turn' }] }) })
    expect(screen.getByRole('dialog').textContent).toContain('还有 1 项工作在运行')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '停止并移出' })) })
    expect(owner.stopAndArchiveSession).toHaveBeenCalledExactlyOnceWith(BUSY)
    expect(owner.settleSessionArchive).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('the shadowed entry', () => {
  /** `ui-workspace`'s client source directory. */
  const owner = resolvePath(import.meta.dirname, '../../../client/ui-workspace/src/client')

  it('is the id `ui-workspace` registers its confirmation under in `shell.overlay`', () => {
    // A literal copy: `ui-workspace` exports no constant for the id, and a
    // renamed id there would bring its own dialog back beside this one.
    expect(readFileSync(resolvePath(owner, 'index.ts'), 'utf8'))
      .toMatch(/name: 'shell\.overlay', id: 'workspace\.session-archive',[^}]*\}, SessionArchiveConfirmDialog\)/u)
  })

  it('carries the face members and request fields `ui-workspace` declares for its confirmation', () => {
    // Literal copies: the `/client` entry exports neither
    // `SessionArchiveConfirmInjected` nor `SessionArchiveConfirmRequest`, and a
    // renamed member there leaves this entry with no confirmation to show.
    const contract = readFileSync(resolvePath(owner, 'contract/slots.ts'), 'utf8')
    const face = /^export interface SessionArchiveConfirmInjected \{\n([\s\S]*?)^\}$/mu.exec(contract)?.[1]
    expect(face).toMatch(/^ {2}hooks: \{\n(?: {4}.*\n)* {4}archiveRequest: HostObservable<SessionArchiveConfirmRequest \| null>\n {2}\}$/mu)
    expect(face).toMatch(/^ {2}settleSessionArchive: \(\) => void$/mu)
    expect(face).toMatch(/^ {2}stopAndArchiveSession: \(sessionId: SessionId\) => Promise<void>$/mu)
    const request = /^export interface SessionArchiveConfirmRequest \{\n([\s\S]*?)^\}$/mu.exec(contract)?.[1]
    expect(request).toMatch(/^ {2}sessionId: SessionId$/mu)
    expect(request).toMatch(/^ {2}activity: readonly SessionActivity\[\]$/mu)
  })

  it('reads the activity fields the Workspace registry declares', () => {
    // The compiler checks these through the exported `SessionActivity` types;
    // the check here names them where a reader looks.
    const types = readFileSync(resolvePath(import.meta.dirname, '../../../workspace/workspace/src/types.ts'), 'utf8')
    const activity = /^export interface SessionActivity \{\n([\s\S]*?)^\}$/mu.exec(types)?.[1]
    expect(activity).toMatch(/^ {2}readonly kind: SessionActivityKind$/mu)
    expect(activity).toMatch(/^ {2}readonly items\?: readonly SessionActivityItem\[\]$/mu)
  })
})
