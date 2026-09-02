/**
 * `selectContentEntry` against a fake `remote.commands` seam: the successful
 * dispatch (proven by the exact command line), a transport-level failure, and
 * a command that ran but answered its own error result. A failure costs the
 * record and not the click, so none of the three throws.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { selectContentEntry } from '../src/client/select.ts'

/** Build a minimal fake context exposing only what `selectContentEntry` reads. */
function fakeContext(execute: () => Promise<unknown>): ClientContext {
  return { remote: { commands: { execute } } } as unknown as ClientContext
}

describe('selectContentEntry', () => {
  it('executes select-content-entry with the kind and entryId, space-joined', async () => {
    const execute = vi.fn(() => Promise.resolve({ ok: true, value: undefined }))
    await selectContentEntry(fakeContext(execute), 'session-a', 'page', 'ini-web2')
    expect(execute).toHaveBeenCalledWith('session-a', '/select-content-entry page ini-web2', [])
  })

  it('warns on a transport-level command failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = fakeContext(() => Promise.resolve({ ok: false, error: { code: 'unreachable', message: 'no connection' } }))
    await selectContentEntry(ctx, 'session-a', 'page', 'ini-web2')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreachable: no connection'))
    warn.mockRestore()
  })

  it('warns when the command ran but answered its own error result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = fakeContext(() => Promise.resolve({ ok: true, value: { result: { kind: 'error', text: 'malformed input' } } }))
    await selectContentEntry(ctx, 'session-a', 'page', 'ini-web2')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed input'))
    warn.mockRestore()
  })

  it('warns nothing on an ordinary successful selection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = fakeContext(() => Promise.resolve({ ok: true, value: { result: { kind: 'success' } } }))
    await selectContentEntry(ctx, 'session-a', 'page', 'ini-web2')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
