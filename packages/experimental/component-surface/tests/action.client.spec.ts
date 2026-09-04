/**
 * `postAction` against a fake `remote.commands` seam: the exact line one gesture
 * becomes, the action this half refuses to send at all, a transport-level
 * failure, a rejected call, and a command that ran but answered its own error
 * result — each with the answer the seat waits on, which is whether a record
 * exists rather than what became of the gesture.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { pendingPressKey, postAction } from '../src/client/action.ts'
import {
  COMPONENT_ACTION_COMMAND,
  CONFIRM_BAR_ID,
  CONFIRM_BAR_PRESS_ID,
  MAX_ACTION_PAYLOAD_BYTES,
  parseComponentActionLine,
  type ComponentAction,
} from '../src/component-call.ts'

/** The three arguments `postAction` calls `remote.commands.execute` with. */
type ExecuteCall = (sessionId: string, line: string, attachments: readonly unknown[]) => Promise<unknown>

/** Build a minimal fake context exposing only what `postAction` reads. */
function fakeContext(execute: ExecuteCall): ClientContext {
  return { remote: { commands: { execute } } } as unknown as ClientContext
}

/** One pressed button, as the seat binds it. */
const PRESS: ComponentAction = {
  entryId: 'budget',
  componentId: CONFIRM_BAR_ID,
  actionId: CONFIRM_BAR_PRESS_ID,
  nodeId: 'ask',
  payload: { buttonId: 'approve' },
}

describe('postAction', () => {
  it('executes component-action with the whole gesture as one JSON argument', async () => {
    const execute = vi.fn<ExecuteCall>(() => Promise.resolve({ ok: true, value: undefined }))
    await postAction(fakeContext(execute), 'session-a', PRESS)
    expect(execute).toHaveBeenCalledWith(
      'session-a',
      `/component-action {"entryId":"budget","componentId":"${CONFIRM_BAR_ID}","actionId":"${CONFIRM_BAR_PRESS_ID}","nodeId":"ask","payload":{"buttonId":"approve"}}`,
      [],
    )
  })

  it('sends a line the host\'s own reader accepts unchanged', async () => {
    const execute = vi.fn<ExecuteCall>(() => Promise.resolve({ ok: true, value: undefined }))
    await postAction(fakeContext(execute), 'session-a', PRESS)
    const line = execute.mock.calls[0]?.[1] as unknown as string
    expect(parseComponentActionLine(line.slice(`/${COMPONENT_ACTION_COMMAND} `.length))).toEqual(PRESS)
  })

  it('refuses an action past the byte ceiling instead of putting it on the wire', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const execute = vi.fn<ExecuteCall>(() => Promise.resolve({ ok: true, value: undefined }))
    // Multi-byte on purpose: the ceiling is UTF-8 bytes, not characters, and a
    // payload this size is exactly what the catalog's whitelist is meant to
    // keep a renderer from assembling.
    const dispatch = await postAction(fakeContext(execute), 'session-a', { ...PRESS, payload: { rows: '三'.repeat(MAX_ACTION_PAYLOAD_BYTES) } })
    expect(execute).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`over the ${MAX_ACTION_PAYLOAD_BYTES}-byte limit`))
    // Nothing ran, so nothing is going to be recorded: the seat is told to stop
    // waiting rather than to wait for a settlement that cannot come.
    expect(dispatch).toBe('failed')
    warn.mockRestore()
  })

  it('warns on a transport-level command failure, and says no record is coming', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = fakeContext(() => Promise.resolve({ ok: false, error: { code: 'unreachable', message: 'no connection' } }))
    expect(await postAction(ctx, 'session-a', PRESS)).toBe('failed')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreachable: no connection'))
    warn.mockRestore()
  })

  it('answers a rejected call the same way, without throwing at the press site', async () => {
    // The seam is an RPC gateway: a closed socket or a restarted host rejects
    // rather than answering, and the click handler that awaits this has nowhere
    // to put a thrown error.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = fakeContext(() => Promise.reject(new Error('gateway closed')))
    expect(await postAction(ctx, 'session-a', PRESS)).toBe('failed')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('gateway closed'))
    warn.mockRestore()
  })

  it('warns when the command ran but answered its own error result — and counts it as recorded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = fakeContext(() => Promise.resolve({ ok: true, value: { result: { kind: 'error', text: '这个动作没能记下来。' } } }))
    // A refusal the handler wrote is a settlement in the log; the block reads it
    // off the fold, which is why this is not a failed dispatch.
    expect(await postAction(ctx, 'session-a', PRESS)).toBe('dispatched')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('这个动作没能记下来。'))
    warn.mockRestore()
  })

  it('warns nothing on an ordinary accepted gesture', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = fakeContext(() => Promise.resolve({ ok: true, value: { result: { kind: 'success' } } }))
    expect(await postAction(ctx, 'session-a', PRESS)).toBe('dispatched')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('pendingPressKey', () => {
  it('separates two blocks that differ in any one of the four parts', () => {
    const base = pendingPressKey('a', 'budget', 4, 'ask')
    expect(new Set([
      base,
      pendingPressKey('b', 'budget', 4, 'ask'),
      pendingPressKey('a', 'cleanup', 4, 'ask'),
      pendingPressKey('a', 'budget', 9, 'ask'),
      pendingPressKey('a', 'budget', 4, 'confirm'),
    ]).size).toBe(5)
    // The same block twice is the same row, which is what makes a remount find
    // its own press.
    expect(pendingPressKey('a', 'budget', 4, 'ask')).toBe(base)
  })

  it('keys a seat with no session apart from one whose session is spelled the same as the gap', () => {
    // No session means the row is written and removed without ever being read;
    // what it must not do is collide with a real session's.
    expect(pendingPressKey(undefined, 'budget', 4, 'ask')).not.toBe(pendingPressKey('null', 'budget', 4, 'ask'))
  })
})
