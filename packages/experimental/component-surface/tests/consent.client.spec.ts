/**
 * `postConsent` against a fake `remote.commands` seam: the exact line one
 * agreement becomes, and the two ways it can reach no host.
 *
 * Nothing is reported back to the caller, so what these cases pin is the line
 * itself — the same command the sidebar row ran, with the card's own value on
 * it, which the host's own reader has to accept unchanged.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { consentNonce, parseViewCommandInput } from '../src/consent-question.ts'
import { postConsent } from '../src/client/consent.ts'
import { SHOW_CONTENT_VIEW_COMMAND } from '../src/view-command.ts'

/** The three arguments `postConsent` calls `remote.commands.execute` with. */
type ExecuteCall = (sessionId: string, line: string, attachments: readonly unknown[]) => Promise<unknown>

/** Build a minimal fake context exposing only what `postConsent` reads. */
function fakeContext(execute: ExecuteCall): ClientContext {
  return { remote: { commands: { execute } } } as unknown as ClientContext
}

/** One nonce, in the alphabet the host mints them in. */
const NONCE = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'

/** The card as the row read it back off the settled command. */
const QUESTION = { view: 'layers', card: '打开「图层配置」的数据页。', nonce: consentNonce(NONCE) }

/** Let the dispatch's own promise chain settle before reading what it warned. */
const settled = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('postConsent', () => {
  it('runs the same command the sidebar ran, with the card\'s own value on the line', async () => {
    const execute = vi.fn<ExecuteCall>(() => Promise.resolve({ ok: true, value: undefined }))
    postConsent(fakeContext(execute), 'session-a' as SessionId, QUESTION)
    await settled()
    expect(execute).toHaveBeenCalledWith('session-a', `/${SHOW_CONTENT_VIEW_COMMAND} layers ${NONCE}`, [])
  })

  it('sends a line the host\'s own reader accepts unchanged', async () => {
    const execute = vi.fn<ExecuteCall>(() => Promise.resolve({ ok: true, value: undefined }))
    postConsent(fakeContext(execute), 'session-a' as SessionId, QUESTION)
    await settled()
    const line = execute.mock.calls[0]?.[1] as unknown as string
    expect(parseViewCommandInput(line.slice(`/${SHOW_CONTENT_VIEW_COMMAND} `.length)))
      .toEqual({ viewId: 'layers', nonce: NONCE })
  })

  it('warns and sends nothing further when the gateway refuses the call', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const execute = vi.fn<ExecuteCall>(() => Promise.resolve({ ok: false, error: { code: 'not-found', message: 'no such session' } }))
    postConsent(fakeContext(execute), 'session-a' as SessionId, QUESTION)
    await settled()
    expect(warn).toHaveBeenCalledWith(`component-surface: ${SHOW_CONTENT_VIEW_COMMAND} failed: not-found: no such session`)
    warn.mockRestore()
  })

  it('warns when the call never reached the host at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const execute = vi.fn<ExecuteCall>(() => Promise.reject(new Error('socket closed')))
    postConsent(fakeContext(execute), 'session-a' as SessionId, QUESTION)
    await settled()
    expect(warn).toHaveBeenCalledWith(`component-surface: ${SHOW_CONTENT_VIEW_COMMAND} did not reach the host: Error: socket closed`)
    warn.mockRestore()
  })
})
