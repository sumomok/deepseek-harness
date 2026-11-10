/**
 * Update channel of the desktop client. Both platforms read the same
 * electron-builder `generic` feed — a static directory of installers plus a
 * `latest*.yml` manifest — and both install from it in place: Windows through
 * NSIS, macOS through Squirrel.Mac.
 *
 * macOS reaches Squirrel only from a code-signed build. Squirrel accepts a
 * replacement bundle only when it satisfies the **running** app's designated
 * requirement, and the two kinds of build differ in exactly that: a build
 * signed by this product's certificate (scripts/sign-mac.cjs) requires
 * `identifier "dev.dsh.desktop" and certificate root = H"<fingerprint>"`, which
 * every later build signed by the same certificate satisfies, while an unsigned
 * build carries the toolchain's ad-hoc linker signature, whose requirement
 * degrades to a `cdhash` naming that one binary and can never be satisfied
 * again. The certificate needs no trust on the machine being updated: it
 * travels inside the signature.
 *
 * So the channel has three tiers, and the first that holds is the one that runs:
 *
 * 1. **In place** — Windows always, macOS when [[macAppIsSigned]] holds.
 * 2. **Download page** — an unsigned macOS build (a local build, or a fork
 *    packaged without a certificate) detects the new version and hands the
 *    download to the system browser ([[checkGeneric]]).
 * 3. **Fallback** — an in-place path that fails while running (the check
 *    errors, Squirrel refuses the bundle, ShipIt fails) drops to tier 2 for the
 *    rest of the run and re-runs the same check there, rather than ending it in
 *    an error box. A download the network interrupted is not one of those: it
 *    is retried in place ([[download]]) and, if the retries run out, left for
 *    the next check on the same tier.
 *
 * The ordinary path puts nothing on screen until there is something to install.
 * A silent check starts the transfer of whatever it finds; the transfer runs in
 * the background with no window, no taskbar progress and no request for
 * attention, and survives an interruption by resuming rather than restarting
 * ([[download]]). The one visible state is the end of it: an update that is
 * downloaded and verified, reported through [[startUpdateService]] and shown by
 * the Settings entry the embedded server draws. **No install happens without
 * the user deciding it**, on quit or anywhere else: the app replaces itself only
 * in the seconds after someone clicks the button that says so, and that click is
 * the consent — [[installStaged]] asks nothing further. What follows it is
 * neither silent nor a wizard — one progress window, no question to answer, and
 * the app comes back by itself — because an install with no surface at all
 * cannot report what it is doing, and the wizard would only ask again what the
 * click already answered.
 *
 * 帮助 → 检查更新 runs the same silent check, and answers 「已是最新版本」 or
 * 「无法检查更新」 — the two states nothing else shows. A check that found work
 * says nothing at all: the update it found is already on the Settings row, and
 * a dialog on top of a visible button is a second thing to dismiss. On the
 * download page a manual check that finds an update asks 「发现新版本 / 去下载」
 * instead, because that tier has no other way to hand the download over.
 *
 * Above that sits one mandatory layer, keyed on the feed's
 * `minimumBuildSequence`: a build below that line downloads without being
 * asked, and at launch it cannot reach the app until the update is installed.
 * The rule is decided in one place ([[isBelowRedLine]]) and read from two.
 *
 * **What "newer" means is a build identity, not a version.** Every build that
 * follows this protocol embeds a `dshRelease` object in its own package
 * manifest, and every v2 feed entry repeats it
 * ([[@deepseek-ai/dsh-desktop-shell/release-identity]]). The feed lives under
 * `<FEED_BASE>/v2/<platform>/`, a build without an embedded identity is
 * refused rather than guessed at, and the old `/mac`, `/win` sources are never
 * read — a v2 feed that is unreachable is a failed check, not a reason to fall
 * back to the protocol the bridge build replaced.
 *
 * The library still owns the questions the shell must not answer twice: which
 * systems may install this update, which users are inside the rollout, and
 * whether the artifact's signature and checksum hold. This module supplies the
 * one policy the library cannot know — the ordering of two builds of the same
 * application version — through `isUpdateCandidate`, runs after the library's
 * own checks, and treats a refusal by either side as "no update" only when it
 * really was one: an error is a failure, never "already up to date".
 * @module @deepseek-ai/dsh-desktop-shell/updater
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, Menu, shell, type MenuItemConstructorOptions, type MessageBoxOptions } from 'electron'
import { load } from 'js-yaml'
import { MacUpdater, NsisUpdater, type AppUpdater, type UpdateCheckResult } from 'electron-updater'
import { mainWindow } from './main-window.ts'
import { menuText } from './menu-text.ts'
import { closeInstalling, showInstalling } from './progress-window.ts'
import {
  CHECK_RETRY_DELAYS_MS, RESUME_RETRY_DELAYS_MS, RETRY_DELAYS_MS, checkFailureDetail, classifyDownloadError,
  describeDownloadError, httpErrorCode, transferWithFallback, withRetry,
} from './download-retry.ts'
import { updaterLogLine, type UpdaterLogChannel } from './updater-log.ts'
import { UpdateState, type UpdateSnapshot } from './update-state.ts'
import { readState, setInstalledUpdateV2, type InstallReceipt } from './desktop-state.ts'
import {
  appCacheDir, discardStaleParts, type InstalledBuildSweep, partFileFor, pendingDir, placeInPendingCache,
  readStagedArtifact, sweepInstalledBuildPending,
} from './pending-cache.ts'
import {
  keepInstalledArtifact, prepareDifferentialBase, saveDifferentialBaseline, sha512OfFile, type PreparedDifferentialBase,
} from './differential-cache.ts'
import { discardPart, resumeDownload } from './resumable-download.ts'
import type { UpdateServiceSpec } from './update-service.ts'
import {
  decideUpdate, identityIfPresent, isBelowRedLine, isSameBuild, parseReleaseIdentity, parseUpdateOffer,
  ReleaseIdentityError, type ReleaseArch, type ReleaseIdentity, type ReleasePlatform, type UpdateOffer,
} from './release-identity.ts'

/**
 * The published feed, and **the only URL literal this module may contain**.
 * Anything else — a local feed for an end-to-end test above all — arrives
 * through `DSH_UPDATE_FEED`, so a test endpoint cannot be committed by
 * forgetting to undo an edit. That failure mode is silent where it matters: a
 * build shipped pointing at a machine-local address reports nothing and simply
 * never finds an update again.
 *
 * There is no `app.isPackaged` guard around the override, because the only
 * builds that can exercise the macOS path at all are packaged and signed ones —
 * Squirrel replaces a bundle, so a source-tree launch has nothing to test with.
 * The exposure it adds is nil either way: setting an environment variable in
 * this app's session already requires owning the session.
 */
const FEED_DEFAULT = 'https://lhr.ink/dsh-updates'

/**
 * Base of the static update feed, and the root `DSH_UPDATE_FEED` still names
 * as a whole: the protocol's own path is appended to it below.
 */
const FEED_BASE = process.env.DSH_UPDATE_FEED ?? FEED_DEFAULT

/**
 * The protocol version this build reads, fixed by the build rather than by a
 * setting: a build that could be switched between protocols could be pointed
 * back at the source the bridge build exists to leave behind.
 */
const FEED_PROTOCOL = 'v2'

/** Windows feed: `latest.yml` plus the NSIS installer. */
const FEED_WIN = `${FEED_BASE}/${FEED_PROTOCOL}/win`

/** macOS feed: `latest-mac.yml` plus the zipped app. */
const FEED_MAC = `${FEED_BASE}/${FEED_PROTOCOL}/mac`

/** Where the Help menu's "Report an Issue" lands: a prefilled new-issue page. */
const ISSUE_NEW_URL = 'https://github.com/sumomok/deepseek-harness/issues/new'

/**
 * The one channel this product publishes, set explicitly on both ends: the
 * default derives it from the running version's prerelease tag, which would
 * make an `0.1.0-rc.N` build look for `rc.yml` and rename the channel at every
 * stage of the release cycle. Must match `publish.channel` in electron-builder.yml.
 */
const FEED_CHANNEL = 'latest'

/** Delay between app ready and the first silent check; the server boot owns the first seconds. */
const FIRST_CHECK_DELAY_MS = 15_000

/** Period of the recurring silent check. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/** How long the macOS feed fetch may take before the check is abandoned. */
const MAC_FEED_TIMEOUT_MS = 20_000

/**
 * How long the launch gate waits for the feed. An unreachable feed must never
 * hold the app shut, so the gate opens on timeout and the mandatory line is
 * enforced on a later launch that can reach the server.
 */
const GATE_TIMEOUT_MS = 15_000

/**
 * Why a check is running. It decides only who may be interrupted: `manual` —
 * the menu item — may answer with a dialog when the check has nothing to show,
 * and `startup`, `scheduled` and `requested` (the Settings entry's own button)
 * never may. A check that found an update interrupts nobody either way: what
 * it found is shown on the Settings row.
 */
type CheckReason = 'startup' | 'scheduled' | 'manual' | 'requested'

/** What the updater — and the application menu it builds — needs from the app. */
export interface UpdateHost {
  /** Append one line to the desktop log sink (the `dsh-server.log` stream). */
  log: (line: string) => void
  /**
   * Open `dsh-server.log` in whatever the system uses for it. The boot page
   * stopped printing the path, so the menu item backed by this is the only
   * route to the log a user can be told to take.
   */
  openLog: () => void
  /**
   * Mark the app as quitting and tear the embedded server down. Resolves only
   * once the server's whole process tree is confirmed gone, which is the
   * precondition for handing control to an installer that replaces the app
   * directory; a stop that cannot be confirmed **rejects** with a failure
   * carrying `code: 'UPDATE_STOP_INCOMPLETE'`, and the install is then not
   * handed over.
   */
  prepareQuit: () => Promise<void>
  /**
   * Undo [[prepareQuit]] after the installer this run handed over to failed,
   * or after a teardown that could not be confirmed: clear the quitting state,
   * restart the server unless the mandatory block holds the app, and show the
   * window.
   * @param blocking - whether the mandatory-update block holds the app.
   * @returns once the app is back.
   */
  resumeAfterFailedInstall: (blocking: boolean) => Promise<void>
}

/** The single updater instance; its event listeners must be registered once. */
let updater: AppUpdater | undefined

/**
 * Whether this macOS bundle carries a real signature, resolved once because the
 * answer cannot change while the app runs.
 */
let macSigned: boolean | undefined

/**
 * Set when the macOS in-place path failed while running. Every later check in
 * this run takes the download-page path instead, and the next launch tries the
 * in-place path again.
 *
 * What demotes is a failure that says this build cannot install this update:
 * a check that could not read the feed, a Squirrel refusal, a signature or
 * checksum verdict. A download the network interrupted does not, because the
 * tier it would abandon is the one that will work on the next attempt.
 */
let macInstallUnavailable = false

/**
 * The candidate this channel has accepted: the build a check may download and
 * the artifact an install would take.
 *
 * It is frozen by the first thing that acts on it — a transfer in flight, or
 * an update downloaded and waiting for its install — because the bytes on disk
 * and the receipt the install writes both name this build. A later check may
 * replace it only while nothing is acting on it; a check that finds nothing
 * takes it away.
 */
let frozenOffer: UpdateOffer | undefined

/**
 * The candidate whose bytes this process verified on disk and has not installed.
 *
 * Ownership of a downloaded update cannot be read from the reported phase: a
 * hand-off that never started leaves the artifact intact, and a check that
 * trusts the phase alone would replace a file that is still installable. Once
 * set, every check and every transfer stands down for the rest of the run; the
 * process ends when the installer takes over.
 */
let downloadedOffer: UpdateOffer | undefined

/**
 * The candidate whose downloaded bytes are being verified right now.
 *
 * Separate from [[downloadedOffer]] on purpose: until the read finishes, the
 * file has not been shown to be the accepted artifact, and an install click in
 * that window must find nothing to install. Checks and retries stand down for
 * the same reason they do while a transfer is in flight.
 */
let verifyingOffer: UpdateOffer | undefined

/**
 * The install this process is carrying out, from the click until the installer
 * takes over or the attempt is given up.
 *
 * The receipt, the server teardown, the hand-off, and the recovery after a
 * refusal are one operation. A second request arriving between them must not
 * write a second receipt, stop the server twice, or clear the receipt of the
 * attempt that is still running. The lock is taken before the receipt is
 * written and released only once a failed attempt has finished restoring the
 * app, so the retry its dialog offers is a new attempt rather than a rival of
 * the one being cleaned up.
 */
let installing: UpdateOffer | undefined

/**
 * What the library accepted inside the check that is running right now.
 *
 * Written only by the candidate callback [[ensureUpdater]] installs and read
 * only by the check that owns it, so a candidate from one check can never be
 * downloaded by another: the check that never asked has no candidate to
 * misuse.
 */
let acceptedOffer: UpdateOffer | undefined

/**
 * The check in flight, so two callers share one answer. The launch gate and a
 * check the Settings entry started can overlap; both must read the same
 * candidate and neither may erase the other's.
 */
let sharedCheck: Promise<UpdateOffer | undefined> | undefined

/**
 * Whether a download is in flight, which stays true across a retry's wait: the
 * transfer is still the current one, and the `error` listener reads this to
 * tell a download's failure — owned by [[download]] — from a failure anywhere
 * else in the updater.
 */
let downloading = false

/**
 * Whether a check is in flight, which stays true across a retry's wait. The
 * `error` listener reads this to leave a check's failure to whoever called
 * [[checkFeedWithRetry]]: every failed attempt raises the event, and demoting
 * on the first would take the in-place tier away before the retry that would
 * have answered.
 */
let checkInFlight = false

/**
 * Set once the launch gate found a mandatory update. Every ordinary check
 * stands down afterwards: the blocking path owns the app from that point.
 */
let blocking = false

/**
 * Where the boot page's holding line is written while the launch gate keeps
 * the app shut, and undefined at every other moment. Set only for the tier
 * that downloads behind that page, which is the one whose wait is worth
 * reporting: the app is unusable until the transfer ends, and a line that
 * never changes over 170 MB reads as a hang.
 */
let blockLine: ((message: string) => void) | undefined

/**
 * The boot page's line while a mandatory update transfers.
 * @param percent - transfer completion, once the transfer has reported any.
 * @returns the line to show.
 */
function mandatoryDownloadLine(percent: number | undefined): string {
  const suffix = percent === undefined ? '' : ` ${String(Math.floor(percent))}%`
  return `这是必须安装的更新,正在下载新版本…${suffix}`
}

/**
 * The one line about this installation's own package that is worth writing
 * before the updater's log sink exists, which the main process can ask for.
 */
let reportIdentityLine: (line: string) => void = (line) => { process.stderr.write(line) }

/** What one read of the running build's own manifest found. */
interface InstalledIdentityRead {
  /** The identity the manifest declares, when it declares a usable one. */
  identity?: ReleaseIdentity
  /** The line describing what was found, written once. */
  line: string
}

/** The identity read of this process, cached because a package cannot change under it. */
let installedIdentityRead: InstalledIdentityRead | undefined

/**
 * Read the release identity this installation declares, out of its own package
 * manifest at `app.getAppPath()/package.json`.
 *
 * The manifest is the only acceptable source of "which build am I": user state,
 * the feed, and the environment can all name a build the running code is not.
 * A package that predates this protocol declares no `dshRelease`, and a
 * source-tree launch has no packaged manifest at all; both read as undefined,
 * which every caller treats as "this build cannot decide an update" rather than
 * as a build it may guess at. Nothing here stops the app from running, and the
 * answer is cached because the installed package cannot change while this
 * process lives.
 * @returns the identity this installation declares, or undefined when it declares none.
 */
export function readInstalledIdentity(): ReleaseIdentity | undefined {
  if (installedIdentityRead === undefined) {
    installedIdentityRead = readOwnIdentity()
    reportIdentityLine(installedIdentityRead.line)
  }
  return installedIdentityRead.identity
}

/**
 * Read and validate this installation's own package manifest.
 * @returns what the manifest declares and the one line describing it.
 */
function readOwnIdentity(): InstalledIdentityRead {
  let file: string
  let manifest: unknown
  try {
    file = join(app.getAppPath(), 'package.json')
    manifest = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    // A development start, or an installation whose manifest cannot be read:
    // no identity can be confirmed, and none is invented.
    return { line: `[updater] no readable application manifest under ${app.getAppPath()} (${messageOf(error)}); updates are disabled\n` }
  }
  try {
    const identity = identityIfPresent(manifest)
    if (identity === undefined) {
      return { line: `[updater] ${file} declares no dshRelease identity; updates are disabled\n` }
    }
    const { version, dshRelease } = identity
    return {
      identity,
      line: `[updater] installed build ${version}, build ${String(dshRelease.buildSequence)}, runtime ${dshRelease.runtimeVersion}, revision ${dshRelease.revision}\n`,
    }
  } catch (error) {
    // An embedded identity this build refuses is an installation defect, not a
    // reason to guess: every check reports it and nothing is downloaded.
    return { line: `[updater] the dshRelease identity in ${file} is unusable (${messageOf(error)}); updates are disabled\n` }
  }
}

/**
 * The identity of this installation, refusing to answer when it has none.
 * @returns the running build's identity.
 * @throws [[ReleaseIdentityError]] when the installation declares no usable identity.
 */
function requireInstalledIdentity(): ReleaseIdentity {
  const identity = readInstalledIdentity()
  if (identity === undefined) {
    const line = (installedIdentityRead?.line ?? '').trim().replace(/^\[updater\] /u, '')
    throw new ReleaseIdentityError('RELEASE_IDENTITY_INVALID', 'dshRelease', line)
  }
  return identity
}

/**
 * The platform and architecture a feed offer must name for this process.
 *
 * Only the two published targets follow this protocol; a build running
 * anywhere else cannot say which artifact belongs to it, so it fails its check
 * visibly instead of picking one.
 * @returns the platform this build is.
 * @throws [[ReleaseIdentityError]] when this is neither a published platform nor architecture.
 */
function releasePlatform(): ReleasePlatform {
  if (process.platform === 'darwin' || process.platform === 'win32') return process.platform
  throw new ReleaseIdentityError('RELEASE_IDENTITY_INVALID', 'platform', `this update protocol publishes macOS and Windows builds only, this is ${process.platform}`)
}

/** Whether this macOS process runs translated onto arm64 hardware, resolved once. */
let macTranslated: boolean | undefined

/**
 * The architecture the update library selects artifacts for.
 *
 * That is this process's own architecture, with one exception the library makes
 * for macOS: an x64 build running through Rosetta on Apple-silicon hardware is
 * treated as arm64 there, and the library prefers the arm64-named artifact —
 * which Squirrel then installs. The frozen artifact must be the file the library
 * downloads, so this reports that same answer instead of [[process.arch]].
 * @returns the architecture the library selects for.
 * @throws [[ReleaseIdentityError]] when it is neither arm64 nor x64.
 */
function releaseArch(): ReleaseArch {
  if (process.arch === 'arm64') return 'arm64'
  if (process.arch !== 'x64') {
    throw new ReleaseIdentityError('RELEASE_IDENTITY_INVALID', 'arch', `this update protocol publishes arm64 and x64 builds only, this is ${process.arch}`)
  }
  if (process.platform !== 'darwin') return 'x64'
  macTranslated ??= translatedOnArm64()
  return macTranslated ? 'arm64' : 'x64'
}

/**
 * Whether macOS reports this x64 process as translated onto arm64 hardware.
 * @returns true when the Rosetta translation flag is set.
 */
function translatedOnArm64(): boolean {
  try {
    return execFileSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8' }).trim() === '1'
  } catch {
    // The key exists only on Apple-silicon macOS; an Intel host, or one without
    // sysctl, reports nothing and needs no arm64 preference.
    return false
  }
}

/**
 * The message of one failure, for a log line.
 * @param error - the value a read or a check failed with.
 * @returns its message, or its string form for a thrown non-error.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The human label of one build: its application version and, when it declares
 * one, its build sequence.
 * @param identity - the build to label, if there is one.
 * @returns the label, or the version Electron reports when no identity is known.
 */
function buildLabel(identity: ReleaseIdentity | undefined): string {
  if (identity === undefined) return app.getVersion()
  return `${identity.version} · 构建 ${String(identity.dshRelease.buildSequence)}`
}

/**
 * What the channel is doing, as the Settings entry reads it. Built on first use
 * rather than at import, because `app.getVersion()` and the installed identity
 * need the app object.
 */
let channelState: UpdateState | undefined

/**
 * The reportable state of the update channel.
 * @param host - logging and quit coordination from the main process.
 * @returns the machine every stage of the channel writes into.
 */
function updateState(host: UpdateHost): UpdateState {
  reportIdentityLine = host.log
  channelState ??= new UpdateState(app.getVersion(), readInstalledIdentity()?.dshRelease.buildSequence)
  return channelState
}

/**
 * Whether this macOS bundle is code signed, which is what decides between the
 * first two tiers.
 *
 * The probe is the presence of `Contents/_CodeSignature/CodeResources`: signing
 * a bundle seals its resources and writes that file, while the ad-hoc linker
 * signature an unsigned Electron build carries seals nothing and writes
 * nothing (`Sealed Resources=none`). A `codesign` subprocess would answer the
 * same question, and this runs on every launch's first check — an `existsSync`
 * is the version of the question that costs nothing.
 * @returns true when the bundle was signed with a certificate.
 */
function macAppIsSigned(): boolean {
  // getPath('exe') is <App>.app/Contents/MacOS/<exe>; two levels up is Contents.
  macSigned ??= existsSync(join(dirname(dirname(app.getPath('exe'))), '_CodeSignature', 'CodeResources'))
  return macSigned
}

/**
 * Whether this build can replace itself where it stands, which is what decides
 * between [[checkInPlace]] and [[checkGeneric]] and between the two shapes of
 * the mandatory launch block.
 * @returns true when the update can be installed without leaving the app.
 */
function canInstallInPlace(): boolean {
  if (process.platform === 'win32') return true
  if (process.platform !== 'darwin') return false
  return macAppIsSigned() && !macInstallUnavailable
}

/**
 * Read the old protocol's `minimumVersion` off a manifest electron-updater
 * parsed. The field survives the library's js-yaml parse even though its
 * `UpdateInfo` type does not declare it, which is exactly why it is read here:
 * a v2 feed that still carries it is refused rather than interpreted.
 * @param info - the parsed manifest.
 * @returns the field's value, or undefined when the manifest sets none.
 */
function versionRedLineOf(info: unknown): unknown {
  return (info as { minimumVersion?: unknown } | null | undefined)?.minimumVersion
}

/**
 * Read the candidate a v2 manifest describes for this machine.
 *
 * Every entry point passes its manifest through here — the library's parsed
 * `UpdateInfo` and the shell's own read of the same document alike — so one
 * parser decides what this build may download. The old protocol's
 * `minimumVersion` is refused rather than ignored: a v2 feed that carried both
 * red lines could state two different rules about who must update, and this
 * protocol has only the build sequence.
 * @param manifest - the parsed `latest*.yml` document.
 * @returns the offer for this platform and architecture.
 * @throws [[ReleaseIdentityError]] when the document is not a usable v2 manifest.
 */
function offerFrom(manifest: unknown): UpdateOffer {
  if (versionRedLineOf(manifest) !== undefined) {
    throw new ReleaseIdentityError(
      'UPDATE_MANIFEST_INVALID',
      'minimumVersion',
      'a v2 feed states its red line as minimumBuildSequence, not as a version',
    )
  }
  return parseUpdateOffer(manifest, releasePlatform(), releaseArch())
}

/**
 * Absolute URL of one feed artifact. electron-builder leaves spaces unencoded
 * in the manifest's `url` field, so the file name is encoded here; it is the
 * one segment the frozen artifact named, which is also the name the library
 * caches the download under.
 * @param base - the platform feed directory.
 * @param entryUrl - the artifact's file name, as the accepted offer carries it.
 * @returns the absolute download URL.
 */
function feedFileUrl(base: string, entryUrl: string): string {
  return `${base}/${encodeURI(entryUrl)}`
}

/**
 * The v2 feed directory one platform reads.
 * @param platform - the platform whose artifacts are wanted.
 * @returns the feed base for that platform.
 */
function feedBase(platform: ReleasePlatform): string {
  return platform === 'darwin' ? FEED_MAC : FEED_WIN
}

/** Release notes trimmed to what a dialog can show without becoming a wall of text. */
function notesDetail(notes: string | undefined): string {
  const text = (notes ?? '').trim()
  if (text === '') return ''
  return text.split('\n').slice(0, 12).join('\n')
}

/**
 * Fetch one platform's v2 manifest and parse it as YAML.
 *
 * The status a refusal carried is attached as a code rather than left to the
 * message, which is this repository's own Chinese prose that no pattern in
 * `download-retry.ts` reads. Without it a refused manifest carried no
 * identification at all: the log and the reported failure printed the prose,
 * and [[classifyDownloadError]] called every status fatal by the fail-closed
 * default, so a feed that failed and a feed that answered `404` were one
 * failure to every caller. It is the same code electron-updater's own manifest
 * read raises, so one status is named the same way whichever half met it.
 *
 * The document is returned unvalidated because [[offerFrom]] is the one place
 * that decides what a manifest may say; this function only gets the bytes.
 * @param url - the manifest to read.
 * @returns the parsed YAML document.
 * @throws when the feed refuses the request, carrying [[httpErrorCode]], or
 * when the body is not a YAML document.
 */
async function fetchManifest(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(MAC_FEED_TIMEOUT_MS) })
  if (!response.ok) {
    throw Object.assign(
      new Error(`更新源返回 ${String(response.status)} ${response.statusText}(${url})`),
      { code: httpErrorCode(response.status) },
    )
  }
  return load(await response.text())
}

/**
 * Ask for the user's attention before a dialog they did not open. An update
 * dialog arrives while the app is in the background as often as not, and a
 * window-modal dialog that the user cannot see is worse than a floating one:
 * on Windows the taskbar button flashes until the window is focused, on macOS
 * the Dock icon bounces once.
 * @param window - the window the dialog will be attached to, if any.
 */
function requestAttention(window: BrowserWindow | undefined): void {
  if (process.platform === 'darwin') {
    if (BrowserWindow.getFocusedWindow() === null) app.dock?.bounce('informational')
    return
  }
  if (window === undefined || window.isFocused()) return
  window.flashFrame(true)
  window.once('focus', () => {
    if (!window.isDestroyed()) window.flashFrame(false)
  })
}

/**
 * Show one dialog, attached to the app's own window on Windows and standing on
 * its own on macOS.
 *
 * On Windows a parentless `showMessageBox` opens an independent top-level
 * window, which the shell is free to place behind whatever the user is working
 * in — the update prompt then exists without being seen. Attaching it makes it
 * window-modal, so it rides on top of the window it belongs to, and a window
 * sitting in the tray is brought back first, because a window-modal dialog
 * owned by a hidden window can be neither seen nor found.
 *
 * On macOS attaching it is what must not happen. A parented dialog is an NSAlert
 * **sheet**, and a sheet ends when anything raises its parent —
 * `BrowserWindow.focus()` is enough — reporting button index 0 as if it had been
 * clicked. Every route back into the app calls [[revealMainWindow]] (the Dock
 * icon, a clicked notification, a second launch), so a sheet here would let a
 * click on the Dock answer 「重启安装」 and install an update nobody agreed to.
 * A parentless dialog on macOS is an app-modal alert panel: it comes forward
 * with the app, and only a button ends it.
 * @param options - the dialog to show.
 * @returns the index of the button the user chose.
 */
async function ask(options: MessageBoxOptions): Promise<number> {
  const parent = mainWindow()
  if (parent !== undefined && !parent.isVisible()) parent.show()
  requestAttention(parent)
  const answer = parent === undefined || process.platform === 'darwin'
    ? await dialog.showMessageBox(options)
    : await dialog.showMessageBox(parent, options)
  return answer.response
}

/**
 * Wire the update channel: build the application menu, run the delayed and
 * recurring silent checks, and expose the manual check the menu triggers.
 * Unpackaged launches skip the whole channel — a source-tree run has no
 * installer to replace and no version the feed could outrank.
 * @param host - logging and quit coordination from the main process.
 * @returns the manual check, so the tray menu offers the same 检查更新 the
 * help menu does rather than a second entry point with its own rules.
 */
export function setupUpdates(host: UpdateHost): () => void {
  // The identity is read here first for the package it names, and this is the
  // earliest caller with a log sink to put that line in.
  reportIdentityLine = host.log
  const check = app.isPackaged
    ? (reason: CheckReason): void => { void runCheck(host, reason) }
    : (reason: CheckReason): void => {
      updateState(host).markUnavailable('development launch: there is no installed app to replace')
      host.log('[updater] skipped: development launches have no installed app to replace\n')
      if (reason === 'manual') {
        void ask({
          type: 'info',
          message: '开发模式不检查更新',
          detail: '当前是从源码启动的开发实例,更新只对安装后的应用生效。',
          buttons: ['好'],
        })
      }
    }
  const manual = (): void => { check('manual') }
  // Built before the packaged check: 「查看日志」 is exactly as useful in a
  // development launch, where startup problems are just as likely.
  buildMenu(manual, host.openLog)
  if (!app.isPackaged) return manual
  // Before the first check, so no download of this run can be staged yet.
  sweepAfterInstall(host)
  const first = setTimeout(() => { check('startup') }, FIRST_CHECK_DELAY_MS)
  const recurring = setInterval(() => { check('scheduled') }, CHECK_INTERVAL_MS)
  app.once('before-quit', () => {
    clearTimeout(first)
    clearInterval(recurring)
  })
  return manual
}

/**
 * What the loopback update service reports and drives.
 *
 * The three actions return at once and report through the snapshot rather than
 * through their answers: a check and a transfer take minutes, and the caller is
 * a settings page that polls. Outside a packaged build `check` and `download`
 * do nothing. `install` is reached only from the `ready` phase, which the
 * service enforces before it calls this.
 * @param host - logging and quit coordination from the main process.
 * @returns the four halves [[startUpdateService]] needs.
 */
export function updateActions(host: UpdateHost): UpdateServiceSpec {
  reportIdentityLine = host.log
  return {
    state: (): UpdateSnapshot => updateState(host).snapshot(),
    check: () => { if (app.isPackaged) void runCheck(host, 'requested') },
    download: () => { if (app.isPackaged) void restartDownload(host) },
    install: () => {
      // The service calls this only in the `ready` phase, which nothing but a
      // verified `update-downloaded` produces; that file — not merely the
      // frozen candidate — is what the click installs. Both are required here
      // again so the action cannot outrun the verification it depends on, and
      // an install already under way is never entered a second time.
      const offer = downloadedOffer
      if (offer !== undefined && installing === undefined && updateState(host).isReady()) void installStaged(host, offer)
    },
  }
}

/**
 * Transfer the candidate the last check froze, or find one first.
 *
 * This is what the Settings entry's retry does after a transfer gave up. A
 * transfer already in flight is left alone, because restarting it would throw
 * away the bytes the resumable downloader is holding, and a verified download
 * waiting for its install is retried by installing it, never by transferring
 * it again.
 * @param host - logging and quit coordination from the main process.
 */
async function restartDownload(host: UpdateHost): Promise<void> {
  if (blocking || downloading || verifyingOffer !== undefined || downloadedOffer !== undefined) return
  const offer = frozenOffer
  if (offer === undefined || !canInstallInPlace()) {
    await runCheck(host, 'requested')
    return
  }
  const started = ensureUpdater(host)
  updateState(host).downloadStarted(offer.identity.version, offer.releaseNotes, offer.identity.dshRelease.buildSequence)
  host.log(`[updater] downloading ${buildLabel(offer.identity)} on request\n`)
  await download(host, offer, async () => { await started.downloadUpdate() })
}

/**
 * Decide at launch whether this build may open the app at all, and take over
 * when it may not. The verdict is bounded by [[GATE_TIMEOUT_MS]] and defaults
 * to letting the app open, because a feed that cannot be reached must never
 * lock someone out of their own machine.
 *
 * Runs concurrently with the server boot; the caller awaits it only when the
 * server is ready, so on the ordinary path it costs no wall-clock time.
 * @param host - logging and quit coordination from the main process.
 * @param onBlock - shows one line on the boot page. Called once when the
 * launch is blocked, and again for each transfer sample where the update
 * installs in place, so the line carries the transfer's completion.
 * @returns true when the app must not open.
 */
export async function launchGate(host: UpdateHost, onBlock: (message: string) => void): Promise<boolean> {
  if (!app.isPackaged) return false
  reportIdentityLine = host.log
  try {
    const verdict = await Promise.race([
      resolveGate(host),
      new Promise<UpdateOffer | undefined>((resolvePromise) => {
        setTimeout(() => { resolvePromise(undefined) }, GATE_TIMEOUT_MS)
      }),
    ])
    if (verdict === undefined) return false
    blocking = true
    frozenOffer = verdict
    if (canInstallInPlace()) {
      blockLine = onBlock
      onBlock(mandatoryDownloadLine(undefined))
      void blockWithInstaller(host, verdict)
    } else {
      onBlock('这是必须安装的更新,请下载新版本后继续。')
      void blockOnDownloadPage(host, verdict)
    }
    return true
  } catch (error) {
    // An unreachable or malformed feed opens the gate: the red line is
    // enforced on a later launch that can read it.
    host.log(`[updater] launch gate skipped: ${messageOf(error)}\n`)
    return false
  }
}

/**
 * Ask the feed whether this build is below the red line, and return the
 * candidate that verdict is about.
 *
 * The two tiers answer from different authorities and must not be mixed. An
 * in-place build asks the library, and only a candidate the library accepted
 * may block the launch: a feed that names a mandatory build the library
 * refuses for this system or this rollout would otherwise hold the app shut
 * forever, with no installer willing to take it. A build that cannot install in
 * place has no library answer to read, so the download-page tier reads the
 * same v2 manifest itself, through the same parser and the same decision.
 *
 * A library check that failed produced no accepted candidate, so it blocks
 * nothing: the run opens the app and a later launch decides again. The old
 * source is never read in its place.
 * @param host - logging and quit coordination from the main process.
 * @returns the candidate blocking this launch, or undefined when the app may open.
 */
async function resolveGate(host: UpdateHost): Promise<UpdateOffer | undefined> {
  const installed = readInstalledIdentity()
  if (installed === undefined) {
    // No identity means no ordering this build may act on. Locking someone out
    // of their own machine over an unreadable package would be worse than the
    // check the next build performs.
    host.log('[updater] launch gate skipped: this build declares no release identity\n')
    return undefined
  }
  if (canInstallInPlace()) {
    try {
      const offer = await acceptedCheck(host)
      if (offer === undefined || !isBelowRedLine(installed, offer.minimumBuildSequence)) return undefined
      host.log(`[updater] mandatory: ${buildLabel(installed)} is below the feed's ${buildLabel(offer.identity)}\n`)
      return offer
    } catch (error) {
      if (process.platform !== 'darwin') throw error
      // A feed this build refuses is a failed check, not a verdict about this
      // build's ability to install: the tier stays, and the caller reports the
      // failure instead of falling through to the download page.
      if (error instanceof ReleaseIdentityError) throw error
      // A check the retries could not get through says nothing about whether
      // this build can replace itself. It also produced no candidate, and no
      // candidate means no block: the raw manifest is not used to overrule the
      // library the failed check never got an answer from.
      if (classifyDownloadError(error) === 'fatal') demoteMac(host, error)
      return undefined
    }
  }
  const offer = offerFrom(await fetchManifest(`${FEED_MAC}/latest-mac.yml`))
  if (decideUpdate(installed, offer.identity).kind !== 'available') return undefined
  if (!isBelowRedLine(installed, offer.minimumBuildSequence)) return undefined
  host.log(`[updater] mandatory: ${buildLabel(installed)} is below the feed's ${buildLabel(offer.identity)}\n`)
  return offer
}

/**
 * Drop macOS to the download-page tier for the rest of this run and say why.
 * One failure reaches this from both sides — the `error` event and the caller's
 * own catch — so only the first is reported; the rest are the same failure.
 * @param host - logging and quit coordination from the main process.
 * @param error - what the in-place path failed with.
 */
function demoteMac(host: UpdateHost, error: unknown): void {
  if (macInstallUnavailable) return
  macInstallUnavailable = true
  updateState(host).markUnavailable(`in-place update unavailable: ${describeDownloadError(error)}`)
  host.log(`[updater] in-place update unavailable (${messageOf(error)}); this run falls back to the download page\n`)
}

/**
 * Ask the feed for its manifest, repeating a check the network interrupted.
 *
 * A check transfers one small manifest, so an interruption costs a request and
 * the retries are worth spending before anything downgrades: the tier is what a
 * failed check used to cost, and it is not recoverable until the next launch.
 * [[checkInFlight]] is held for the whole plan so the `error` event each failed
 * attempt raises is left to this function's caller, which sees the failure once
 * the retries are spent and classifies it there.
 * @param host - logging and quit coordination from the main process.
 * @param instance - the updater to ask.
 * @returns what electron-updater answered, or null when it answered nothing.
 */
async function checkFeedWithRetry(host: UpdateHost, instance: AppUpdater): Promise<UpdateCheckResult | null> {
  checkInFlight = true
  try {
    return await withRetry(async () => instance.checkForUpdates(), CHECK_RETRY_DELAYS_MS, {
      sleep: async (ms) => { await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, ms) }) },
      onRetry: (attempt, total, delayMs, error) => {
        host.log(`[updater] check interrupted (${describeDownloadError(error)}); retry ${String(attempt)}/${String(total)} in ${String(Math.round(delayMs / 1000))}s\n`)
      },
    })
  } finally {
    checkInFlight = false
  }
}

/**
 * Ask the library what it will offer this build, and take the candidate it
 * accepted out of the check.
 *
 * The library is the only authority on whether this machine may install an
 * update at all: its system check and its rollout check run before the
 * candidate callback, so a `false` here means "nothing for this machine" even
 * when the manifest names a newer build. Nothing in this module re-reads the
 * feed to overrule that answer.
 *
 * The candidate is checked against the manifest the library reports, because a
 * check that says "available" while naming a different build than the one the
 * callback accepted is a disagreement this shell must not resolve by picking
 * one: the download would then fetch bytes no check approved.
 * @param host - logging and quit coordination from the main process.
 * @returns the candidate the library accepted, or undefined when it accepted none.
 * @throws [[ReleaseIdentityError]] for a manifest this build refuses, and any
 * failure the check itself met.
 */
async function acceptedCheck(host: UpdateHost): Promise<UpdateOffer | undefined> {
  sharedCheck ??= runAcceptedCheck(host)
  try {
    return await sharedCheck
  } finally {
    sharedCheck = undefined
  }
}

/**
 * Perform one check and reduce its answer to a candidate.
 * @param host - logging and quit coordination from the main process.
 * @returns the accepted candidate, or undefined when the library offered none.
 * @throws the same failures [[acceptedCheck]] documents.
 */
async function runAcceptedCheck(host: UpdateHost): Promise<UpdateOffer | undefined> {
  const checking = ensureUpdater(host)
  acceptedOffer = undefined
  let result: UpdateCheckResult | null
  try {
    result = await checkFeedWithRetry(host, checking)
  } catch (error) {
    // The candidate belongs to this check alone; leaving it behind would let a
    // later download act on a build this check never reported.
    acceptedOffer = undefined
    throw error
  }
  const accepted = takeAcceptedOffer()
  if (result?.isUpdateAvailable !== true) {
    if (accepted !== undefined) {
      throw new Error('the update library reported no update while its candidate callback accepted one')
    }
    return undefined
  }
  if (accepted === undefined) {
    throw new Error('the update library reported an update without asking this product for a candidate')
  }
  const reported = parseReleaseIdentity(result.updateInfo)
  if (!isSameBuild(accepted.identity, reported)) {
    throw new ReleaseIdentityError(
      'RELEASE_IDENTITY_CONFLICT',
      'dshRelease.buildSequence',
      `the check accepted ${buildLabel(accepted.identity)} but the library reported ${buildLabel(reported)}`,
    )
  }
  return accepted
}

/**
 * Take the candidate the check in flight accepted.
 * @returns the candidate, and the module no longer holds it.
 */
function takeAcceptedOffer(): UpdateOffer | undefined {
  const offer = acceptedOffer
  acceptedOffer = undefined
  return offer
}

/**
 * Transfer one update, absorbing the interruptions a transfer of this size
 * meets on a working connection.
 *
 * Nothing about this is on screen. [[downloading]] is opened and closed here,
 * so the three places that start a download differ only in what they log and
 * what they do with the answer, and the numbers reach the Settings entry
 * through [[updateState]] alone.
 *
 * The transfer runs in two halves. electron-updater's own download goes first
 * and unchanged; each of its attempts is a whole download, since it sends no
 * `Range` header and deletes the partial file on every failure. Only when
 * [[RETRY_DELAYS_MS]] is spent does [[resumeArtifact]] take over the same
 * artifact, keeping what already arrived across as many interruptions as it
 * meets, and hand the finished file back through the updater cache. The offer
 * given here is the one both halves transfer, whatever the feed says later.
 *
 * A transient failure that outlives both halves returns false and demotes
 * nothing — a dropped connection says nothing about whether this build can
 * replace itself, so macOS stays on the in-place tier and the next check
 * starts over. A fatal failure — a signature refusal, a checksum mismatch, any
 * `ERR_UPDATER_*` — is thrown after demoting macOS, which is what drops the
 * caller's check to the download page.
 * @param host - logging and quit coordination from the main process.
 * @param offer - the candidate being transferred.
 * @param run - performs one whole download through electron-updater.
 * @returns true when the download finished.
 */
async function download(host: UpdateHost, offer: UpdateOffer, run: () => Promise<void>): Promise<boolean> {
  // One transfer owns the channel. A second caller can reach here with the same
  // candidate — the launch gate and a check share one library answer — and the
  // bytes already moving are for that same artifact.
  if (downloading) return true
  downloading = true
  try {
    // Decided once per transfer, before the first attempt: the pair describes the
    // build that is running and the candidate is frozen, so neither a retry nor
    // the resumable half may look for a different one.
    const base = await differentialBaseFor(host, offer)
    const instance = ensureUpdater(host)
    // The mandatory launch block takes no fallback: the app is shut until this
    // returns, and a plan that spends minutes resuming would read as a hang
    // where the retry plan's half-minute does not.
    const resume = blocking ? undefined : async (): Promise<boolean> => resumeArtifact(host, offer)
    const outcome = await transferWithFallback({
      run: async (): Promise<void> => { await runWithDifferentialBase(instance, base, run) },
      resume,
      delays: RETRY_DELAYS_MS,
      hooks: {
        sleep: async (ms) => { await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, ms) }) },
        onRetry: (attempt, total, delayMs, error) => {
          host.log(`[updater] download interrupted (${describeDownloadError(error)}); retry ${String(attempt)}/${String(total)} in ${String(Math.round(delayMs / 1000))}s\n`)
        },
        onFallback: (error) => {
          host.log(`[updater] download gave up after ${String(RETRY_DELAYS_MS.length)} retries (${describeDownloadError(error)}); resuming the artifact instead\n`)
        },
      },
    })
    if (outcome !== 'exhausted') return true
    updateState(host).downloadFailed('the transfer could not be completed')
    return false
  } catch (error) {
    const detail = describeDownloadError(error)
    updateState(host).downloadFailed(detail)
    if (classifyDownloadError(error) === 'fatal') {
      host.log(`[updater] download failed: ${detail}\n`)
      if (process.platform === 'darwin') demoteMac(host, error)
      throw error
    }
    host.log(`[updater] download gave up: ${detail}\n`)
    return false
  } finally {
    // One place clears it, for every way out of this function: a transfer that
    // left [[downloading]] set would make every later check, and the Settings
    // entry's own retry, stand down for the rest of the run.
    downloading = false
  }
}

/**
 * Run one library download with, or without, the differential pair this shell
 * verified.
 *
 * The two fields are set immediately before the call and restored after it: the
 * library copies them into the download's own options as `downloadUpdate()`
 * starts, so neither a later attempt nor the resumable half can inherit a pair
 * that belonged to another transfer. Without a pair the library's own
 * derivation is refused outright rather than left to substitute a version
 * string, which is the whole reason [[ensureUpdater]] starts disabled.
 * @param instance - the updater every download of this run goes through.
 * @param base - the verified pair, or undefined for a full download.
 * @param run - performs one library download.
 * @returns when that download settled.
 */
async function runWithDifferentialBase(
  instance: AppUpdater,
  base: PreparedDifferentialBase | undefined,
  run: () => Promise<void>,
): Promise<void> {
  if (base === undefined) {
    await run()
    return
  }
  instance.disableDifferentialDownload = false
  instance.differentialDownloadBase = base
  try {
    await run()
  } finally {
    instance.disableDifferentialDownload = true
    delete instance.differentialDownloadBase
  }
}

/**
 * Find the verified artifact this machine may difference the candidate against.
 *
 * The answer depends on the build running now, never on the version the feed
 * publishes: two builds of one version share it, and the feed's previous build
 * says nothing about what this machine has installed. A refusal is logged and
 * the transfer proceeds in full.
 * @param host - logging and quit coordination from the main process.
 * @param offer - the frozen candidate about to be downloaded.
 * @returns the verified pair, or undefined when this transfer is a full download.
 */
async function differentialBaseFor(host: UpdateHost, offer: UpdateOffer): Promise<PreparedDifferentialBase | undefined> {
  const running = readInstalledIdentity()
  if (running === undefined) return undefined
  const prepared = await prepareDifferentialBase({
    cacheDir: updaterCacheDir(),
    running,
    offer,
    blockMapUrlFor: fileName => feedFileUrl(feedBase(offer.platform), `${fileName}.blockmap`),
  })
  if (prepared.kind === 'prepared') {
    host.log(`[updater] downloading ${buildLabel(offer.identity)} as a difference from ${buildLabel(running)}\n`)
    return prepared.base
  }
  host.log(`[updater] downloading ${buildLabel(offer.identity)} in full: ${prepared.detail}\n`)
  return undefined
}

/**
 * Keep a downloaded, verified artifact for the next transfer to difference
 * against.
 *
 * This is the target build's whole artifact, saved while the build that runs
 * now is still the one being replaced: it becomes usable only after the install
 * lands and the next launch reports that same identity. Failing to keep it
 * costs the next transfer a full download and nothing else, so it is reported
 * and never turned into a download failure.
 * @param host - logging and quit coordination from the main process.
 * @param offer - the candidate that was just verified.
 * @param downloadedFile - the file the library wrote.
 */
async function keepDownloadedBaseline(host: UpdateHost, offer: UpdateOffer, downloadedFile: unknown): Promise<void> {
  if (typeof downloadedFile !== 'string' || downloadedFile === '') return
  const saved = await saveDifferentialBaseline({
    cacheDir: updaterCacheDir(),
    platform: releasePlatform(),
    arch: releaseArch(),
    identity: offer.identity,
    artifact: offer.artifact,
    sourceFile: downloadedFile,
  })
  if (saved.kind === 'failed') {
    host.log(`[updater] ${buildLabel(offer.identity)} is not kept for a later differential download: ${saved.detail}\n`)
    return
  }
  host.log(`[updater] kept ${offer.artifact.fileName} as the baseline for the next differential download\n`)
}

/**
 * Keep the artifact an install just landed from, before its launch sweeps it.
 *
 * The launch after an install is the only moment the artifact the installer
 * read is still on disk: the receipt names the build it installs, and `pending`
 * still holds the file. Saving it here is what makes the very next update
 * differential instead of waiting for another full download to seed the cache.
 * A build installed any other way has no such file, and its first update stays
 * a full download.
 * @param host - logging and quit coordination from the main process.
 * @param receipt - what the install wrote: both identities and the artifact it takes.
 */
function keepInstalledBaseline(host: UpdateHost, receipt: InstallReceipt): void {
  const cacheDir = updaterCacheDir()
  const staged = readStagedArtifact(cacheDir)
  if (staged === undefined) {
    host.log('[updater] no staged artifact remains to keep for a differential download\n')
    return
  }
  if (staged.fileName !== receipt.fileName || staged.sha512 !== receipt.sha512) {
    host.log(`[updater] pending holds ${staged.fileName}, not the installed ${receipt.fileName}; it is left for the next update\n`)
    return
  }
  const sourceFile = join(pendingDir(cacheDir), basename(staged.fileName))
  try {
    const saved = keepInstalledArtifact({
      cacheDir,
      platform: releasePlatform(),
      arch: releaseArch(),
      identity: receipt.target,
      artifact: { fileName: receipt.fileName, sha512: receipt.sha512, size: statSync(sourceFile).size },
      sourceFile,
    })
    if (saved.kind === 'failed') {
      host.log(`[updater] the installed artifact is not kept for a differential download: ${saved.detail}\n`)
      return
    }
    host.log('[updater] kept the installed artifact as the baseline for the next differential download\n')
  } catch (error) {
    // Keeping it is an optimization: the sweep below still decides what pending
    // may lose, and the next update is a full download this time.
    host.log(`[updater] the installed artifact could not be read back (${describeDownloadError(error)})\n`)
  }
}

/**
 * The updater cache directory electron-updater reads a staged update from.
 *
 * Derived the way the library derives it — `<baseCachePath>/<name>` with the
 * name taken from the `app-update.yml` inside the packaged app
 * (`out/AppUpdater.js:545-550`), falling back to the application name exactly
 * as it does — so the two never disagree about where a staged file goes.
 * @returns the absolute cache directory.
 */
export function updaterCacheDir(): string {
  const configured = ((): string | undefined => {
    try {
      const parsed = load(readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8'))
      const name = (parsed as { updaterCacheDirName?: unknown } | null | undefined)?.updaterCacheDirName
      return typeof name === 'string' ? name : undefined
    } catch {
      // No readable app-update.yml: the library falls back to the application
      // name here too, so both still name one directory.
      return undefined
    }
  })()
  return join(appCacheDir(), configured ?? app.getName())
}

/**
 * Transfer the frozen candidate's artifact with the shell's own resumable
 * downloader and stage it where electron-updater takes a cached update from.
 *
 * The transfer is bound to the offer the check accepted — its file name, its
 * base64 sha512 and its size — and reads nothing else: a feed read here could
 * name a build published while this transfer was running, and the bytes would
 * then belong to a candidate no check approved. The `.part` file is keyed by the
 * build's whole identity, so a later build's transfer never continues this
 * one, and every other partial file in the cache root is dropped.
 *
 * The finished bytes are only *staged*: the transfer that owns this plan runs
 * the library again afterwards, and the library is what validates the cache
 * and raises `update-downloaded`. Nothing here declares the update ready.
 * @param host - logging and quit coordination from the main process.
 * @param offer - the candidate being transferred.
 * @returns true when the artifact is staged and worth handing back.
 */
async function resumeArtifact(host: UpdateHost, offer: UpdateOffer): Promise<boolean> {
  const { fileName, sha512, size, isAdminRightsRequired } = offer.artifact
  const base = feedBase(offer.platform)
  try {
    const cacheDir = updaterCacheDir()
    const url = feedFileUrl(base, fileName)
    const partFile = partFileFor(cacheDir, offer.identity, fileName)
    discardStaleParts(cacheDir, partFile)
    host.log(`[updater] resuming ${buildLabel(offer.identity)} (${fileName}) from ${url}\n`)
    const received = await withRetry(async () => resumeDownload({ url, partFile, sha512 }, {
      onProgress: (sample) => { updateState(host).downloadProgress(sample) },
    }), RESUME_RETRY_DELAYS_MS, {
      sleep: async (ms) => { await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, ms) }) },
      onRetry: (attempt, total, delayMs, error) => {
        host.log(`[updater] resume interrupted (${describeDownloadError(error)}); retry ${String(attempt)}/${String(total)} in ${String(Math.round(delayMs / 1000))}s\n`)
      },
    })
    if (received !== size) {
      // The manifest names this artifact's length; bytes of another length are
      // not the frozen artifact, and staging them would hand the library a file
      // the feed never described.
      host.log(`[updater] resume produced ${String(received)} bytes for ${fileName}, the feed says ${String(size)}; discarding it\n`)
      discardPart(partFile)
      return false
    }
    placeInPendingCache({ cacheDir, sourceFile: partFile, fileName, sha512, isAdminRightsRequired })
    discardPart(partFile)
    host.log(`[updater] staged ${fileName} in ${cacheDir}; handing it back to electron-updater\n`)
    return true
  } catch (error) {
    host.log(`[updater] resume did not finish: ${describeDownloadError(error)}\n`)
    return false
  }
}

/**
 * Launch block with an in-place installer: download without asking, then offer
 * the only way forward. A failed download must still leave a way out, so it
 * offers a retry beside quitting — never a state that can neither proceed nor
 * exit. The dialog comes after [[download]] has run its own retries, so the
 * button is offered for a fault that outlasted them rather than for the first
 * dropped packet.
 * @param host - logging and quit coordination from the main process.
 * @param offer - the candidate the gate blocked on.
 */
async function blockWithInstaller(host: UpdateHost, offer: UpdateOffer): Promise<void> {
  const blocked = ensureUpdater(host)
  try {
    updateState(host).downloadStarted(offer.identity.version, offer.releaseNotes, offer.identity.dshRelease.buildSequence)
    if (await download(host, offer, async () => { await blocked.downloadUpdate() })) return
  } catch (error) {
    // [[download]] logged the failure and cleaned up after it; what the
    // blocking path adds is that this one has no tier to fall back to.
    host.log(`[updater] mandatory download cannot proceed: ${describeDownloadError(error)}\n`)
  }
  await retryMandatoryDownload(host, offer, '下载没有完成。')
}

/**
 * The mandatory block's one way out of a download that produced no installable
 * file: download it again, or quit.
 *
 * A transfer that gave up and a file that finished but is not the accepted
 * artifact are the same situation to the person in front of the boot page, so
 * both come here and the block keeps one retry/quit surface. Every retry starts
 * the whole transfer again against the same frozen candidate; nothing here
 * installs, and nothing lets the app open.
 * @param host - logging and quit coordination from the main process.
 * @param offer - the candidate the launch is blocked on.
 * @param detail - what went wrong, in one line.
 */
async function retryMandatoryDownload(host: UpdateHost, offer: UpdateOffer, detail: string): Promise<void> {
  const answer = await ask({
    type: 'error',
    title: '更新下载失败',
    message: '必须安装的更新没有下载成功',
    detail: `${detail}\n检查网络后重试,或退出应用稍后再启动。`,
    buttons: ['重试', '退出应用'],
    defaultId: 0,
    cancelId: 1,
  })
  if (answer === 0) {
    await blockWithInstaller(host, offer)
    return
  }
  app.quit()
}

/**
 * Launch block without an in-place installer: the only paths are downloading
 * the replacement in a browser or quitting.
 * @param host - logging and quit coordination from the main process.
 * @param offer - the candidate the gate blocked on.
 */
async function blockOnDownloadPage(host: UpdateHost, offer: UpdateOffer): Promise<void> {
  const version = offer.identity.version
  const answer = await ask({
    type: 'warning',
    title: `必须更新到 ${version}`,
    message: `当前版本 ${buildLabel(readInstalledIdentity())} 需要更新后才能继续使用`,
    detail: notesDetail(offer.releaseNotes) || `请下载并替换为 ${version}。`,
    buttons: ['去下载', '退出应用'],
    defaultId: 0,
    cancelId: 1,
  })
  if (answer === 0) await openDownloadPage(host, offer)
  app.quit()
}

/**
 * Hand one frozen artifact to the system browser and say what to do with it.
 * The two paths that give up on installing in place end here, so the
 * instructions are written once.
 * @param host - logging and quit coordination from the main process.
 * @param offer - the candidate whose artifact the user downloads by hand.
 */
async function openDownloadPage(host: UpdateHost, offer: UpdateOffer): Promise<void> {
  const target = feedFileUrl(feedBase(offer.platform), offer.artifact.fileName)
  host.log(`[updater] opening ${target}\n`)
  await shell.openExternal(target)
  await ask({
    type: 'info',
    message: '下载完成后替换应用',
    detail: '解压得到的 DSH Desktop.app 拖进「应用程序」覆盖旧版本。'
      + '这些构建没有经过 Apple 公证,替换后第一次打开要右键点图标选「打开」,系统才允许运行。',
    buttons: ['好'],
  })
}

/**
 * Run one update check on whichever tier this build can use, falling back one
 * tier when the in-place path fails part-way through. The fallback re-runs the
 * same check rather than deferring it, so one check still ends in one answer.
 *
 * Every failure that reaches the fallback is reported as the check it was:
 * the answer names the version the feed carries and records the check as
 * failed, which the next check starts over from. Only the tier differs — a
 * fatal failure demotes macOS for the rest of the run, a transient one leaves
 * it able to replace itself — and neither turns the failure into an
 * "already up to date" answer.
 *
 * A download the network alone defeated never reaches this catch: [[download]]
 * absorbs it and ends the check where it stands, because the tier is still the
 * right one and re-running the check on the download-page tier would answer a
 * question nobody asked.
 * @param host - logging and quit coordination from the main process.
 * @param reason - what started this check.
 */
async function runCheck(host: UpdateHost, reason: CheckReason): Promise<void> {
  if (blocking) return
  // What the in-place check failed with when the tier survived that failure,
  // which is what makes the answer below a fallback rather than this build's
  // own tier.
  let fallback: { error: unknown } | undefined
  try {
    if (canInstallInPlace()) {
      try {
        await checkInPlace(host, reason)
        return
      } catch (error) {
        if (process.platform !== 'darwin') throw error
        // A refused identity or manifest is this check's own failure. It says
        // nothing about whether the build can replace itself, so it neither
        // demotes the tier nor becomes a download-page answer: the caller
        // reports the failure as what it was.
        if (error instanceof ReleaseIdentityError) throw error
        // Same rule as the gate: a transient failure that outlived the retries
        // costs this check, which [[checkGeneric]] answers below, not the tier
        // for the rest of the run.
        // A fatal failure also costs the in-place tier, but it is still a check
        // that did not get through: the answer below must report that failure,
        // never read the raw feed as an "up to date" verdict the library never
        // reached.
        if (classifyDownloadError(error) === 'fatal') demoteMac(host, error)
        fallback = { error }
      }
    }
    await checkGeneric(host, reason, fallback)
  } catch (error) {
    updateState(host).checkFailed(new Date().toISOString(), describeDownloadError(error))
    host.log(`[updater] check failed: ${messageOf(error)}\n`)
    if (reason === 'manual') {
      await ask({
        type: 'warning',
        message: '无法检查更新',
        detail: checkFailureDetail(error, '稍后再试,或到发布页手动下载新版本。'),
        buttons: ['好'],
      })
    }
  }
}

/**
 * In-place tier, stage one: compare against the feed. What the check finds
 * decides which of the later stages the user sees, and a check landing on an
 * update already under way leaves it where it is rather than starting over.
 *
 * The library's `isUpdateAvailable` is the only thing that says "there is an
 * update": an `updateInfo` that came back is not an offer, because the
 * library's system check and rollout check may have refused it after the
 * manifest was read. Only a candidate the library accepted — and that this
 * check, not another, put in [[acceptedOffer]] — is downloaded.
 * @param host - logging and quit coordination from the main process.
 * @param reason - what started this check.
 */
async function checkInPlace(host: UpdateHost, reason: CheckReason): Promise<void> {
  const installed = requireInstalledIdentity()
  const checking = ensureUpdater(host)
  const state = updateState(host)
  // A downloaded update and a transfer in flight are both already reported
  // where the update lives — the Settings row's button — so a check on top of
  // either starts nothing and shows nothing, whoever asked for it. It still
  // records when it ran, which the Settings page shows as 上次检查.
  if (downloading || verifyingOffer !== undefined || downloadedOffer !== undefined) {
    const frozen = frozenOffer
    state.checkSucceeded(
      new Date().toISOString(),
      frozen?.identity.version,
      frozen?.releaseNotes,
      frozen?.identity.dshRelease.buildSequence,
    )
    host.log(`[updater] check while ${downloading ? 'a transfer is in flight' : verifyingOffer !== undefined ? 'the downloaded update is being verified' : `${buildLabel(frozen?.identity)} waits to be installed`}\n`)
    return
  }
  state.checkStarted()
  const offer = await acceptedCheck(host)
  if (offer === undefined) {
    // The library accepted nothing: either the feed is not ahead of this build,
    // or the library's own system and rollout checks refused it. Both are "no
    // update", and the feed is not read again to overrule either — a machine
    // the library refuses must not be sent down another install path.
    frozenOffer = undefined
    state.checkSucceeded(new Date().toISOString())
    host.log(`[updater] no update: installed ${buildLabel(installed)}, the feed offers nothing this machine may install\n`)
    if (reason === 'manual') await reportUpToDate()
    return
  }
  frozenOffer = offer
  const version = offer.identity.version
  const notes = offer.releaseNotes
  const build = offer.identity.dshRelease.buildSequence
  state.checkSucceeded(new Date().toISOString(), version, notes, build)
  if (isBelowRedLine(installed, offer.minimumBuildSequence)) {
    // Mid-session mandatory: start immediately, but let the work in progress
    // finish — the next launch is where the gate stops being negotiable.
    host.log(`[updater] mandatory ${buildLabel(offer.identity)}: downloading without asking\n`)
    void ask({
      type: 'warning',
      title: `必须更新到 ${version}`,
      message: '这是必须安装的更新,已开始后台下载',
      detail: notesDetail(notes) || '下载完成后可以立即重启安装,也可以在下次启动时完成。',
      buttons: ['好'],
    })
    state.downloadStarted(version, notes, build)
    await download(host, offer, async () => { await checking.downloadUpdate() })
    return
  }
  // Nothing is asked and nothing is shown: the transfer starts here and the
  // Settings entry is where it becomes visible, once it is installable.
  host.log(`[updater] downloading ${buildLabel(offer.identity)} in the background\n`)
  state.downloadStarted(version, notes, build)
  await download(host, offer, async () => { await checking.downloadUpdate() })
}

/**
 * Build this platform's updater and register its lifetime listeners. The two
 * classes differ only in which feed and which installer they drive:
 * `download-progress`, `error` and `update-downloaded` carry the same payloads
 * from both, so one set of listeners serves both.
 *
 * `autoInstallOnAppQuit` stays off: this app never replaces itself on the way
 * out, only in the seconds after someone clicks 「重启安装」. On macOS the flag
 * has a second effect — it is also what would let Squirrel pre-fetch the staged
 * bundle from electron-updater's local proxy during the download instead of
 * after the click ([[installStaged]] documents what that costs).
 * @param host - logging and quit coordination from the main process.
 * @returns the configured updater.
 */
/** The fields of electron-updater's `update-downloaded` payload this module reads. */
interface DownloadedUpdate {
  /** The build's application version. */
  readonly version?: unknown
  /** The build's release identity. */
  readonly dshRelease?: unknown
  /** The absolute path of the file the library wrote. */
  readonly downloadedFile?: unknown
}

/**
 * Accept the library's finished download only when its bytes are the frozen artifact.
 *
 * The library selects the file it downloads from the manifest's whole list with
 * rules of its own — [[parseUpdateOffer]] mirrors them so a check freezes the
 * same file — but a matching build identity alone does not say which file
 * arrived, because two artifacts of one build can differ. The event names the
 * file the library wrote, and this reads that file back: its name, its length,
 * and its SHA-512 must be the accepted artifact's. Only then does the update
 * become installable, and the candidate is owned from here until the installer
 * takes over.
 * @param host - logging and quit coordination from the main process.
 * @param info - the payload `update-downloaded` carried.
 */
async function acceptDownloaded(host: UpdateHost, info: DownloadedUpdate): Promise<void> {
  // On macOS this is the end of electron-updater's own download, not the end of
  // the install: Squirrel is handed the file at [[installStaged]].
  downloading = false
  const offer = frozenOffer
  const downloaded = ((): ReleaseIdentity | undefined => {
    try {
      return parseReleaseIdentity(info)
    } catch (error) {
      host.log(`[updater] downloaded update carries no usable identity (${messageOf(error)}); not offering it\n`)
      return undefined
    }
  })()
  if (offer === undefined || downloaded === undefined || !isSameBuild(offer.identity, downloaded)) {
    // The bytes on disk belong to a build this channel did not freeze. Making
    // it ready would offer an install of something no check approved, so the
    // transfer is reported as failed and the candidate stays what it was.
    const detail = offer === undefined
      ? 'the download finished for no frozen candidate'
      : `the download finished for ${buildLabel(downloaded)} instead of ${buildLabel(offer.identity)}`
    updateState(host).downloadFailed(detail)
    host.log(`[updater] ${detail}; not offering it for install\n`)
    // Under the mandatory block there is no settings entry to retry from and no
    // window to show the failure in: the boot page would wait forever, so the
    // same retry/quit surface the transfer failures use answers this one.
    if (blocking && offer !== undefined) await retryMandatoryDownload(host, offer, detail)
    return
  }
  if (downloadedOffer !== undefined || verifyingOffer !== undefined) {
    host.log('[updater] the downloaded update is already being verified or waiting to be installed\n')
    return
  }
  // Verification owns the candidate while it runs, and nothing else: an install
  // click in this window must not reach the installer, and a check must not
  // replace the file being read. Only a passed verification makes it
  // installable.
  verifyingOffer = offer
  let problem: string | undefined
  try {
    problem = await downloadedArtifactProblem(offer, info.downloadedFile)
    if (problem === undefined) await keepDownloadedBaseline(host, offer, info.downloadedFile)
  } finally {
    verifyingOffer = undefined
  }
  if (problem !== undefined) {
    updateState(host).downloadFailed(problem)
    host.log(`[updater] ${problem}; not offering it for install\n`)
    if (blocking) await retryMandatoryDownload(host, offer, problem)
    return
  }
  downloadedOffer = offer
  const { version, dshRelease } = offer.identity
  updateState(host).downloadReady(version, offer.releaseNotes, dshRelease.buildSequence)
  host.log(`[updater] downloaded ${buildLabel(offer.identity)}; waiting for an explicit install\n`)
  // The ordinary path stops here: the update is reported, and the click that
  // installs it comes from the Settings entry. Only the mandatory launch block,
  // which owns the app and has no other surface, asks.
  if (blocking) void offerInstall(host, offer)
}

/**
 * The file name the update library caches one published name under.
 * @param fileName - the artifact's name as the feed publishes it.
 * @returns the name the library's own basename produces.
 */
function cachedFileName(fileName: string): string {
  try {
    return decodeURIComponent(fileName)
  } catch {
    // A published name that is not valid percent-encoding stands as it is, and
    // the library's basename of it keeps the same spelling.
    return fileName
  }
}

/**
 * What is wrong with the file the library reported as downloaded, if anything.
 *
 * Name, length, and digest are checked against the frozen artifact rather than
 * against the feed read again: a manifest that changed between the check and
 * the download cannot make different bytes acceptable here.
 * @param offer - the frozen candidate.
 * @param downloadedFile - the path the library reported.
 * @returns the problem in one line, or undefined when the file is the artifact.
 */
async function downloadedArtifactProblem(offer: UpdateOffer, downloadedFile: unknown): Promise<string | undefined> {
  if (typeof downloadedFile !== 'string' || downloadedFile === '') return 'the library reported no downloaded file'
  const name = basename(downloadedFile)
  if (name !== offer.artifact.fileName && name !== cachedFileName(offer.artifact.fileName)) {
    return `the library downloaded ${name} instead of ${offer.artifact.fileName}`
  }
  let size: number
  try {
    size = statSync(downloadedFile).size
  } catch (error) {
    return `the downloaded file cannot be read (${describeDownloadError(error)})`
  }
  if (size !== offer.artifact.size) {
    return `the downloaded file is ${String(size)} bytes, the accepted feed says ${String(offer.artifact.size)}`
  }
  let digest: string
  try {
    digest = await sha512OfFile(downloadedFile)
  } catch (error) {
    return `the downloaded file cannot be read (${describeDownloadError(error)})`
  }
  if (digest !== offer.artifact.sha512) return 'the downloaded file does not match the accepted SHA-512'
  return undefined
}

function ensureUpdater(host: UpdateHost): AppUpdater {
  if (updater !== undefined) return updater
  const built: AppUpdater = process.platform === 'darwin'
    ? new MacUpdater({ provider: 'generic', url: FEED_MAC, channel: FEED_CHANNEL })
    : new NsisUpdater({ provider: 'generic', url: FEED_WIN, channel: FEED_CHANNEL })
  built.autoDownload = false
  built.autoInstallOnAppQuit = false
  // Set after the provider and channel are configured, because those setters
  // may turn downgrade back on. This product never allows one: a lower build
  // sequence is refused by the candidate callback, and a lower runtime is
  // refused no matter how large its sequence is.
  built.allowDowngrade = false
  // A full download until a transfer proves otherwise. The library derives an
  // old artifact's blockmap URL by substituting the version string and takes the
  // old artifact from a fixed name in its own cache, and neither describes two
  // builds of one version: [[runWithDifferentialBase]] switches this off for one
  // transfer at a time, and only with a pair this shell has verified against the
  // build that is running.
  built.disableDifferentialDownload = true
  // The one comparison this product owns. Everything the library checks before
  // it — whether this system supports the update, whether this user is inside
  // the rollout — has already been asked by the time the callback runs, so the
  // callback answers only "is this build ahead of mine", and throws for a
  // manifest this build refuses instead of calling it "no update".
  const installed = readInstalledIdentity()
  if (installed !== undefined) {
    built.isUpdateCandidate = (info) => {
      const offer = offerFrom(info)
      if (decideUpdate(installed, offer.identity).kind === 'current') return false
      acceptedOffer = offer
      return true
    }
  }
  // [[updaterLogLine]] decides which of electron-updater's own lines reach the
  // log and how. `debug` is registered rather than left unset because upstream
  // guards every call on it with `!= null`: an unset channel would drop the two
  // lines [[KEPT_DEBUG_PREFIXES]] keeps along with the rest.
  const write = (channel: UpdaterLogChannel) => (message?: unknown): void => {
    const line = updaterLogLine(channel, message)
    if (line !== null) host.log(line)
  }
  built.logger = { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug') }
  built.on('download-progress', (progress) => {
    updateState(host).downloadProgress(progress)
    // The only surface a transfer writes to, and only while the launch gate
    // holds the app shut: the boot page's own line, rewritten in place. No
    // window, no taskbar or Dock progress, nothing on the ordinary path.
    blockLine?.(mandatoryDownloadLine(updateState(host).snapshot().percent))
  })
  built.on('error', (error) => {
    host.log(`[updater] error: ${error.message}\n`)
    // An install already handed over reports its failure only here: Squirrel's
    // staging and signature check, or the NSIS installer failing to start.
    if (handedOff !== undefined) {
      void installFailed(host, handedOff, error)
      return
    }
    // Between the receipt and the hand-off the install path owns every failure —
    // its own catch restores the app and releases the attempt. Classifying one
    // here as a check or transfer failure would demote the tier under an install
    // that is still in progress, so it is named as belonging to that path.
    if (installing !== undefined) {
      host.log(`[updater] error while preparing to install ${buildLabel(installing.identity)}: ${error.message}\n`)
      return
    }
    // A failure while a download is in flight is delivered twice: here, and to
    // whoever awaited downloadUpdate(). [[download]] owns that one — it decides
    // whether to retry, keeps the progress window for the retry to write to,
    // and demotes only for a failure that installing again cannot fix. Acting
    // on it here would tear both down for a dropped packet.
    if (downloading) return
    // The same ownership for a check: [[checkFeedWithRetry]] is mid-plan and
    // its caller decides once the retries are spent.
    if (checkInFlight) return
    // On macOS this listener is the only place a failure inside Squirrel
    // surfaces — the staging and the install run after the promises this module
    // awaits have already settled.
    if (process.platform === 'darwin') demoteMac(host, error)
  })
  built.on('update-downloaded', (info) => {
    // The payload says which file the library wrote; accepting it takes reading
    // that file back, which is not a step this listener can wait for. A read
    // that rejects is the transfer's failure, never a candidate: no installer
    // may be reached from an update whose bytes were not verified.
    void acceptDownloaded(host, info).catch((error: unknown) => {
      verifyingOffer = undefined
      downloading = false
      const detail = `could not verify the downloaded update (${describeDownloadError(error)})`
      updateState(host).downloadFailed(detail)
      host.log(`[updater] ${detail}; not offering it\n`)
      // A rejection escaped the verification itself; under the mandatory block
      // it must still reach the retry/quit surface rather than leave the boot
      // page waiting on an install that will never come.
      const offer = frozenOffer
      if (blocking && offer !== undefined) void retryMandatoryDownload(host, offer, detail)
    })
  })
  updater = built
  return built
}

/**
 * What the install click leads to, which is not the same experience on the two
 * platforms and is the one thing the dialog must not get wrong.
 *
 * Windows hands over to the NSIS installer, which paints its own progress bar
 * within a second. macOS hands over to Squirrel, and the click is answered by
 * nothing for around fifteen seconds: about five to stop the server, fetch the
 * staged zip back from electron-updater's local proxy, unpack it and validate
 * its signature, then the rest with a bare screen while ShipIt swaps the
 * bundles — it cannot start until every process of this bundle id has exited,
 * so nothing of this app can be on screen to say so. Measured 14, 16 and 18
 * seconds on an idle machine and 42 with the disk saturated, which is why the
 * wording promises a range and admits it can be longer. Saying it at all is the
 * only defence: a force-quit during those seconds lands exactly in the window
 * where the bundle is half replaced.
 */
const INSTALL_PROMISE = process.platform === 'darwin'
  ? '点击后应用会关闭,安装通常要 15 秒上下(机器忙时更久),期间屏幕可能一直没有反应;完成后会自动重新打开,你的会话记录都在。'
  : '点击后应用会关闭并显示安装进度,完成后自动重新打开;你的会话记录都在。'

/**
 * The mandatory launch block's last dialog: the update is on disk, the app is
 * shut until it is installed, and the one button says so. Nothing else opens
 * this — the ordinary path reports the downloaded update and waits for a click
 * that reaches [[installStaged]] directly.
 * @param host - logging and quit coordination from the main process.
 * @param offer - the downloaded candidate.
 */
async function offerInstall(host: UpdateHost, offer: UpdateOffer): Promise<void> {
  const version = offer.identity.version
  const notes = notesDetail(offer.releaseNotes)
  const detail = notes === ''
    ? `当前版本 ${buildLabel(readInstalledIdentity())},安装后为 ${buildLabel(offer.identity)}。\n\n${INSTALL_PROMISE}`
    : `更新内容:\n${notes}\n\n${INSTALL_PROMISE}`
  const answer = await ask({
    type: 'info',
    title: '新版本已下载完毕',
    message: `v${version} 已下载完毕。重启安装后即可继续使用。`,
    detail,
    buttons: ['重启安装'],
    defaultId: 0,
    cancelId: 0,
  })
  if (answer !== 0) {
    host.log(`[updater] ${version} stays downloaded; it installs when the user says so\n`)
    return
  }
  await installStaged(host, offer)
}

/**
 * Record the install about to start, so the launch after it can tell whether
 * that install landed and, if it did, which artifact to take out of `pending`
 * ([[sweepAfterInstall]]).
 *
 * The receipt names both builds and the artifact's bytes. Version order is not
 * recorded because it is not evidence: a launch that reports a higher version
 * can be a build the user installed another way, and a bridge build lowers the
 * application version while it is the newer build.
 * @param host - logging from the main process.
 * @param offer - the candidate being handed to the installer.
 * @returns whether the receipt reached the disk; false means the hand-off must
 * not start, because the launch after it could never recognize the install.
 */
function rememberInstall(host: UpdateHost, offer: UpdateOffer): boolean {
  const installed = readInstalledIdentity()
  if (installed === undefined) {
    host.log('[updater] not handing the install over: this build declares no release identity to record\n')
    return false
  }
  const receipt: InstallReceipt = {
    schemaVersion: 2,
    from: installed,
    target: offer.identity,
    fileName: offer.artifact.fileName,
    sha512: offer.artifact.sha512,
  }
  if (!setInstalledUpdateV2(receipt)) {
    host.log('[updater] not handing the install over: the install receipt could not be written\n')
    return false
  }
  return true
}

/**
 * Remove the artifact an earlier launch installed from electron-updater's
 * `pending` directory, which the library itself leaves there until the next
 * update's download starts ([[sweepInstalledBuildPending]] decides what may go).
 *
 * The running build's own identity decides what the last install did: the
 * receipt's target means it landed and its artifact may go; the receipt's
 * `from` means it did not and the artifact is still the update this machine has
 * yet to take; any other build leaves the outcome unknown, and unknown is never
 * cleaned up as if it had succeeded. A legacy `installedUpdate` record names no
 * target, so it is not read here at all rather than guessed from version order.
 * @param host - logging from the main process.
 */
function sweepAfterInstall(host: UpdateHost): void {
  const receipt = readState().installedUpdateV2
  if (receipt === undefined) return
  const running = readInstalledIdentity()
  if (running === undefined) {
    host.log('[updater] keeping the last install receipt: this build declares no release identity to confirm it against\n')
    return
  }
  // Before the sweep, which is the only thing that removes the file it reads.
  if (isSameBuild(running, receipt.target)) keepInstalledBaseline(host, receipt)
  let sweep: InstalledBuildSweep
  try {
    sweep = sweepInstalledBuildPending(updaterCacheDir(), receipt, running)
  } catch (error) {
    host.log(`[updater] could not sweep ${receipt.fileName} from pending: ${describeDownloadError(error)}\n`)
    return
  }
  switch (sweep.kind) {
    case 'not-landed':
      host.log(`[updater] ${buildLabel(receipt.target)} has not been installed yet; its artifact stays in pending\n`)
      return
    case 'unconfirmed': {
      const detail = `this is ${buildLabel(running)}, neither the build that started the install (${buildLabel(receipt.from)}) nor its target (${buildLabel(receipt.target)})`
      host.log(`[updater] the last install is unconfirmed: ${detail}; nothing is removed\n`)
      return
    }
    case 'incomplete':
      host.log(`[updater] removed ${sweep.removed.join(', ') || 'nothing'} from pending; ${sweep.failed.join(', ')} remain until the next launch\n`)
      return
    case 'emptied':
      host.log(`[updater] removed the installed ${receipt.fileName} from pending (${sweep.removed.join(', ')})\n`)
      forgetInstall(host)
      return
    case 'absent':
    case 'replaced':
      forgetInstall(host)
      return
    default: {
      const unreachable: never = sweep
      throw new Error(`unhandled pending sweep: ${JSON.stringify(unreachable)}`)
    }
  }
}

/**
 * Forget the install receipt the launch after an install has finished with.
 * @param host - logging from the main process.
 */
function forgetInstall(host: UpdateHost): void {
  if (!setInstalledUpdateV2(undefined)) {
    host.log('[updater] could not clear the install receipt; the next launch will report the install again\n')
  }
}

/**
 * Give up an install that was never handed to the installer, and give the app
 * back.
 *
 * Nothing was installed, so the downloaded candidate is kept — the Settings
 * entry's retry takes it again — and no success is claimed anywhere. A failure
 * that came after the teardown also undoes that teardown: the receipt is
 * cleared because no installer ever read it, the notice comes down, and the
 * host restarts what the stop closed.
 * @param host - logging and quit coordination from the main process.
 * @param offer - the candidate the install was about.
 * @param why - what stopped the hand-off, in one line.
 * @param stopped - whether [[UpdateHost.prepareQuit]] had already run.
 */
async function installNotStarted(host: UpdateHost, offer: UpdateOffer, why: string, stopped: boolean): Promise<void> {
  const version = offer.identity.version
  host.log(`[updater] not handing ${version} to the installer: ${why}; the downloaded update is kept for a retry\n`)
  if (stopped) {
    if (!setInstalledUpdateV2(undefined)) {
      host.log('[updater] could not clear the install receipt for the install that never started\n')
    }
    closeInstalling()
    await host.resumeAfterFailedInstall(blocking)
  }
  // The attempt has finished putting the app back, and only now may another one
  // begin: releasing the install lock while the recovery is still running would
  // let a queued click race the restore it depends on.
  installing = undefined
  // The verified artifact is untouched, so the phase goes back to `ready`: the
  // install can be tried again from the same button, and replacement is barred
  // by [[downloadedOffer]] rather than by the reported phase.
  updateState(host).downloadReady(version, offer.releaseNotes, offer.identity.dshRelease.buildSequence)
  const answer = await ask({
    type: 'error',
    title: '更新安装未开始',
    message: `v${version} 没有开始安装`,
    detail: stopped
      ? '重启安装前没能确认后台服务已经停止,应用会继续运行。已下载的更新还在,稍后可以重试。'
      : '安装前的记录没有写成,应用会继续运行。已下载的更新还在,稍后可以重试。',
    buttons: blocking ? ['重试', '退出应用'] : ['好'],
    defaultId: 0,
    cancelId: blocking ? 1 : 0,
  })
  if (!blocking) return
  if (answer === 0) {
    await installStaged(host, offer)
    return
  }
  app.quit()
}

/**
 * Replace the application with the update already on disk.
 *
 * **No dialog stands between this and the click that reached it.** The button in
 * the Settings window is the decision, and the seconds that follow are the
 * install itself: the server goes down, macOS puts up the standing notice
 * because Squirrel takes the screen for around fifteen seconds, and Windows
 * hands over to an NSIS installer that paints its own progress within a second.
 *
 * The receipt goes to disk first: it is the only record the launch after the
 * install can recognize it by, so an install it cannot be written for does not
 * start at all — no installer is called and the downloaded candidate stays.
 * @param host - logging and quit coordination from the main process.
 * @param offer - the downloaded candidate.
 */
async function installStaged(host: UpdateHost, offer: UpdateOffer): Promise<void> {
  if (installing !== undefined) {
    // The settings entry and a boot-page dialog can both reach the click, and a
    // second receipt or teardown would tear down what the first is doing.
    host.log(`[updater] an install of ${buildLabel(installing.identity)} is already under way; leaving it to finish\n`)
    return
  }
  installing = offer
  const version = offer.identity.version
  if (!rememberInstall(host, offer)) {
    await installNotStarted(host, offer, 'the install receipt could not be recorded', false)
    return
  }
  if (process.platform === 'darwin') {
    // Put the notice up before the teardown, so nothing about the next fifteen
    // seconds is left to be guessed at. The main window goes with the server it
    // is showing: leaving it up would leave a dead page on screen for the whole
    // install. Windows gets neither, because the installer's own window is up
    // within a second of the same click.
    mainWindow()?.hide()
    showInstalling(version)
  }
  host.log(`[updater] stopping the server before installing ${version}\n`)
  try {
    await host.prepareQuit()
  } catch (error) {
    // The teardown did not confirm that the server tree is gone, so an installer
    // that replaces the app directory must not start: the refusal from the main
    // process is the whole answer, and the install-failure path restores what
    // the stop closed.
    await installNotStarted(host, offer, `teardown not confirmed, the installer was not started (${describeDownloadError(error)})`, true)
    return
  }
  if (process.platform === 'darwin') {
    // MacUpdater.quitAndInstall takes no arguments — it declares the two the
    // base class has and ignores both. It returns immediately, and what follows
    // is Squirrel's: fetch the staged zip from the local proxy electron-updater
    // is still serving, unpack it, check it against this app's designated
    // requirement, then run ShipIt, which waits for this process to exit before
    // it swaps the bundles. The relaunch is Squirrel's `open`, so the new
    // process inherits neither this one's argv nor its environment.
    host.log(`[updater] handing ${version} to Squirrel\n`)
    handedOff = offer
    updater?.quitAndInstall()
    return
  }
  // (isSilent, isForceRunAfter) → the installer's `/S` and `--force-run`.
  //
  // isSilent is false on purpose: an install that shows nothing is
  // indistinguishable from one that failed, and the one surface a silent NSIS
  // run does still put on screen is its error box — `handleUninstallResult`'s
  // MessageBox carries no `/SD`, so 「Failed to uninstall old application
  // files…」 appears even under `/S`, arriving out of nowhere with no window
  // that could explain it. Visible does not mean a wizard here: the directory
  // page skips itself for an `--updated` run (`skipPageIfUpdated`, the
  // template's own macro), `build/installer.nsh` skips the finish page the same
  // way, and MUI's own `SetAutoClose true` closes the progress window when the
  // section ends — what is left is one progress bar that needs no click.
  //
  // isForceRunAfter is passed for the shape of the call rather than its effect:
  // `quitAndInstall` forwards it only when isSilent is true and substitutes
  // `autoRunAppAfterInstall` (default true) otherwise (`BaseUpdater.js`), and
  // the template's own relaunch is `${if} ${isForceRun} ${andIf} ${Silent}`
  // (`installSection.nsh`), which a visible run never satisfies whatever is
  // passed. The relaunch is therefore done by `customFinishPage`, which starts
  // the app through `ExecShellAsUser` so it drops the installer's elevated
  // token.
  //
  // `$INSTDIR` comes from the registry's InstallLocation, read in `.onInit`
  // before any page exists, so neither mode can land anywhere but the directory
  // the app already occupies.
  handedOff = offer
  updater?.quitAndInstall(false, true)
}

/**
 * The candidate handed to the installer, from the hand-off until the installer
 * fails. Set only once the server is stopped and the window hidden, so an
 * `error` while it is set belongs to the install.
 */
let handedOff: UpdateOffer | undefined

/**
 * Recover from an installer that failed after the hand-off. The app is still
 * running with its server stopped and, on macOS, its window hidden behind the
 * install notice; without this it stays that way with nothing the user can
 * reach. The notice comes down, the update entry shows the failure through
 * [[UpdateState.markUnavailable]] — on macOS through [[demoteMac]], which also
 * drops the run to the download page — and the host brings the app back.
 * Under the mandatory block the app stays closed and the only choices are
 * installing again or quitting.
 * @param host - logging and quit coordination from the main process.
 * @param offer - the candidate whose install failed.
 * @param error - what the installer reported.
 */
async function installFailed(host: UpdateHost, offer: UpdateOffer, error: unknown): Promise<void> {
  handedOff = undefined
  const version = offer.identity.version
  host.log(`[updater] installing ${version} failed (${messageOf(error)}); bringing the app back\n`)
  closeInstalling()
  if (process.platform === 'darwin') demoteMac(host, error)
  else updateState(host).markUnavailable(`install failed: ${messageOf(error)}`)
  await host.resumeAfterFailedInstall(blocking)
  // The failed attempt owns the install until the app is back; the retry below
  // (and the settings entry before it) starts a new one.
  installing = undefined
  if (!blocking) return
  const answer = await ask({
    type: 'error',
    title: '更新安装失败',
    message: `v${version} 没有安装成功`,
    detail: '可以重试安装,或退出应用稍后再启动。',
    buttons: ['重试', '退出应用'],
    defaultId: 0,
    cancelId: 1,
  })
  if (answer === 0) {
    await installStaged(host, offer)
    return
  }
  app.quit()
}

/**
 * The download-page tier: read the v2 manifest directly and, when it is ahead,
 * open the download in the system browser. This is where an unsigned macOS
 * build lives — it can see a new build but not replace itself with one — and
 * where a signed build lands once its in-place path is gone for the run. The
 * dialog is confined to the menu item and to the feed's red line: nothing else
 * interrupts a session with a download this build cannot install anyway, and
 * what it found is reported through [[updateState]] instead.
 *
 * This tier has no library, so the manifest is read here; it is parsed and
 * decided by the same functions the library path uses. It is never reached by a
 * library that *refused* a candidate — a refusal is answered as "no update" on
 * the in-place tier — so it cannot be used to overrule the library's system or
 * rollout check.
 *
 * A check whose in-place path was merely interrupted is answered here as well,
 * and that answer stops short of the download page: the build can still
 * install where it stands, so a click is told the check did not get through
 * and a silent check says nothing, the red line included.
 * @param host - logging and quit coordination from the main process.
 * @param reason - what started this check.
 * @param fallback - what the in-place check failed with when this call is
 * answering for a tier that survived that failure; undefined when the download
 * page is this build's own tier.
 */
async function checkGeneric(host: UpdateHost, reason: CheckReason, fallback?: { error: unknown }): Promise<void> {
  const installed = requireInstalledIdentity()
  if (releasePlatform() !== 'darwin') {
    throw new ReleaseIdentityError(
      'RELEASE_IDENTITY_INVALID',
      'platform',
      `the download page serves macOS builds only, this is ${process.platform}`,
    )
  }
  const state = updateState(host)
  state.checkStarted()
  const offer = offerFrom(await fetchManifest(`${FEED_MAC}/latest-mac.yml`))
  const version = offer.identity.version
  const build = offer.identity.dshRelease.buildSequence
  const ahead = decideUpdate(installed, offer.identity).kind === 'available'
  const notes = ahead ? offer.releaseNotes : undefined
  state.checkSucceeded(new Date().toISOString(), ahead ? version : undefined, notes, ahead ? build : undefined)
  if (fallback !== undefined) {
    // A fallback answer for an in-place check that did not get through. What is
    // reported is that failure — which the next check starts over from — rather
    // than a verdict about this build. That holds even when the feed read here
    // names the installed build: the native check never finished, so this is a
    // failure to report, never "already up to date".
    const fallbackReason = describeDownloadError(fallback.error)
    host.log(`[updater] ${ahead ? `${buildLabel(offer.identity)} was read straight from the feed` : `installed ${buildLabel(installed)} is what the feed names`}; the in-place check did not get through (${fallbackReason})\n`)
    state.checkFailed(new Date().toISOString(), fallbackReason)
    // The answer stops here rather than continuing into the download page: a
    // machine that can install where it stands must not be sent to replace its
    // own application by hand over a check that will be tried again. A click
    // is answered with the failure it met, and the feed's red line is left to
    // the launch gate and to the next in-place check, which are what enforce
    // it.
    if (reason === 'manual') {
      await ask({
        type: 'warning',
        message: '无法检查更新',
        detail: checkFailureDetail(fallback.error, ahead ? '稍后会自动重试,新版本已记录在设置里。' : '稍后会自动重试。'),
        buttons: ['好'],
      })
    } else if (isBelowRedLine(installed, offer.minimumBuildSequence)) {
      host.log(`[updater] mandatory ${buildLabel(offer.identity)}: the in-place check did not get through; the launch gate and the next check are what enforce it\n`)
    }
    return
  }
  if (!ahead) {
    host.log(`[updater] no update: installed ${buildLabel(installed)}, feed ${buildLabel(offer.identity)}\n`)
    if (reason === 'manual') await reportUpToDate()
    return
  }
  // This build's own tier: replacing the app by hand is the only way this build
  // gets installed, for the rest of the run. No candidate is frozen: this tier
  // downloads nothing, and the artifact its dialog offers is passed to it
  // directly rather than left behind as an installable update.
  state.markUnavailable('this build installs an update by replacing it by hand')
  const mandatory = isBelowRedLine(installed, offer.minimumBuildSequence)
  if (reason !== 'manual' && !mandatory) {
    host.log(`[updater] ${buildLabel(offer.identity)} is available; not interrupting the session\n`)
    return
  }
  const answer = await ask({
    type: mandatory ? 'warning' : 'info',
    title: mandatory ? `必须更新到 ${version}` : `发现新版本 ${version}`,
    message: mandatory
      ? `当前版本 ${buildLabel(installed)} 需要更新后才能继续使用`
      : `发现新版本 ${buildLabel(offer.identity)}`,
    detail: notesDetail(notes)
      || (mandatory ? '下次启动时需要完成更新才能进入应用。' : `当前版本 ${buildLabel(installed)}。`),
    buttons: ['去下载', '稍后'],
    defaultId: 0,
    cancelId: 1,
  })
  if (answer !== 0) {
    host.log(`[updater] user postponed ${version}\n`)
    return
  }
  await openDownloadPage(host, offer)
}

/** Confirm to a manual checker that the installed build is current. */
async function reportUpToDate(): Promise<void> {
  await ask({
    type: 'info',
    message: '已是最新版本',
    detail: `当前版本 ${buildLabel(readInstalledIdentity())}。`,
    buttons: ['好'],
  })
}

/**
 * Install the application menu. The standard roles carry the editing and
 * window shortcuts a browser surface needs (copy, paste, zoom, reload), each
 * with a label of its own; the help submenu holds what the app can be asked
 * for directly.
 * @param onCheck - runs the manual update check.
 * @param onOpenLog - opens the server log file.
 */
function buildMenu(onCheck: () => void, onOpenLog: () => void): void {
  const text = menuText()
  const onAbout = (): void => { void showAbout(text.about) }
  const appName = app.getName()
  const first: MenuItemConstructorOptions = process.platform === 'darwin'
    ? {
      label: appName,
      submenu: [
        { label: `${text.about} ${appName}`, click: onAbout },
        { type: 'separator' },
        { role: 'services', label: text.services },
        { type: 'separator' },
        { role: 'hide', label: `${text.hide} ${appName}` },
        { role: 'hideOthers', label: text.hideOthers },
        { role: 'unhide', label: text.unhide },
        { type: 'separator' },
        { role: 'quit', label: `${text.quit} ${appName}` },
      ],
    }
    : { label: text.file, submenu: [{ role: 'quit', label: text.quit }] }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    first,
    {
      label: text.edit,
      submenu: [
        { role: 'undo', label: text.undo },
        { role: 'redo', label: text.redo },
        { type: 'separator' },
        { role: 'cut', label: text.cut },
        { role: 'copy', label: text.copy },
        { role: 'paste', label: text.paste },
        { role: 'selectAll', label: text.selectAll },
      ],
    },
    {
      label: text.view,
      submenu: [
        { role: 'reload', label: text.reload },
        { role: 'forceReload', label: text.forceReload },
        { role: 'toggleDevTools', label: text.devTools },
        { type: 'separator' },
        { role: 'resetZoom', label: text.resetZoom },
        { role: 'zoomIn', label: text.zoomIn },
        { role: 'zoomOut', label: text.zoomOut },
        { type: 'separator' },
        { role: 'togglefullscreen', label: text.fullscreen },
      ],
    },
    {
      label: text.window,
      submenu: process.platform === 'darwin'
        ? [
          { role: 'minimize', label: text.minimize },
          { role: 'zoom', label: text.fullscreen },
          { type: 'separator' },
          { role: 'front', label: text.front },
        ]
        : [
          { role: 'minimize', label: text.minimize },
          { role: 'close', label: text.close },
        ],
    },
    {
      role: 'help',
      label: text.help,
      submenu: [
        { label: text.checkUpdate, click: onCheck },
        { label: text.openLog, click: onOpenLog },
        { label: text.reportIssue, click: () => { void shell.openExternal(ISSUE_NEW_URL) } },
        { type: 'separator' },
        { label: text.about, click: onAbout },
      ],
    },
  ]))
}

/**
 * The About dialog: what this is, which build, and where its updates come from.
 *
 * The label carries the build sequence, because the application version alone
 * cannot tell two builds of one upstream version apart; the revision is the
 * full Git object name the release manifest records, which is what makes a
 * report traceable back to source.
 * @param title - the localized word for "about", used as the dialog title.
 */
async function showAbout(title: string): Promise<void> {
  const identity = readInstalledIdentity()
  const build = identity === undefined
    ? '当前构建没有内嵌发布身份,更新检查不可用。'
    : `构建 ${String(identity.dshRelease.buildSequence)},revision ${identity.dshRelease.revision}。`
  await ask({
    type: 'info',
    title,
    message: `${app.getName()} ${buildLabel(identity)}`,
    detail: `DeepSeek Harness 的桌面客户端,内置 dsh web 服务。\n${build}\n更新来自 ${FEED_BASE}。`,
    buttons: ['好'],
  })
}
