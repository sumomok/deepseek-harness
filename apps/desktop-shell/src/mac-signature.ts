/**
 * Certificate detection for the macOS updater's in-place eligibility check.
 * Resource seals alone also exist on ad-hoc bundles.
 * @module
 */

import { spawnSync } from 'node:child_process'

/**
 * Whether codesign successfully displays a certificate-backed bundle signature.
 * Ad-hoc signatures, absent authorities and probe failures return false, so the
 * updater can use its download-page fallback. A self-signed certificate needs
 * no TeamIdentifier. This display probe does not replace installation's
 * signature verification.
 * @param bundlePath - the running application's `.app` directory.
 * @returns true only when the display succeeds, names an authority and does not
 * report an ad-hoc signature; never throws for a failed probe.
 */
export function macAppHasCertificateSignature(bundlePath: string): boolean {
  try {
    const display = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', bundlePath], { encoding: 'utf8' })
    if (display.status !== 0 || display.error !== undefined) return false
    const lines = `${display.stdout}\n${display.stderr}`.split(/\r?\n/).map(line => line.trim())
    return lines.some(line => line.startsWith('Authority=') && line.slice('Authority='.length).trim() !== '')
      && !lines.some(line => line.startsWith('Signature=adhoc'))
  } catch (_error) {
    // Without a successful display, certificate-backed replacement is unavailable.
    return false
  }
}
