/**
 * Shared resolution of external URLs before an OS hand-off. The caller names
 * the protocol subset it accepts, and this pure function rejects everything it
 * cannot prove safe to hand outside the application: relative or unparsable
 * targets, control characters, backslashes, HTTP(S) destinations without a
 * host, and any URL carrying credentials. Protocols compare as complete
 * `URL.protocol` values, never as prefixes.
 * @module @deepseek-ai/dsh-external-url
 */

/** A protocol an external opener may accept. */
export type ExternalProtocol = 'http:' | 'https:' | 'mailto:'

/** Stable rejection categories reported by {@link resolveExternalUrl}. */
export type ExternalUrlBlockReason =
  | 'surrounding-whitespace'
  | 'control-character'
  | 'backslash'
  | 'relative-url'
  | 'unparsable-url'
  | 'protocol-not-allowed'
  | 'empty-hostname'
  | 'credentials'

/** One resolved external target: canonical href or the reason it was refused. */
export type ExternalUrlResolution =
  | { readonly kind: 'allowed'; readonly url: string; readonly protocol: ExternalProtocol }
  | { readonly kind: 'blocked'; readonly reason: ExternalUrlBlockReason }

/** Actual ASCII control characters and DEL, which URL parsing would otherwise strip or encode. */
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/u

/** An absolute URL's scheme prefix; relative and scheme-relative targets have none. */
const ABSOLUTE_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u

/**
 * Narrow one parsed protocol to the finite set external openers support.
 * @param protocol - `URL.protocol` from a parsed target.
 * @returns true when the protocol is one of `http:`, `https:`, or `mailto:`.
 */
function isExternalProtocol(protocol: string): protocol is ExternalProtocol {
  return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
}

/**
 * Refuse a target for one stable reason.
 * @param reason - category to report.
 * @returns the blocked resolution.
 */
function blocked(reason: ExternalUrlBlockReason): ExternalUrlResolution {
  return { kind: 'blocked', reason }
}

/**
 * Resolve one target for OS hand-off.
 *
 * The target is parsed with `new URL(target)`, without a base, so relative
 * references cannot inherit the application's origin. Leading or trailing
 * whitespace, ASCII control characters, and backslashes are refused before
 * parsing because the URL parser may strip or normalize them. HTTP(S) targets
 * require a hostname and no credentials; `mailto:` keeps its encoded path,
 * subject, and body instead of being decoded here. The returned href is the
 * parser's canonical form, which callers pass to the OS unchanged.
 * @param target - URL reported by a link, navigation, or a configured destination.
 * @param allowedProtocols - protocols this caller accepts.
 * @returns the allowed canonical href, or a blocked result with a stable reason.
 */
export function resolveExternalUrl(
  target: string,
  allowedProtocols: readonly ExternalProtocol[],
): ExternalUrlResolution {
  if (CONTROL_CHARACTER.test(target)) return blocked('control-character')
  if (target !== target.trim()) return blocked('surrounding-whitespace')
  if (target.includes('\\')) return blocked('backslash')
  if (!ABSOLUTE_SCHEME.test(target)) return blocked('relative-url')

  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    // No base was supplied, so this is a malformed absolute target rather than
    // a relative one: a caller cannot recover a destination from it.
    return blocked('unparsable-url')
  }

  if (!isExternalProtocol(parsed.protocol) || !allowedProtocols.includes(parsed.protocol)) {
    return blocked('protocol-not-allowed')
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    /* v8 ignore next -- WHATWG URL refuses a special-scheme URL without a host before this point; the check remains the stated boundary. */
    if (parsed.hostname === '') return blocked('empty-hostname')
    if (parsed.username !== '' || parsed.password !== '') return blocked('credentials')
  }
  return { kind: 'allowed', url: parsed.href, protocol: parsed.protocol }
}
