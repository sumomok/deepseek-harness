/**
 * `reportNavigation` against a fake `remote.commands` seam: the exact command
 * line a move produces, the whitespace an address may carry into a line the
 * host splits on spaces, and the two failures that warn rather than throw —
 * nothing the seat renders waits on this call.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { reportNavigation } from '../src/client/perception/navigated.ts'

/** Build a minimal fake context exposing only what `reportNavigation` reads. */
function fakeContext(execute: () => Promise<unknown>): ClientContext {
  return { remote: { commands: { execute } } } as unknown as ClientContext
}

describe('reportNavigation', () => {
  it('names the writer, the page, the address and the title, in that order', async () => {
    const execute = vi.fn(() => Promise.resolve({ ok: true, value: undefined }))
    await reportNavigation(fakeContext(execute), 'session-a', 'home', '/content-app/#/device', 'Fleet devices')
    expect(execute).toHaveBeenCalledWith(
      'session-a',
      '/content-navigated user home /content-app/#/device Fleet devices',
      [],
    )
  })

  it('encodes the whitespace an address carries, leaving what the page already encoded alone', async () => {
    const execute = vi.fn(() => Promise.resolve({ ok: true, value: undefined }))
    await reportNavigation(fakeContext(execute), 'session-a', 'home', '/a b/c%20d?q=e\tf', '')
    expect(execute).toHaveBeenCalledWith('session-a', '/content-navigated user home /a%20b/c%20d?q=e%09f ', [])
  })

  it('warns on a transport-level command failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = fakeContext(() => Promise.resolve({ ok: false, error: { code: 'unreachable', message: 'no connection' } }))
    await reportNavigation(ctx, 'session-a', 'home', '/content-app/', 'Home')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreachable: no connection'))
    warn.mockRestore()
  })

  it('warns when the command ran but refused the report', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = fakeContext(() => Promise.resolve({ ok: true, value: { result: { kind: 'error', text: 'unknown page "x"' } } }))
    await reportNavigation(ctx, 'session-a', 'x', '/content-app/', 'Home')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown page "x"'))
    warn.mockRestore()
  })

  it('warns nothing on an ordinary recorded move', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = fakeContext(() => Promise.resolve({ ok: true, value: { result: { kind: 'success' } } }))
    await reportNavigation(ctx, 'session-a', 'home', '/content-app/', 'Home')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
