/**
 * Shared external-URL resolution: canonical acceptance and the complete set of
 * refusal categories an OS opener relies on. No Electron process is involved.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { resolveExternalUrl, type ExternalProtocol, type ExternalUrlBlockReason } from '../src/index.ts'

/** Every protocol an app-wide shell link may hand to the OS. */
const SHELL_PROTOCOLS = ['http:', 'https:', 'mailto:'] as const satisfies readonly ExternalProtocol[]

/** The release-download caller's narrower subset. */
const HTTPS_ONLY = ['https:'] as const satisfies readonly ExternalProtocol[]

/** One accepted target and the canonical href it must produce. */
interface AcceptedCase {
  readonly target: string
  readonly href: string
}

/** One refused target and the stable reason it must report. */
interface RefusedCase {
  readonly target: string
  readonly reason: ExternalUrlBlockReason
}

const ACCEPTED: readonly AcceptedCase[] = [
  { target: 'https://example.com/path?q=1#frag', href: 'https://example.com/path?q=1#frag' },
  { target: 'http://example.com', href: 'http://example.com/' },
  { target: 'HTTPS://EXAMPLE.COM/Path', href: 'https://example.com/Path' },
  { target: 'https://example.com:443/a', href: 'https://example.com/a' },
  { target: 'mailto:dev@example.com', href: 'mailto:dev@example.com' },
  { target: 'MAILTO:dev@example.com?subject=Hello%20World&body=a%2Fb', href: 'mailto:dev@example.com?subject=Hello%20World&body=a%2Fb' },
  { target: 'mailto:dev@example.com?subject=%E4%BD%A0%E5%A5%BD', href: 'mailto:dev@example.com?subject=%E4%BD%A0%E5%A5%BD' },
  // An encoded control character is data in the path, not a stripped raw byte.
  { target: 'https://example.com/%0a', href: 'https://example.com/%0a' },
]

const REFUSED: readonly RefusedCase[] = [
  { target: ' https://example.com', reason: 'surrounding-whitespace' },
  { target: 'https://example.com ', reason: 'surrounding-whitespace' },
  { target: '   ', reason: 'surrounding-whitespace' },
  { target: 'https://exa\u0000mple.com', reason: 'control-character' },
  { target: 'https://example.com/\n', reason: 'control-character' },
  { target: 'https://example.com/\u007f', reason: 'control-character' },
  { target: 'https://example.com\\@evil.example/', reason: 'backslash' },
  { target: 'C:\\Windows\\System32', reason: 'backslash' },
  { target: '\\\\server\\share', reason: 'backslash' },
  { target: 'https://user:pass@example.com/', reason: 'credentials' },
  { target: 'http://user@example.com/', reason: 'credentials' },
  { target: 'https://:pass@example.com/', reason: 'credentials' },
  // Credentials are refused on every allowed scheme, not only HTTP(S).
  { target: 'mailto://user:pass@example.com/', reason: 'credentials' },
  { target: 'mailto://user@example.com/', reason: 'credentials' },
  { target: 'MAILTO://user:pass@example.com?subject=Hello', reason: 'credentials' },
  { target: '', reason: 'relative-url' },
  { target: 'example.com/path', reason: 'relative-url' },
  { target: '/etc/passwd', reason: 'relative-url' },
  { target: '//example.com', reason: 'relative-url' },
  { target: 'https://', reason: 'unparsable-url' },
  { target: 'http://[::1', reason: 'unparsable-url' },
  { target: 'http://example.com:bad/', reason: 'unparsable-url' },
  { target: 'C:/Windows', reason: 'protocol-not-allowed' },
  { target: 'javascript:alert(1)', reason: 'protocol-not-allowed' },
  { target: 'file:///etc/passwd', reason: 'protocol-not-allowed' },
  { target: 'data:text/html,<script>alert(1)</script>', reason: 'protocol-not-allowed' },
  { target: 'blob:https://example.com/id', reason: 'protocol-not-allowed' },
  { target: 'about:blank', reason: 'protocol-not-allowed' },
  { target: 'ftp://example.com/', reason: 'protocol-not-allowed' },
  { target: 'tel:+123', reason: 'protocol-not-allowed' },
  { target: 'ms-settings:privacy', reason: 'protocol-not-allowed' },
  { target: 'vscode://file/tmp', reason: 'protocol-not-allowed' },
  { target: 'httpx://example.com', reason: 'protocol-not-allowed' },
  { target: 'httpsfoo://example.com', reason: 'protocol-not-allowed' },
]

describe('resolveExternalUrl', () => {
  it.each(ACCEPTED)('accepts $target as $href', ({ target, href }) => {
    expect(resolveExternalUrl(target, SHELL_PROTOCOLS)).toEqual({ kind: 'allowed', url: href, protocol: new URL(href).protocol })
  })

  it.each(REFUSED)('refuses $target as $reason', ({ target, reason }) => {
    expect(resolveExternalUrl(target, SHELL_PROTOCOLS)).toEqual({ kind: 'blocked', reason })
  })

  it('compares complete protocols instead of prefixes', () => {
    for (const target of ['httpx://example.com', 'httpsfoo://example.com', 'mailtofoo:dev@example.com']) {
      expect(resolveExternalUrl(target, SHELL_PROTOCOLS)).toEqual({ kind: 'blocked', reason: 'protocol-not-allowed' })
    }
  })

  it('honours a narrower HTTPS-only allowlist', () => {
    expect(resolveExternalUrl('https://example.com/download', HTTPS_ONLY)).toEqual({
      kind: 'allowed', url: 'https://example.com/download', protocol: 'https:',
    })
    for (const target of ['http://example.com/download', 'http://127.0.0.1/download', 'mailto:dev@example.com']) {
      expect(resolveExternalUrl(target, HTTPS_ONLY)).toEqual({ kind: 'blocked', reason: 'protocol-not-allowed' })
    }
  })

  it('blocks every target when the caller allows no protocol', () => {
    expect(resolveExternalUrl('https://example.com', [])).toEqual({ kind: 'blocked', reason: 'protocol-not-allowed' })
    expect(resolveExternalUrl('mailto:dev@example.com', [])).toEqual({ kind: 'blocked', reason: 'protocol-not-allowed' })
  })
})
