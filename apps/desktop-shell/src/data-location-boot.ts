/**
 * The launch step that settles where the Harness home is before anything
 * reads it, and exports it as `DSH_HOME` so the server child inherits the same
 * value.
 *
 * It runs in two parts. {@link exportPointerHome} runs synchronously before
 * the boot window opens: it exports the pointer's directory, so the theme read
 * that paints the window reads the right home, and it records the `DSH_HOME`
 * the process was launched with before that value is overwritten.
 * {@link settleDataLocation} runs on the boot page before the first launch step
 * that reads the home. It asks the login shell or the Windows user environment
 * for an explicit `DSH_HOME` (only when a pointer exists, so an installation
 * that never moved its data behaves exactly as before), decides with
 * [[@deepseek-ai/dsh-desktop-shell/data-location]], asks the person whenever
 * the decision needs them, and finally keeps `~/.dsh` pointing at the data.
 *
 * The person is asked through the host, which in the app is a message box over
 * the boot window: the boot page is a `data:` document with no preload and no
 * IPC, so it can show a sentence but not take an answer.
 * @module @deepseek-ai/dsh-desktop-shell/data-location-boot
 */

import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  adoptEnvLocation, canAdoptEnv, checkChosenFolder, commitReady, dataReference, ensureDataId, keepPointerOverEnv, normalizeDshHome,
  readDataId, readGeneration, readPointer, resolveDataLocation, withGeneration, writeGeneration, writePointer,
  type ChosenFolder, type DataLocationPointer, type EnvUnverifiedReason, type PointerRead, type Resolution, type UnavailableReason,
} from './data-location.ts'
import type { DataLocationText } from './data-location-text.ts'
import { calibrateHomeLink, defaultHomeLinkTarget, type HomeLinkOutcome, type LinkFs } from './home-link.ts'
import { writeDurably } from './durable-file.ts'
import {
  ABANDONED_FILENAME, abandonedCopiesAsideName, abandonedCopiesText, JournalError, moveDir, readAbandonedCopies,
  setAbandonedCopiesAside, type AbandonedCopy,
} from './move/journal.ts'
import { samePathText } from './path-text.ts'
import { POINTER_HOME_ENV, processDshHome, type ExplicitRead, type TerminalWrite } from './terminal-env.ts'

/** A question the boot window puts to the person. */
export type LocationPrompt =
  | { kind: 'unavailable'; reason: UnavailableReason; path: string | undefined; suggestion?: string; escapable?: boolean }
  /** The person asked to use a set-aside folder as their data; this confirms it. `older`: it may be an older copy. */
  | { kind: 'confirm-use'; path: string; older: boolean }
  /** The record of abandoned copies cannot be read; the launch cannot tell a copy from the data. */
  | { kind: 'abandoned-unreadable'; path: string; platform: NodeJS.Platform }
  /** The person asked to set the unreadable record aside; `name` is what it will be renamed to. */
  | { kind: 'confirm-move-aside'; path: string; name: string }
  | { kind: 'confirm-env'; reason: EnvUnverifiedReason; envPath: string; current: string }

/** The answers a {@link LocationPrompt} offers. */
export type LocationAnswer =
  | 'retry' | 'use-suggested' | 'choose' | 'quit' | 'use-new' | 'keep' | 'reveal' | 'use-anyway' | 'confirm' | 'cancel'
  | 'move-aside'

/** A prompt rendered for a message box. */
export interface PromptView {
  message: string
  detail: string
  /**
   * Button labels in order, each with the answer it gives. The first is the
   * default and changes nothing on disk, so it is the safe choice to fall on.
   */
  buttons: Array<{ label: string; answer: LocationAnswer }>
  /** Index of the button that Esc and closing the box stand for. */
  cancelIndex: number
}

/**
 * Render a prompt in one language.
 * @param prompt - the question.
 * @param text - the sentence set.
 * @returns the message box contents.
 */
export function promptView(prompt: LocationPrompt, text: DataLocationText): PromptView {
  switch (prompt.kind) {
    case 'unavailable': {
      const buttons: PromptView['buttons'] = [
        { label: text.retry, answer: 'retry' },
        ...prompt.suggestion === undefined ? [] : [{ label: text.useSuggested, answer: 'use-suggested' as const }],
        { label: text.choose, answer: 'choose' },
        ...prompt.escapable === true ? [{ label: text.useAnyway, answer: 'use-anyway' as const }] : [],
        { label: text.quit, answer: 'quit' },
      ]
      return {
        message: text.unavailableTitle,
        detail: prompt.suggestion === undefined
          ? text.unavailable(prompt.reason, prompt.path)
          : text.unavailableSuggested(prompt.suggestion),
        buttons,
        cancelIndex: buttons.length - 1,
      }
    }
    case 'abandoned-unreadable': {
      // Going on without the record is behind a confirmation that says what it loses.
      const buttons: PromptView['buttons'] = [
        { label: text.reveal(prompt.platform), answer: 'reveal' },
        { label: text.moveAside, answer: 'move-aside' },
        { label: text.quit, answer: 'quit' },
      ]
      return { message: text.abandonedUnreadableTitle, detail: text.abandonedUnreadable(prompt.path), buttons, cancelIndex: 2 }
    }
    case 'confirm-move-aside':
      return {
        message: text.confirmMoveAsideTitle,
        detail: text.confirmMoveAside(prompt.path, prompt.name),
        buttons: [{ label: text.cancel, answer: 'cancel' }, { label: text.confirmMoveAsideButton, answer: 'confirm' }],
        cancelIndex: 0,
      }
    case 'confirm-use':
      return {
        message: text.confirmUseTitle(prompt.path),
        detail: prompt.older ? text.confirmUseOlder : text.confirmUse,
        buttons: [{ label: text.cancel, answer: 'cancel' }, { label: text.confirmUseButton, answer: 'confirm' }],
        cancelIndex: 0,
      }
    case 'confirm-env':
      return {
        message: text.envTitle,
        detail: text.env(prompt.reason, prompt.envPath, prompt.current),
        buttons: canAdoptEnv(prompt.reason)
          ? [{ label: text.keep, answer: 'keep' }, { label: text.useNew, answer: 'use-new' }]
          : [{ label: text.keep, answer: 'keep' }, { label: text.quit, answer: 'quit' }],
        cancelIndex: 0,
      }
    default:
      return prompt satisfies never
  }
}

/** What the settle step needs from the app. */
export interface DataLocationHost {
  /** Electron's user-data directory, holding the pointer. */
  userData: string
  /** The default home, `~/.dsh`. */
  defaultHome: string
  /** The operating-system home that `~` in `DSH_HOME` stands for. */
  osHome: string
  platform: NodeJS.Platform
  /** The process environment; `DSH_HOME` and {@link POINTER_HOME_ENV} are set on it. */
  env: NodeJS.ProcessEnv
  /** The sentence set for this locale. */
  text: DataLocationText
  log: (line: string) => void
  /** Read `DSH_HOME` from the login shell or the Windows user environment, never from this process's environment. */
  readPersistentEnv: () => Promise<ExplicitRead>
  /**
   * Make terminals opened from now on see this `DSH_HOME`, or, with
   * `undefined`, no `DSH_HOME` of ours: the profile block or the Windows user
   * variable is removed (a data move's rollback when there was none before).
   */
  writeTerminalEnv: (value: string | undefined) => Promise<TerminalWrite>
  /** Put a question on the boot window and wait for the answer. */
  ask: (view: PromptView) => Promise<LocationAnswer>
  /** Let the person pick a folder; `undefined` when they cancel. */
  chooseFolder: (title: string) => Promise<string | undefined>
  /** Show a file in the platform's file browser. */
  reveal: (path: string) => void
  /** Show one sentence with a single button and wait for it. */
  tell: (message: string) => Promise<void>
  /** File-system calls for the `~/.dsh` link; the real ones when absent. */
  linkFs?: LinkFs
}

/** What the launch settled on. */
export interface SettledLocation {
  /** The Harness home, now in `env.DSH_HOME` when a pointer or an explicit value named it. */
  home: string
  via: Extract<Resolution, { kind: 'ready' }>['via']
  /** The pointer on disk, when there is one. */
  pointer?: DataLocationPointer
  /** The explicit `DSH_HOME` this launch observed. */
  explicit: ExplicitRead
  /** What happened to `~/.dsh`, when a pointer names another directory. */
  link?: HomeLinkOutcome
  /** What the last write of the terminal's `DSH_HOME` this launch came to, when there was one. */
  terminal?: TerminalSync
}

/**
 * Give a data directory settled without a pointer its identity marker once
 * the launch has created it. Settling marks only a directory that already
 * exists, a fresh installation's directory is created later in the same
 * launch by the profile seeding, and a data move refuses a directory without
 * a marker. With a pointer the directory already carries the pointer's
 * marker, and nothing is written.
 * @param settled - the directory and pointer the launch settled on.
 * @param log - the desktop log sink; receives one line when the marker cannot be written, which leaves the launch
 * going on and the next launch writing it.
 */
export function markSettledHome(settled: Pick<SettledLocation, 'home' | 'pointer'>, log: (line: string) => void): void {
  if (settled.pointer !== undefined) return
  try {
    ensureDataId(settled.home)
  } catch (error) {
    log(`[desktop] data location: could not mark ${settled.home} with its identity: ${String(error)}\n`)
  }
}

/**
 * Export the pointer's directory as `DSH_HOME` before anything reads the home.
 * The directory may be missing; nothing reads it yet, and a read that fails
 * against it falls back quietly instead of reading `~/.dsh`.
 * @param userData - Electron's user-data directory.
 * @param env - the process environment, updated in place.
 * @returns the `DSH_HOME` the process was launched with, captured before it is overwritten.
 */
export function exportPointerHome(userData: string, env: NodeJS.ProcessEnv): string | undefined {
  const launchEnv = processDshHome(env)
  const read = readPointer(userData)
  if (read.kind === 'ok') {
    env['DSH_HOME'] = read.pointer.path
    env[POINTER_HOME_ENV] = read.pointer.path
  }
  return launchEnv
}

/**
 * The explicit `DSH_HOME` as the pointer compares and records it: normalized,
 * and, while a pointer exists, `~/.dsh` replaced by the directory it links to.
 * @param host - the app.
 * @param read - what the pointer read found.
 * @param explicit - the explicit value observed.
 * @returns the absolute path, or `undefined` when none was set.
 */
function pointerEnv(host: DataLocationHost, read: PointerRead, explicit: ExplicitRead): string | undefined {
  const envPath = explicit.kind === 'set' ? normalizeDshHome(explicit.value, host.osHome) : undefined
  if (envPath === undefined || read.kind === 'absent' || envPath !== resolve(host.defaultHome)) return envPath
  return defaultHomeLinkTarget(host.defaultHome, host.linkFs) ?? envPath
}

/** How an explicit read is described in the log. */
function describeExplicit(read: ExplicitRead): string {
  switch (read.kind) {
    case 'set':
      return `DSH_HOME=${read.value} (from ${read.source})`
    case 'unset':
      return 'no explicit DSH_HOME'
    case 'unknown':
      return `explicit DSH_HOME unknown: ${read.detail}`
    default:
      return read satisfies never
  }
}

/** How a link outcome is described in the log. */
function describeLink(outcome: HomeLinkOutcome, defaultHome: string, home: string): string {
  switch (outcome.kind) {
    case 'not-needed':
      return `${defaultHome} is the data directory itself`
    case 'already-correct':
      return `${defaultHome} already links to ${home}`
    case 'created':
      return `${defaultHome} created as a link to ${home}`
    case 'repointed':
      return `${defaultHome} re-pointed from ${outcome.previous} to ${home}`
    case 'kept-directory':
      return outcome.reason === 'same-id'
        ? `${defaultHome} is a real directory carrying this data's marker (a copy left behind); left as it is — a terminal dsh without DSH_HOME reads it, not ${home}`
        : `${defaultHome} is a real directory this app did not make; left as it is — a terminal dsh without DSH_HOME reads it, not ${home}`
    case 'kept-other':
      return `${defaultHome} is not a directory or a link; left as it is`
    case 'failed':
      return `${defaultHome} could not be linked to ${home}: ${outcome.detail}`
    default:
      return outcome satisfies never
  }
}

/**
 * What writing the terminal's `DSH_HOME` came to, as the login shell or the
 * Windows user environment reported it afterwards.
 *
 * - `synced`: the persistent source now reports `value`.
 * - `overridden`: the write went through, but the source reports something
 *   else — `reported`, or no value at all when it is `undefined` — because a
 *   file read after the one written, or a `ZDOTDIR` the app does not see,
 *   decides what a terminal gets.
 * - `unconfirmed`: the write went through and the source could not be read back.
 * - `not-written`: the store refused the write, for the reason `write` names.
 * - `failed`: the write threw.
 */
export type TerminalSync =
  | { kind: 'synced'; value: string; write: TerminalWrite }
  | { kind: 'overridden'; value: string; write: TerminalWrite; reported: string | undefined }
  | { kind: 'unconfirmed'; value: string; write: TerminalWrite; detail: string }
  | { kind: 'not-written'; value: string; write: TerminalWrite }
  | { kind: 'failed'; value: string; detail: string }

/** What {@link syncTerminal} needs from the app. */
export type TerminalSyncHost = Pick<DataLocationHost, 'writeTerminalEnv' | 'readPersistentEnv' | 'osHome' | 'log'>

/**
 * Make terminals see the pointer's directory, read back what they now see,
 * and record that as the value last seen, so the next launch neither takes
 * the directory for a change nor follows a value the write did not replace.
 * A data move uses it for its switch too.
 * @param host - the app: the terminal write and read, the home `~` stands for, and the log.
 * @param pointer - the pointer about to be written.
 * @param observed - the explicit `DSH_HOME` observed this launch.
 * @returns the pointer with `lastSeenEnv` set accordingly, and what the write came to.
 */
export async function syncTerminal(
  host: TerminalSyncHost, pointer: DataLocationPointer, observed: string | undefined,
): Promise<{ pointer: DataLocationPointer; sync: TerminalSync }> {
  const value = pointer.path
  const seenBefore = observed === undefined ? pointer : { ...pointer, lastSeenEnv: observed }
  let write: TerminalWrite
  try {
    write = await host.writeTerminalEnv(value)
  } catch (error) {
    return report(host, { pointer: seenBefore, sync: { kind: 'failed', value, detail: String(error) } })
  }
  const took = write.kind === 'user-environment'
    || (write.kind === 'profile' && (write.update.kind === 'written' || write.update.kind === 'unchanged'))
  if (!took) return report(host, { pointer: seenBefore, sync: { kind: 'not-written', value, write } })
  const reread = await host.readPersistentEnv()
  switch (reread.kind) {
    case 'unknown':
      return report(host, { pointer, sync: { kind: 'unconfirmed', value, write, detail: reread.detail } })
    case 'unset': {
      const unseen = { ...pointer }
      delete unseen.lastSeenEnv
      return report(host, { pointer: unseen, sync: { kind: 'overridden', value, write, reported: undefined } })
    }
    case 'set': {
      const reported = normalizeDshHome(reread.value, host.osHome) ?? reread.value
      if (reported === value) return report(host, { pointer: { ...pointer, lastSeenEnv: value }, sync: { kind: 'synced', value, write } })
      return report(host, { pointer: { ...pointer, lastSeenEnv: reported }, sync: { kind: 'overridden', value, write, reported } })
    }
    default:
      return reread satisfies never
  }
}

/**
 * The `DSH_HOME` value a data move's rollback records as seen when it could
 * not put the terminal setting back, from what a terminal reads after the
 * attempt. Both reads are taken as a launch takes them
 * ({@link normalizeDshHome}).
 * @param before - what a terminal read before the move.
 * @param now - what a terminal reads after the restore attempt.
 * @param osHome - the home `~` stands for.
 * @returns the value to record as the pointer's `lastSeenEnv`; `undefined` when a terminal reads no value (none, or
 * only blanks), or reads the value it read before the move, so the pointer stays as the rollback put it back.
 */
export function terminalSeenAfterRestore(
  before: ExplicitRead, now: Exclude<ExplicitRead, { kind: 'unknown' }>, osHome: string,
): string | undefined {
  const seen = now.kind === 'set' ? normalizeDshHome(now.value, osHome) : undefined
  if (seen === undefined) return undefined
  return before.kind === 'set' && normalizeDshHome(before.value, osHome) === seen ? undefined : seen
}

/**
 * Log what a terminal sync came to.
 * @param host - the app.
 * @param result - the pointer and the sync outcome.
 * @returns `result`, unchanged.
 */
function report(
  host: TerminalSyncHost, result: { pointer: DataLocationPointer; sync: TerminalSync },
): { pointer: DataLocationPointer; sync: TerminalSync } {
  const { sync } = result
  const line = (text: string): void => { host.log(`[desktop] data location: ${text}\n`) }
  switch (sync.kind) {
    case 'synced':
      line(`terminal DSH_HOME set to ${sync.value} and confirmed: ${JSON.stringify(sync.write)}`)
      break
    case 'overridden':
      line(`terminal DSH_HOME written as ${sync.value} (${JSON.stringify(sync.write)}), but a terminal still gets ${sync.reported ?? 'no value'}; something the shell reads later, or a ZDOTDIR the app does not see, decides it; not synced`)
      break
    case 'unconfirmed':
      line(`terminal DSH_HOME written as ${sync.value} (${JSON.stringify(sync.write)}); reading it back failed (${sync.detail}); not confirmed`)
      break
    case 'not-written':
      line(`terminal DSH_HOME not written: ${JSON.stringify(sync.write)}`)
      if (sync.write.kind === 'profile' && sync.write.update.kind === 'foreign-assignment') {
        const places = sync.write.update.places.map(place => `${place.file}:${String(place.line)}`).join(', ')
        line(`the shell profile sets DSH_HOME itself at ${places}; that line keeps deciding what a terminal sees`)
      }
      if (sync.write.kind === 'profile' && sync.write.update.kind === 'dangling-profile') {
        line(`the shell reads its profile through ${sync.write.update.link}, a link whose target is missing; nothing is created through it`)
      }
      break
    case 'failed':
      line(`could not update the terminal DSH_HOME: ${sync.detail}`)
      break
    default:
      return sync satisfies never
  }
  return result
}

/**
 * Settle the Harness home for this launch, asking the person whenever the
 * decision needs them, and export it. Loops until the home is usable or the
 * person quits.
 * @param host - the app.
 * @param launchEnv - what {@link exportPointerHome} captured.
 * @returns the settled location, or `undefined` when the person chose to quit.
 */
export async function settleDataLocation(host: DataLocationHost, launchEnv: string | undefined): Promise<SettledLocation | undefined> {
  const { env, log, text } = host
  let persistent: ExplicitRead | undefined
  // Once the person has decided, the value observed this launch is part of
  // that decision; comparing it again would reopen the question it answered.
  let decided = false
  let terminal: TerminalSync | undefined
  for (;;) {
    const read = readPointer(host.userData)
    let explicit: ExplicitRead
    if (launchEnv !== undefined) explicit = { kind: 'set', value: launchEnv, source: 'process' }
    else if (read.kind === 'absent') explicit = { kind: 'unset' }
    else explicit = persistent ??= await host.readPersistentEnv()
    const envPath = pointerEnv(host, read, explicit)
    const abandoned = await readAbandonedOrAsk(host)
    if (abandoned === undefined) return undefined
    const resolution = resolveDataLocation({ read, env: decided ? undefined : envPath, defaultHome: host.defaultHome, abandoned })
    switch (resolution.kind) {
      case 'ready': {
        let pointer: DataLocationPointer | undefined
        try {
          pointer = commitReady(host.userData, resolution) ?? (read.kind === 'ok' ? read.pointer : undefined)
        } catch (error) {
          log(`[desktop] data location: could not record ${resolution.home}: ${String(error)}\n`)
          pointer = resolution.pointer ?? (read.kind === 'ok' ? read.pointer : undefined)
        }
        if (resolution.via === 'followed-env') {
          log(`[desktop] data location: ${describeExplicit(explicit)} differs from the value last seen; following it\n`)
        }
        log(`[desktop] data location: home=${resolution.home} via=${resolution.via}; ${describeExplicit(explicit)}\n`)
        if (pointer === undefined) return { home: resolution.home, via: resolution.via, explicit }
        env['DSH_HOME'] = resolution.home
        env[POINTER_HOME_ENV] = resolution.home
        if (envPath !== undefined && envPath !== resolution.home) {
          log(`[desktop] data location: ${describeExplicit(explicit)} was seen before and is not used; the app uses ${resolution.home}\n`)
        }
        const link = calibrateHomeLink({
          defaultHome: host.defaultHome, dataHome: resolution.home, dataId: pointer.dataId, platform: host.platform,
          ...host.linkFs === undefined ? {} : { fs: host.linkFs },
        })
        log(`[desktop] data location: ${describeLink(link, host.defaultHome, resolution.home)}\n`)
        return { home: resolution.home, via: resolution.via, pointer, explicit, link, ...terminal === undefined ? {} : { terminal } }
      }
      case 'unavailable': {
        const path = resolution.pointer?.path ?? resolution.path
        const suggestion = resolution.suggestion
        log(`[desktop] data location: unavailable (${resolution.reason}) ${path ?? resolution.detail ?? ''}${suggestion === undefined ? '' : `; the backup names ${suggestion.path}`}; asking\n`)
        const escapable = resolution.escapable === true && path !== undefined
        const answer = await host.ask(promptView({
          kind: 'unavailable', reason: resolution.reason, path, ...suggestion === undefined ? {} : { suggestion: suggestion.path },
          ...escapable ? { escapable } : {},
        }, text))
        if (answer === 'quit') {
          log('[desktop] data location: the person chose to quit\n')
          return undefined
        }
        if (answer === 'use-anyway' && escapable) {
          const older = resolution.reason === 'older'
          if (await host.ask(promptView({ kind: 'confirm-use', path, older }, text)) !== 'confirm') continue
          log(`[desktop] data location: the person made ${path} their data again\n`)
          makeFolderCurrent(host, path, read)
          continue
        }
        let chosen: string | undefined
        if (answer === 'use-suggested' && suggestion !== undefined) chosen = suggestion.path
        else if (answer === 'choose') chosen = await host.chooseFolder(text.chooseTitle)
        if (chosen === undefined) continue
        // A confirmed backup location must still carry the identity the backup recorded.
        const context = { abandoned, reference: dataReference(read, host.defaultHome) }
        const checked = checkChosenFolder(chosen, answer === 'use-suggested' ? suggestion : resolution.pointer, envPath, context)
        if (checked.kind === 'rejected') {
          log(`[desktop] data location: refused ${chosen} (${checked.reason})\n`)
          await host.tell(refusal(text, checked.reason, chosen))
          continue
        }
        log(`[desktop] data location: the person pointed the app at ${checked.pointer.path}\n`)
        const synced = await syncTerminal(host, checked.pointer, envPath)
        terminal = synced.sync
        writePointer(host.userData, synced.pointer)
        decided = true
        continue
      }
      case 'confirm-env': {
        const current = resolution.pointer.path
        log(`[desktop] data location: ${describeExplicit(explicit)} changed to a folder that is ${resolution.reason}; asking\n`)
        let reason: EnvUnverifiedReason = resolution.reason
        let adopted: DataLocationPointer | undefined
        let answer: LocationAnswer
        // A new location that cannot be created is asked about again, with
        // only keep and quit, instead of ending the launch.
        for (;;) {
          answer = await host.ask(promptView({ kind: 'confirm-env', reason, envPath: resolution.envPath, current }, text))
          if (answer !== 'use-new') break
          log(`[desktop] data location: the person chose the new location ${resolution.envPath}\n`)
          try {
            adopted = adoptEnvLocation(resolution.envPath, resolution.pointer)
            break
          } catch (error) {
            log(`[desktop] data location: could not create ${resolution.envPath}: ${String(error)}; asking again\n`)
            reason = 'cannot-create'
          }
        }
        if (answer === 'quit') {
          log('[desktop] data location: the person chose to quit\n')
          return undefined
        }
        if (adopted !== undefined) {
          writePointer(host.userData, adopted)
        } else {
          log(`[desktop] data location: the person kept ${current} over ${resolution.envPath}\n`)
          const synced = await syncTerminal(host, keepPointerOverEnv(resolution.envPath, resolution.pointer), resolution.envPath)
          terminal = synced.sync
          writePointer(host.userData, synced.pointer)
        }
        decided = true
        continue
      }
      default:
        return resolution satisfies never
    }
  }
}

/**
 * Make a folder set aside by the record of abandoned copies or by its
 * generation the data in use again, after the person confirmed it: its
 * generation goes above every other copy's, its records in the abandoned
 * list go, and the pointer, when there is one, names it with that number.
 * Each step is repeatable, in this order, so an interruption leaves the
 * folder refused (and the person asked again) or current, never a second
 * copy in use.
 * @param host - the app.
 * @param folder - the folder.
 * @param read - the pointer as read this pass.
 * @throws when the folder carries no identity, or a file cannot be written.
 */
function makeFolderCurrent(host: DataLocationHost, folder: string, read: PointerRead): void {
  const id = readDataId(folder)
  if (id.kind !== 'ok') throw new Error(`${folder} carries no data identity`)
  const reference = dataReference(read, host.defaultHome)
  const generation = Math.max(reference?.dataId === id.id ? reference.generation : 0, readGeneration(folder)) + 1
  writeGeneration(folder, generation)
  const dir = moveDir(host.userData)
  const copies = readAbandonedCopies(dir)
  const real = realpathSync.native(folder)
  const kept = copies.filter(copy => !(copy.dataId === id.id && samePathText(copy.path, real, host.platform)))
  if (kept.length !== copies.length) writeDurably(join(dir, ABANDONED_FILENAME), Buffer.from(abandonedCopiesText(kept)), 0o600)
  if (read.kind === 'ok') {
    const named = { ...read.pointer, path: resolve(folder), dataId: id.id, movedAt: new Date().toISOString() }
    writePointer(host.userData, withGeneration(named, generation))
  }
}

/** What {@link readAbandonedOrAsk} needs from the app. */
export type AbandonedRecordHost = Pick<DataLocationHost, 'userData' | 'platform' | 'text' | 'log' | 'ask' | 'reveal'>

/**
 * Read the record of abandoned copies. While it cannot be read the launch
 * does not go on by itself: without it some abandoned copies cannot be told
 * from the data, so the person is told where the file is and may show it
 * (then it is read again), quit, or, after a confirmation, have it renamed
 * aside ({@link setAbandonedCopiesAside}) and go on with the folders'
 * generations alone.
 * The data move's window asks the same way when a move meets this file.
 * @param host - the app: user data, the platform, the sentences, the log, the question, and the file browser.
 * @returns the copies, or `undefined` when the person quit.
 * @throws what reading throws other than a {@link JournalError}.
 */
export async function readAbandonedOrAsk(host: AbandonedRecordHost): Promise<readonly AbandonedCopy[] | undefined> {
  const path = join(moveDir(host.userData), ABANDONED_FILENAME)
  for (;;) {
    try {
      return readAbandonedCopies(moveDir(host.userData))
    } catch (error) {
      if (!(error instanceof JournalError)) throw error
      host.log(`[desktop] data location: ${error.message}; asking\n`)
    }
    const answer = await host.ask(promptView({ kind: 'abandoned-unreadable', path, platform: host.platform }, host.text))
    if (answer === 'quit') {
      host.log('[desktop] data location: the person chose to quit\n')
      return undefined
    }
    if (answer === 'move-aside') await moveAbandonedAside(host)
    else host.reveal(path)
  }
}

/**
 * Confirm, then rename the unreadable record of abandoned copies aside. A
 * failed rename is logged and the record is read again, which asks again.
 * @param host - the app.
 */
async function moveAbandonedAside(host: AbandonedRecordHost): Promise<void> {
  const dir = moveDir(host.userData)
  const name = abandonedCopiesAsideName(dir, new Date())
  const path = join(dir, ABANDONED_FILENAME)
  const answer = await host.ask(promptView({ kind: 'confirm-move-aside', path, name }, host.text))
  if (answer !== 'confirm') return
  try {
    const moved = setAbandonedCopiesAside(dir, name)
    host.log(moved
      ? `[desktop] data location: set the unreadable ${path} aside as ${name}\n`
      : `[desktop] data location: ${path} became readable; left in place\n`)
  } catch (error) {
    host.log(`[desktop] data location: could not set ${path} aside: ${String(error)}\n`)
  }
}

/**
 * The sentence for a refused pick.
 * @param text - the sentence set.
 * @param reason - why the folder was refused.
 * @param path - the folder.
 * @returns the sentence.
 */
function refusal(text: DataLocationText, reason: Extract<ChosenFolder, { kind: 'rejected' }>['reason'], path: string): string {
  switch (reason) {
    case 'no-data':
      return text.refusedNoData(path)
    case 'other-data':
      return text.refusedOtherData(path)
    case 'set-aside':
      return text.refusedSetAside(path)
    case 'older':
      return text.refusedOlder(path)
    default:
      return reason satisfies never
  }
}

/**
 * The default home for an operating-system home directory.
 * @param osHome - the operating-system home.
 * @returns `~/.dsh`.
 */
export function defaultHarnessHome(osHome: string): string {
  return join(osHome, '.dsh')
}
