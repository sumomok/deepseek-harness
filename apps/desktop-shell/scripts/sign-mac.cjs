/**
 * Sign the packed macOS app with this product's own self-signed identity.
 *
 * electron-builder cannot do it. Its signing pass resolves an identity through
 * `security find-identity -v -p codesigning`, and `-v` keeps only identities
 * that pass trust evaluation — a self-signed certificate nobody has marked as
 * trusted is reported `CSSMERR_TP_NOT_TRUSTED` and filtered out, so the builder
 * finds nothing and skips signing. `codesign` itself has no such rule: it signs
 * with an untrusted identity and exits 0. What it does require is that the
 * keychain holding the identity be in the **user's keychain search list** —
 * `--keychain` narrows that list rather than adding to it, so an identity in a
 * keychain outside the list is `no identity found` however the signature is
 * requested. Hence the sequence below: temporary keychain, search list, sign,
 * restore.
 *
 * Signing matters because Squirrel.Mac — the installer behind the in-app update
 * path — accepts a replacement bundle only when it satisfies the running app's
 * designated requirement. An unsigned Electron build carries the ad-hoc
 * linker signature the toolchain leaves behind, whose designated requirement
 * degrades to a `cdhash` naming one exact binary, which no later build can ever
 * satisfy. A real signature makes it `identifier "dev.dsh.desktop" and
 * certificate root = H"<fingerprint>"`, which every build signed by the same
 * certificate satisfies. **The certificate does not have to be trusted on the
 * machine running the update**: it travels inside the signature's CMS blob and
 * is never looked up in a keychain there.
 *
 * Nothing is signed on other platforms, and nothing is signed without an
 * identity to sign with — but a missing identity is a hard failure rather than
 * a quiet unsigned build, because an unsigned build published to the feed
 * cannot replace the signed one already installed. `DSH_MAC_SIGN=0` is the
 * explicit way to ask for the unsigned build (a fork with no certificate, or a
 * throwaway local package); src/updater.ts detects that build at runtime and
 * falls back to the download-page update path.
 */

'use strict'

const { execFileSync } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs')
const { homedir, tmpdir } = require('node:os')
const { dirname, join } = require('node:path')

/** Where the signing material lives when the environment names no other path. */
const DEFAULT_SIGNING_DIR = join(homedir(), 'Library', 'Application Support', 'dsh-desktop-signing')

/** Default PKCS#12 bundle: the signing certificate and its private key. */
const DEFAULT_P12 = join(DEFAULT_SIGNING_DIR, 'dsh-desktop-signing.p12')

/**
 * Entitlements the hardened runtime this app is signed with needs granted back.
 * The list is electron-builder's own default set; it lives in a plist because
 * `codesign` takes a file, and that file carries no comments of its own because
 * AMFI's plist parser rejects them.
 *
 * - `allow-jit`: V8 maps writable-executable pages for compiled JavaScript.
 * - `allow-unsigned-executable-memory`: the older V8 and Chromium mappings that
 *   `allow-jit` alone does not cover.
 * - `disable-library-validation`: the embedded server loads N-API addons
 *   (node-pty, koffi, sharp) carrying their own publishers' signatures, and
 *   library validation admits only libraries signed by this app's own team.
 *
 * `--deep` applies the same set to every nested binary it signs, which is what
 * the bundled Node runtime needs as well.
 */
const ENTITLEMENTS = join(__dirname, '..', 'build', 'entitlements.mac.plist')

/**
 * Run one command, returning stdout; a non-zero exit throws with both streams.
 * Arguments never reach a shell, so paths with spaces need no quoting.
 * @param {string} command - the executable to run.
 * @param {string[]} args - its arguments.
 * @returns {string} the captured stdout.
 */
function capture(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * The PKCS#12 bundle and its password, or undefined when signing is opted out.
 * @returns {{ p12: string, password: string } | undefined} the material, or
 * undefined when `DSH_MAC_SIGN=0` asked for an unsigned build.
 */
function resolveSigningMaterial() {
  if (process.env.DSH_MAC_SIGN === '0') return undefined
  const p12 = process.env.DSH_MAC_SIGNING_P12 ?? DEFAULT_P12
  if (!existsSync(p12)) {
    throw new Error(`sign-mac: no signing identity at ${p12}. `
      + 'Point DSH_MAC_SIGNING_P12 at the .p12, or pass DSH_MAC_SIGN=0 to build an unsigned app '
      + 'that can detect updates but not install them.')
  }
  const fromEnv = process.env.DSH_MAC_SIGNING_P12_PASSWORD
  if (fromEnv !== undefined) return { p12, password: fromEnv }
  const passwordFile = `${p12}.pass`
  if (!existsSync(passwordFile)) {
    throw new Error(`sign-mac: ${p12} needs a password: set DSH_MAC_SIGNING_P12_PASSWORD or write it to ${passwordFile}.`)
  }
  return { p12, password: readFileSync(passwordFile, 'utf8').trim() }
}

/**
 * Import the identity into a keychain of its own and put that keychain where
 * `codesign` looks. The keychain password is generated per build and never
 * leaves this process: it exists only because `security` refuses to create a
 * keychain without one.
 * @param {{ p12: string, password: string }} material - the identity to import.
 * @param {(line: string) => void} log - build log sink.
 * @returns {{ keychain: string, hash: string, name: string, previousSearchList: string[] }}
 * the keychain to dispose of, the identity's SHA-1 (the unambiguous way to name
 * it to `codesign`), its common name for the log, and the search list to restore.
 */
function openSigningKeychain(material, log) {
  const keychain = join(mkdtempSync(join(tmpdir(), 'dsh-signing-')), 'dsh-signing.keychain-db')
  const keychainPassword = randomBytes(24).toString('base64')
  capture('security', ['create-keychain', '-p', keychainPassword, keychain])
  // No auto-lock: sealing this bundle's resources takes minutes, and a keychain
  // that relocks mid-signature fails the run with an authorization error.
  capture('security', ['set-keychain-settings', keychain])
  capture('security', ['unlock-keychain', '-p', keychainPassword, keychain])
  // -A grants every application access to the imported key, and the partition
  // list is the second, separate gate macOS added on top of that ACL. Without
  // both, `codesign` blocks on a GUI authorization prompt no build can answer.
  capture('security', ['import', material.p12, '-k', keychain, '-P', material.password, '-A', '-T', '/usr/bin/codesign'])
  capture('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', keychainPassword, keychain])

  const previousSearchList = capture('security', ['list-keychains', '-d', 'user'])
    .split('\n').map(line => line.trim().replace(/^"|"$/g, '')).filter(Boolean)
  capture('security', ['list-keychains', '-d', 'user', '-s', ...previousSearchList, keychain])

  // Without -v, so the identity is listed despite failing trust evaluation.
  const listed = capture('security', ['find-identity', '-p', 'codesigning', keychain])
  const identities = [...listed.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm)]
  if (identities.length !== 1) {
    throw new Error(`sign-mac: ${material.p12} holds ${String(identities.length)} code-signing identities; it must hold exactly one.\n${listed}`)
  }
  const [, hash, name] = identities[0]
  log(`sign-mac: signing identity ${name} (${hash})`)
  return { keychain, hash, name, previousSearchList }
}

/**
 * Sign the packed app in place and prove the signature is the one Squirrel.Mac
 * will accept.
 * @param {object} options - what to sign.
 * @param {string} options.appPath - the packed `.app` bundle.
 * @param {(line: string) => void} options.log - build log sink.
 * @returns {void}
 */
function signMacApp({ appPath, log }) {
  const material = resolveSigningMaterial()
  if (material === undefined) {
    log('sign-mac: DSH_MAC_SIGN=0 — leaving the app unsigned; it will detect updates but hand the download to the browser')
    return
  }
  const session = openSigningKeychain(material, log)
  try {
    const startedAt = Date.now()
    // One --deep pass rather than the inside-out order Apple documents: every
    // binary in this bundle takes the same entitlements, so there is nothing to
    // differentiate, and the pass has to seal ~30k resource files either way.
    capture('codesign', [
      '--force', '--deep',
      // No timestamp: the Apple timestamp authority only counter-signs
      // certificates it can chain, and a signature this build cannot produce
      // offline is a build that fails when the network does. The signing
      // certificate outlives the product instead.
      '--timestamp=none',
      '--options', 'runtime',
      '--entitlements', ENTITLEMENTS,
      '--sign', session.hash,
      appPath,
    ])
    log(`sign-mac: signed ${appPath} in ${String(Math.round((Date.now() - startedAt) / 1000))}s`)
    // The same flags Squirrel.Mac validates a downloaded bundle with, so a
    // package that cannot install itself fails here instead of on a user's
    // machine.
    capture('codesign', ['--verify', '--deep', '--strict', appPath])
    const requirement = capture('codesign', ['-d', '--requirements', '-', appPath])
    log(`sign-mac: verified; designated requirement: ${requirement.trim()}`)
  } finally {
    capture('security', ['list-keychains', '-d', 'user', '-s', ...session.previousSearchList])
    capture('security', ['delete-keychain', session.keychain])
    rmSync(dirname(session.keychain), { recursive: true, force: true })
  }
}

module.exports = { signMacApp }
