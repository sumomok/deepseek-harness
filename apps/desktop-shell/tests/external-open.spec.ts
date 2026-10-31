/**
 * The shell's OS opener: one `shell.openExternal` wrapper, shared resolution,
 * and a safe failure line. Electron is a stand-in, so no real protocol handler
 * is ever launched.
 * @module
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalOpenOutcome } from '../src/external-open.ts'

const native = vi.hoisted(() => ({ open: vi.fn<(url: string) => Promise<void>>() }))
vi.mock('electron', () => ({ shell: { openExternal: native.open } }))

const { externalOpenProblemLine, openExternalTarget } = await import('../src/external-open.ts')

beforeEach(() => {
  native.open.mockReset()
  native.open.mockResolvedValue(undefined)
})

describe('openExternalTarget', () => {
  it.each([
    ['https://example.com/page?q=1#x', 'https://example.com/page?q=1#x'],
    ['HTTP://EXAMPLE.COM', 'http://example.com/'],
    ['mailto:dev@example.com?subject=Hello%20World', 'mailto:dev@example.com?subject=Hello%20World'],
  ])('opens the canonical href for %s', async (target, href) => {
    await expect(openExternalTarget(target, ['http:', 'https:', 'mailto:'])).resolves.toEqual({ kind: 'opened', url: href })
    expect(native.open).toHaveBeenCalledExactlyOnceWith(href)
  })

  it.each([
    'httpx://example.com',
    'httpsfoo://example.com',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://example.com/id',
    'about:blank',
    'ftp://example.com/',
    'tel:+123',
    'ms-settings:privacy',
    'C:\\Windows',
    '\\\\server\\share',
    'relative/path',
    'https://',
    'https://user:pass@example.com/',
    'https://exa\u0000mple.com',
  ])('never calls the OS for %s', async (target) => {
    const outcome = await openExternalTarget(target, ['http:', 'https:', 'mailto:'])
    expect(outcome.kind).toBe('blocked')
    expect(native.open).not.toHaveBeenCalled()
  })

  it('keeps the HTTPS-only caller narrower than the shell link policy', async () => {
    await expect(openExternalTarget('http://example.com/download', ['https:'])).resolves.toEqual({
      kind: 'blocked', reason: 'protocol-not-allowed',
    })
    await expect(openExternalTarget('mailto:dev@example.com', ['https:'])).resolves.toEqual({
      kind: 'blocked', reason: 'protocol-not-allowed',
    })
    expect(native.open).not.toHaveBeenCalled()
  })

  it('never calls the OS for a mailto target carrying credentials', async () => {
    await expect(openExternalTarget('mailto://user:pass@example.com/', ['mailto:'])).resolves.toEqual({
      kind: 'blocked', reason: 'credentials',
    })
    await expect(openExternalTarget('mailto://user@example.com/', ['mailto:'])).resolves.toEqual({
      kind: 'blocked', reason: 'credentials',
    })
    expect(native.open).not.toHaveBeenCalled()
  })

  it('turns an OS rejection into a failed result', async () => {
    native.open.mockRejectedValueOnce(new Error('browser refused https://example.com/?token=secret'))
    await expect(openExternalTarget('https://example.com/path?token=secret#frag', ['https:'])).resolves.toEqual({
      kind: 'failed', url: 'https://example.com/path?token=secret#frag',
    })
  })
})

describe('externalOpenProblemLine', () => {
  it('returns no line for a successful open', () => {
    expect(externalOpenProblemLine({ kind: 'opened', url: 'https://example.com/' })).toBe('')
  })

  it('names only the stable reason for a blocked target', () => {
    expect(externalOpenProblemLine({ kind: 'blocked', reason: 'credentials' })).toBe('[external] blocked target: credentials\n')
  })

  it('names only the protocol for an OS failure', () => {
    const outcome: ExternalOpenOutcome = {
      kind: 'failed',
      url: 'https://user:pass@example.com/path?token=secret#fragment',
    }
    const line = externalOpenProblemLine(outcome)
    expect(line).toBe('[external] operating system did not open the target: https:\n')
    for (const fragment of ['user', 'pass', 'token', 'secret', 'fragment', '/path']) expect(line).not.toContain(fragment)
  })
})
