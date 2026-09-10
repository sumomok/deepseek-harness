/**
 * What the update channel is doing, as one value the Settings entry can read.
 *
 * The desktop update flow puts nothing on screen while it works: a check runs
 * silently, the transfer runs in the background, and the only visible moment is
 * the one where an installable update is waiting. That moment has to be
 * reportable, so every step of the channel writes into this machine and
 * [[startUpdateService]] hands out the snapshot.
 *
 * Nothing here touches electron, so `tests/update-state.spec.ts` exercises every
 * transition directly.
 * @module @deepseek-ai/dsh-desktop-shell/update-state
 */

/**
 * Where the channel stands.
 *
 * - `idle` — nothing in flight. `latestVersion` names what the last check saw.
 * - `checking` — a manifest read is in flight.
 * - `downloading` — an artifact is transferring; the byte fields are current.
 * - `ready` — an update is downloaded and verified, waiting for the click that
 *   installs it. This is the only phase in which anything prominent is shown.
 * - `failed` — the update did not get through, and `reason` names why. That
 *   covers a check or transfer the network defeated, which the next check
 *   starts over, and a build that cannot install an update at all
 *   ([[UpdateState.markUnavailable]]), which nothing this run changes.
 *
 * These five are the whole set the shell reports. A reader that also has a
 * state for "this deployment has no update channel" owns that value itself: the
 * shell only ever answers for a channel it has.
 */
export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'failed'

/**
 * One `download-progress` sample, in the units electron-updater's event reports.
 */
export interface TransferSample {
  /** Completion from 0 to 100. */
  percent: number
  /** Bytes received so far. */
  transferred: number
  /** Total bytes of the artifact. */
  total: number
}

/**
 * The whole state of the channel, as the update service serializes it.
 *
 * Every optional field is omitted rather than sent as null when it does not
 * apply, so a reader tells "no value" from "value zero" by presence.
 */
export interface UpdateSnapshot {
  /** Where the channel stands. */
  phase: UpdatePhase
  /** The running build's version. */
  currentVersion: string
  /** The version the last check saw, when it saw one ahead of the running build. */
  latestVersion?: string
  /** Release notes the manifest carries for [[latestVersion]], passed through as the feed wrote them. */
  releaseNotes?: string
  /** Transfer completion from 0 to 100; present only while `downloading`. */
  percent?: number
  /** Bytes transferred so far; present only while `downloading`. */
  transferredBytes?: number
  /** Total bytes of the artifact; present only while `downloading` and once the transfer knows it. */
  totalBytes?: number
  /**
   * What the failure was; present only when `failed`. One line in the shell's
   * own words — a code such as `ECONNRESET` where the failure carried one —
   * rather than localized copy.
   */
  reason?: string
  /** ISO 8601 timestamp of the last completed check, successful or not. */
  checkedAt?: string
}

/**
 * The channel's state, written by the updater's events and read by the loopback
 * service.
 *
 * Two phases are protective rather than merely descriptive:
 *
 * - `ready` survives every later check. An update that is downloaded and
 *   verified stays offered until it is installed, so a scheduled check that
 *   finds the same version does not take the offer back off the screen.
 * - the `failed` [[markUnavailable]] sets is final for the run. It is reached
 *   when this build cannot install what it downloads — a source-tree launch, or
 *   a macOS bundle whose in-place path failed — and nothing after that is worth
 *   reporting as progress towards an install that cannot happen.
 */
export class UpdateState {
  /** Where the channel stands. */
  private phase: UpdatePhase = 'idle'

  /** The version the last check saw ahead of the running build. */
  private latestVersion: string | undefined

  /** Release notes for [[latestVersion]]. */
  private releaseNotes: string | undefined

  /** The last transfer sample, kept only while `downloading`. */
  private sample: TransferSample | undefined

  /** What the last failure or the demotion was. */
  private reason: string | undefined

  /** ISO 8601 timestamp of the last completed check. */
  private checkedAt: string | undefined

  /**
   * Whether the channel has reported a failure nothing this run can move it off
   * of, which is what [[markUnavailable]] sets.
   */
  private final = false

  /**
   * @param currentVersion - the running build's version, which never changes
   * while the process lives.
   */
  constructor(private readonly currentVersion: string) {}

  /**
   * The whole state, as the service answers it.
   * @returns a fresh snapshot; nothing in it aliases this machine's own fields.
   */
  snapshot(): UpdateSnapshot {
    return {
      phase: this.phase,
      currentVersion: this.currentVersion,
      ...this.latestVersion === undefined ? {} : { latestVersion: this.latestVersion },
      ...this.releaseNotes === undefined ? {} : { releaseNotes: this.releaseNotes },
      ...this.sample === undefined ? {} : {
        percent: this.sample.percent,
        transferredBytes: this.sample.transferred,
        ...this.sample.total > 0 ? { totalBytes: this.sample.total } : {},
      },
      ...this.reason === undefined ? {} : { reason: this.reason },
      ...this.checkedAt === undefined ? {} : { checkedAt: this.checkedAt },
    }
  }

  /** Whether an installed update is waiting for the click that applies it. */
  isReady(): boolean {
    return this.phase === 'ready'
  }

  /** A manifest read has started. */
  checkStarted(): void {
    if (this.final || this.phase === 'downloading' || this.phase === 'ready') return
    this.phase = 'checking'
    this.reason = undefined
  }

  /**
   * A manifest read finished.
   *
   * A check that lands while an artifact is transferring or waiting to be
   * installed records only when it happened: the version those two phases name
   * is the one they are working on, and replacing it with whatever the feed
   * says at that moment would leave a snapshot whose phase and version
   * disagree. What the feed offers is still recorded on a build that cannot
   * install it, because reporting the version is the whole of what that build
   * can do about it.
   * @param at - ISO 8601 timestamp of the answer.
   * @param version - the version the feed offers when it is ahead of the
   * running build, and undefined when the running build is current.
   * @param notes - release notes the manifest carries for that version.
   */
  checkSucceeded(at: string, version?: string, notes?: string): void {
    this.checkedAt = at
    if (this.phase === 'ready' || this.phase === 'downloading') return
    this.latestVersion = version
    this.releaseNotes = notes
    if (this.phase === 'checking') this.phase = 'idle'
  }

  /**
   * A manifest read did not get through.
   * @param at - ISO 8601 timestamp of the failure.
   * @param reason - what it failed with, in one line.
   */
  checkFailed(at: string, reason: string): void {
    if (this.final || this.phase === 'ready') return
    this.checkedAt = at
    this.phase = 'failed'
    this.reason = reason
  }

  /**
   * An artifact transfer has started.
   * @param version - the version being transferred.
   * @param notes - release notes the manifest carries for it.
   */
  downloadStarted(version: string, notes?: string): void {
    if (this.final || this.phase === 'ready') return
    this.phase = 'downloading'
    this.latestVersion = version
    this.releaseNotes = notes
    this.reason = undefined
    this.sample = { percent: 0, transferred: 0, total: 0 }
  }

  /**
   * One transfer sample. Samples that arrive outside a transfer are dropped:
   * electron-updater keeps emitting them while its own promise settles, and a
   * snapshot showing bytes for a finished download would contradict its phase.
   * @param sample - the sample the transfer reported.
   */
  downloadProgress(sample: TransferSample): void {
    if (this.phase !== 'downloading') return
    this.sample = sample
  }

  /**
   * The transfer finished and its checksum matched the manifest.
   * @param version - the downloaded version.
   * @param notes - release notes the manifest carries for it.
   */
  downloadReady(version: string, notes?: string): void {
    if (this.final) return
    this.phase = 'ready'
    this.latestVersion = version
    this.releaseNotes = notes
    this.reason = undefined
    this.sample = undefined
  }

  /**
   * The transfer did not get through.
   * @param reason - what it failed with, in one line.
   */
  downloadFailed(reason: string): void {
    if (this.phase !== 'downloading') return
    this.phase = 'failed'
    this.reason = reason
    this.sample = undefined
  }

  /**
   * This build cannot install an update where it stands, for the rest of the
   * run: a source-tree launch, or a macOS bundle whose in-place path failed.
   *
   * Reported as `failed` with the reason, because that is the phase a reader
   * has for "the update did not get through", and nothing later this run moves
   * it — unlike an ordinary failure, which the next check starts over from.
   * @param reason - why, in one line.
   */
  markUnavailable(reason: string): void {
    if (this.final) return
    this.final = true
    this.phase = 'failed'
    this.reason = reason
    this.sample = undefined
  }
}
