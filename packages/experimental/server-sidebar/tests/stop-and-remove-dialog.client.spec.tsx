// @vitest-environment jsdom
/**
 * `StopAndRemoveDialog`: the console's copy for `dsh-client-ui-workspace`'s
 * stop-and-archive confirmation, in both languages and free of the vocabulary
 * the console keeps off the screen; the work it lists, by family; confirming
 * and cancelling handed back to `ui-workspace`; a refusal in fixed copy; the
 * source that reads `ui-workspace`'s pending confirmation through the entry
 * this package shadows, and nothing for a request it cannot read; and the
 * entry id, the face's members, the request's fields, and the activity
 * families, checked against their owners' source.
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

/** One request per family `ui-workspace` words. */
const EVERY_FAMILY: StopRequest = {
  sessionId: BUSY,
  activity: [
    { kind: 'turn', names: [] },
    { kind: 'subagent', names: ['reviewer', 'child-2'] },
    { kind: 'job', names: ['pnpm run build'] },
    { kind: 'schedule', names: ['check the build'] },
  ],
}

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

/**
 * The lines of the open dialog's list of work.
 * @param name - the list's accessible name.
 * @returns each line's text.
 */
function lines(name: string): (string | null)[] {
  return [...screen.getByRole('list', { name }).querySelectorAll('li')].map(li => li.textContent)
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

  it('asks to stop the work and remove the conversation from the list, listing each family, in Chinese', () => {
    dialog(vi.fn(async () => {}))
      .ask(EVERY_FAMILY)
    const open = screen.getByRole('dialog', { name: '停止并移出列表？' })
    expect(open.textContent).toContain('这个对话仍有正在进行的工作。移出列表会先停止这些工作，被停止的工作不会自动继续。')
    expect(lines('将被停止的工作')).toEqual([
      '正在进行的回复',
      '2 个运行中的子智能体：reviewer、child-2',
      '1 个后台任务：pnpm run build',
      '1 条定时提醒：check the build',
    ])
    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label') ?? button.textContent))
      .toEqual(['关闭', '取消', '停止并移出'])
    expect(open.textContent).not.toMatch(BANNED)
  })

  it('reads in English under the English dictionary, singular or plural by item count', () => {
    dialog(vi.fn(async () => {}), tEn)
      .ask({
        sessionId: BUSY,
        activity: [
          { kind: 'turn', names: [] },
          { kind: 'subagent', names: ['reviewer'] },
          { kind: 'job', names: ['bash-1', 'bash-2'] },
          { kind: 'schedule', names: ['check the build', 'stand-up'] },
          { kind: 'subagent', names: ['a', 'b'] },
          { kind: 'job', names: ['bash-3'] },
          { kind: 'schedule', names: ['nightly'] },
        ],
      })
    const open = screen.getByRole('dialog', { name: 'Stop and remove from the list?' })
    expect(lines('Work that will be stopped')).toEqual([
      'The reply in progress',
      '1 running subagent: reviewer',
      '2 background jobs: bash-1, bash-2',
      '2 scheduled reminders: check the build, stand-up',
      '2 running subagents: a, b',
      '1 background job: bash-3',
      '1 scheduled reminder: nightly',
    ])
    expect(open.textContent).not.toMatch(BANNED)
  })

  it('words a family another provider merged with the generic line, without its key', () => {
    for (const [t, one, other] of [[tZh, '1 项其他工作', '2 项其他工作'], [tEn, '1 other item of work', '2 other items of work']] as const) {
      dialog(vi.fn(async () => {}), t)
        .ask({ sessionId: BUSY, activity: [{ kind: 'probe', names: ['probe-1'] }, { kind: 'probe', names: ['probe-2', 'probe-3'] }] })
      const list = screen.getByRole('list')
      expect([...list.querySelectorAll('li')].map(li => li.textContent)).toEqual([one, other])
      expect(list.textContent).not.toContain('probe')
      cleanup()
    }
  })

  it('stops and removes on confirm, holds the dialog while that runs, and settles once it lands', async () => {
    const pending = Promise.withResolvers<undefined>()
    const stopAndRemove = vi.fn(() => pending.promise)
    const { settleStopRequest, ask } = dialog(stopAndRemove)
    ask(EVERY_FAMILY)
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
    ask({ sessionId: BUSY, activity: [{ kind: 'turn', names: [] }] })
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
    ask({ sessionId: BUSY, activity: [{ kind: 'turn', names: [] }] })
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
      ask(EVERY_FAMILY)
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

  it('hands on `ui-workspace`\'s request with each item\'s label or id, and routes the answer back to that package', async () => {
    const owner = ownerFace()
    const source = shadowedStopRequest({
      entries: () => [{ component: null, options: { id: 'workspace.session-archive' }, inject: owner.inject }],
      subscribe: () => () => {},
    })
    owner.archiveRequest.set({
      sessionId: BUSY,
      displayTitle: '/projects/alpha',
      activity: [{ kind: 'turn' }, { kind: 'subagent', items: [{ id: 'child-1', label: 'reviewer' }, { id: 'child-2' }] }],
    })
    expect(source.request.getSnapshot()).toEqual({
      sessionId: BUSY,
      activity: [{ kind: 'turn', names: [] }, { kind: 'subagent', names: ['reviewer', 'child-2'] }],
    })
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
      { sessionId: BUSY, activity: [{ kind: 'job', items: 'bash-1' }] },
      { sessionId: BUSY, activity: [{ kind: 'job', items: ['bash-1'] }] },
      { sessionId: BUSY, activity: [{ kind: 'job', items: [null] }] },
      { sessionId: BUSY, activity: [{ kind: 'job', items: [{ label: 'build' }] }] },
      { sessionId: BUSY, activity: [{ kind: 'turn' }, { kind: 'job', items: [{ id: 3 }] }] },
    ]) {
      owner.archiveRequest.set(request)
      expect({ request, read: source.request.getSnapshot() }).toEqual({ request, read: null })
      expect(source.request.getSnapshot()).toBeNull()
    }
    expect(warn).toHaveBeenCalledTimes(13)
    expect(warn.mock.calls.every(call => call.length === 1 && !JSON.stringify(call).includes(BUSY))).toBe(true)
    warn.mockClear()
    owner.archiveRequest.set(null)
    expect(source.request.getSnapshot()).toBeNull()
    expect(warn).not.toHaveBeenCalled()
    // An item whose label is not text is named by its id.
    owner.archiveRequest.set({ sessionId: BUSY, activity: [{ kind: 'job', items: [{ id: 'bash-1', label: 7 }] }] })
    expect(source.request.getSnapshot()).toEqual({ sessionId: BUSY, activity: [{ kind: 'job', names: ['bash-1'] }] })
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
    expect(lines('将被停止的工作')).toEqual(['正在进行的回复'])
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

  it('words the activity families `ui-workspace` words, in its order', () => {
    // Literal copies: each family is a key its provider merges into
    // `SessionActivityKindMap`; one `ui-workspace` words and this dialog does
    // not would take the generic line here.
    const families = (source: string) => [...source.matchAll(/^ {4}case '(\w+)': return t\(/gmu)].map(match => match[1])
    const theirs = families(readFileSync(resolvePath(owner, 'session-actions/ArchiveSession.tsx'), 'utf8'))
    expect(theirs).toEqual(['turn', 'subagent', 'job', 'schedule'])
    expect(families(readFileSync(resolvePath(import.meta.dirname, '../src/client/StopAndRemoveDialog.tsx'), 'utf8'))).toEqual(theirs)
  })

  it('reads the activity fields the Workspace registry declares', () => {
    // The compiler checks these through the exported `SessionActivity` types;
    // the check here names them where a reader looks.
    const types = readFileSync(resolvePath(import.meta.dirname, '../../../workspace/workspace/src/types.ts'), 'utf8')
    const activity = /^export interface SessionActivity \{\n([\s\S]*?)^\}$/mu.exec(types)?.[1]
    expect(activity).toMatch(/^ {2}readonly kind: SessionActivityKind$/mu)
    expect(activity).toMatch(/^ {2}readonly items\?: readonly SessionActivityItem\[\]$/mu)
    const item = /^export interface SessionActivityItem \{\n([\s\S]*?)^\}$/mu.exec(types)?.[1]
    expect(item).toMatch(/^ {2}readonly id: string$/mu)
    expect(item).toMatch(/^ {2}readonly label\?: string$/mu)
  })
})
