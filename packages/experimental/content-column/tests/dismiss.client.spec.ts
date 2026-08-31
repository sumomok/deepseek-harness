/**
 * `dismissContentEntry` against a fake `remote.commands` seam: the successful
 * dispatch (proven by the exact command line), a transport-level failure, and
 * a command that ran but answered its own error result.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { dismissContentEntry } from '../src/client/dismiss.ts'

/** Build a minimal fake context exposing only what `dismissContentEntry` reads. */
function fakeContext(execute: () => Promise<unknown>): ClientContext {
  return { remote: { commands: { execute } } } as unknown as ClientContext
}

describe('dismissContentEntry', () => {
  it('executes dismiss-content-entry with the kind and entryId, space-joined', async () => {
    const execute = vi.fn(() => Promise.resolve({ ok: true, value: undefined }))
    await dismissContentEntry(fakeContext(execute), 'session-a', 'page', 'reports')
    expect(execute).toHaveBeenCalledWith('session-a', '/dismiss-content-entry page reports', [])
  })

  it('warns on a transport-level command failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = fakeContext(() => Promise.resolve({ ok: false, error: { code: 'unreachable', message: 'no connection' } }))
    await dismissContentEntry(ctx, 'session-a', 'page', 'reports')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreachable: no connection'))
    warn.mockRestore()
  })

  it('warns when the command ran but answered its own error result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = fakeContext(() => Promise.resolve({ ok: true, value: { result: { kind: 'error', text: 'malformed input' } } }))
    await dismissContentEntry(ctx, 'session-a', 'page', 'reports')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed input'))
    warn.mockRestore()
  })

  it('warns nothing on an ordinary successful dismissal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = fakeContext(() => Promise.resolve({ ok: true, value: { result: { kind: 'success' } } }))
    await dismissContentEntry(ctx, 'session-a', 'page', 'reports')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
