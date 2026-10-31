/**
 * The desktop shell's single hand-off from resolved URLs to the operating
 * system's protocol handlers. Every caller states the protocol subset it
 * accepts; this module never parses a target itself beyond the shared resolver
 * and never lets an OS rejection escape as an unhandled promise.
 * @module @deepseek-ai/dsh-desktop/external-open
 */

import { shell } from 'electron'
import {
  resolveExternalUrl, type ExternalProtocol, type ExternalUrlBlockReason,
} from '@deepseek-ai/dsh-external-url'

/** Protocols a rendered web link may hand to the OS. */
export const WEB_LINK_PROTOCOLS = ['http:', 'https:'] as const satisfies readonly ExternalProtocol[]

/** Protocols a payment, login, or release destination may hand to the OS. */
export const HTTPS_ONLY_PROTOCOLS = ['https:'] as const satisfies readonly ExternalProtocol[]

/** What one hand-off attempt did. */
export type ExternalOpenOutcome =
  | { readonly kind: 'opened'; readonly url: string }
  | { readonly kind: 'blocked'; readonly reason: ExternalUrlBlockReason }
  | { readonly kind: 'failed'; readonly url: string }

/**
 * Resolve and hand one target to the OS.
 *
 * A blocked target never reaches `shell.openExternal`; an OS rejection becomes
 * a `failed` result instead of a rejected promise, so event callbacks can log
 * it without risking an unhandled rejection. The URL is the resolver's
 * canonical href and is passed through unchanged.
 * @param target - URL reported by a link, navigation, or configured destination.
 * @param allowedProtocols - protocols this caller accepts.
 * @returns what happened, including the stable refusal reason when blocked.
 */
export async function openExternalTarget(
  target: string,
  allowedProtocols: readonly ExternalProtocol[],
): Promise<ExternalOpenOutcome> {
  const resolution = resolveExternalUrl(target, allowedProtocols)
  if (resolution.kind === 'blocked') return resolution
  try {
    await shell.openExternal(resolution.url)
    return { kind: 'opened', url: resolution.url }
  } catch {
    // The failure detail is the OS's business; callers report only this safe line.
    return { kind: 'failed', url: resolution.url }
  }
}

/**
 * One log line for a hand-off that did not open. It names the protocol or the
 * stable refusal reason, never the path, query, fragment, or credentials.
 * @param outcome - result returned by {@link openExternalTarget}.
 * @returns a line safe for the desktop log, or the empty string when opened.
 */
export function externalOpenProblemLine(outcome: ExternalOpenOutcome): string {
  if (outcome.kind === 'opened') return ''
  if (outcome.kind === 'blocked') return `[external] blocked target: ${outcome.reason}\n`
  return `[external] operating system did not open the target: ${new URL(outcome.url).protocol}\n`
}
