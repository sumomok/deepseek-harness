/**
 * Content sniffing: text vs binary, decided from bytes alone. No extension is
 * ever consulted here — acceptance is a property of the content.
 *
 * Ported from the retired `@sumomok/dsh-text-drop` plugin's `core/sniff.ts`,
 * where it decided whether a browser-dropped file was text-sniffable before
 * any host round trip. Here it backs the attachment seam's authoritative
 * `NOT_TEXT_FILE` check in `text.ts`; {@link PROBE_BYTES} stays available for
 * a client-side pre-sniff of a large `File` before it is fully read.
 *
 * @module @deepseek-ai/dsh-attachment-local/sniff
 */

/**
 * Bytes read from the front of a file before deciding text vs binary. A
 * protocol constant, not deployment configuration: it sizes the sniff itself,
 * not a policy a deployment would tune.
 */
export const PROBE_BYTES = 8192

/** Sniff verdict for one file. */
export type SniffResult = 'text' | 'binary'

/**
 * Decide text vs binary from a byte probe.
 *
 * A NUL byte is conclusive: no text encoding in use on the web platform
 * contains one, so its presence alone marks the file binary without paying
 * for a decode. Otherwise the probe is fed through a strict UTF-8 decoder;
 * `stream: true` holds back a multi-byte sequence cut at the probe's own
 * edge instead of rejecting it, so a split codepoint at the boundary never
 * produces a false binary verdict.
 * @param probe - the leading bytes of the file (see {@link PROBE_BYTES}), or a complete buffer.
 * @returns 'binary' on a NUL byte or invalid UTF-8, 'text' otherwise —
 * including an empty probe, which carries no evidence of either.
 */
export function sniffProbe(probe: Uint8Array): SniffResult {
  if (probe.includes(0)) return 'binary'
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(probe, { stream: true })
  } catch {
    return 'binary'
  }
  return 'text'
}
