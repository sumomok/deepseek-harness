/**
 * Protocol subsets the shell hands to the operating system. Kept separate from
 * the Electron opener so the pure navigation policy can name the same
 * allowlists without importing Electron.
 * @module @deepseek-ai/dsh-desktop-shell/link-protocols
 */

import type { ExternalProtocol } from '@deepseek-ai/dsh-external-url'

/** Protocols an ordinary rendered link may hand to the OS. */
export const SHELL_LINK_PROTOCOLS = ['http:', 'https:', 'mailto:'] as const satisfies readonly ExternalProtocol[]

/** Protocols a release-download destination may hand to the OS. */
export const HTTPS_ONLY_PROTOCOLS = ['https:'] as const satisfies readonly ExternalProtocol[]
