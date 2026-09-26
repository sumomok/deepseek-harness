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

import { join } from 'node:path'
import {
  adoptEnvLocation, checkChosenFolder, commitReady, keepPointerOverEnv, normalizeDshHome, readPointer,
  resolveDataLocation, writePointer,
  type DataLocationPointer, type EnvUnverifiedReason, type Resolution, type UnavailableReason,
} from './data-location.ts'
import type { DataLocationText } from './data-location-text.ts'
import { calibrateHomeLink, type HomeLinkOutcome, type LinkFs } from './home-link.ts'
import { POINTER_HOME_ENV, processDshHome, type ExplicitRead, type TerminalWrite } from './terminal-env.ts'

/** A question the boot window puts to the person. */
export type LocationPrompt =
  | { kind: 'unavailable'; reason: UnavailableReason; path: string | undefined }
  | { kind: 'confirm-env'; reason: EnvUnverifiedReason; envPath: string; current: string }

/** The answers a {@link LocationPrompt} offers. */
export type LocationAnswer = 'retry' | 'choose' | 'quit' | 'use-new' | 'keep'

/** A prompt rendered for a message box. */
export interface PromptView {
  message: string
  detail: string
  /** Button labels in order, each with the answer it gives. */
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
    case 'unavailable':
      return {
        message: text.unavailableTitle,
        detail: text.unavailable(prompt.reason, prompt.path),
        buttons: [
          { label: text.retry, answer: 'retry' },
          { label: text.choose, answer: 'choose' },
          { label: text.quit, answer: 'quit' },
        ],
        cancelIndex: 2,
      }
    case 'confirm-env':
      return {
        message: text.envTitle,
        detail: text.env(prompt.reason, prompt.envPath, prompt.current),
        buttons: [
          { label: text.useNew, answer: 'use-new' },
          { label: text.keep, answer: 'keep' },
        ],
        cancelIndex: 1,
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
  /** Read `DSH_HOME` from the login shell or the Windows user environment. */
  readPersistentEnv: () => Promise<ExplicitRead>
  /** Make terminals opened from now on see this `DSH_HOME`. */
  writeTerminalEnv: (value: string) => Promise<TerminalWrite>
  /** Put a question on the boot window and wait for the answer. */
  ask: (view: PromptView) => Promise<LocationAnswer>
  /** Let the person pick a folder; `undefined` when they cancel. */
  chooseFolder: (title: string) => Promise<string | undefined>
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
 * Make terminals see the pointer's directory and record what they now see as
 * the value last seen, so the next launch does not take it for a change.
 * @param host - the app.
 * @param pointer - the pointer about to be written.
 * @param observed - the explicit `DSH_HOME` observed this launch.
 * @returns the pointer with `lastSeenEnv` set accordingly.
 */
async function syncTerminal(
  host: DataLocationHost, pointer: DataLocationPointer, observed: string | undefined,
): Promise<DataLocationPointer> {
  let written: TerminalWrite
  try {
    written = await host.writeTerminalEnv(pointer.path)
  } catch (error) {
    host.log(`[desktop] data location: could not update the terminal DSH_HOME: ${String(error)}\n`)
    return observed === undefined ? pointer : { ...pointer, lastSeenEnv: observed }
  }
  const took = written.kind === 'user-environment'
    || (written.kind === 'profile' && (written.update.kind === 'written' || written.update.kind === 'unchanged'))
  host.log(`[desktop] data location: terminal DSH_HOME update: ${JSON.stringify(written)}\n`)
  if (written.kind === 'profile' && written.update.kind === 'foreign-assignment') {
    const places = written.update.places.map(place => `${place.file}:${String(place.line)}`).join(', ')
    host.log(`[desktop] data location: the shell profile sets DSH_HOME itself at ${places}; that line keeps deciding what a terminal sees\n`)
  }
  if (took) return { ...pointer, lastSeenEnv: pointer.path }
  return observed === undefined ? pointer : { ...pointer, lastSeenEnv: observed }
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
  for (;;) {
    const read = readPointer(host.userData)
    let explicit: ExplicitRead
    if (launchEnv !== undefined) explicit = { kind: 'set', value: launchEnv, source: 'process' }
    else if (read.kind === 'absent') explicit = { kind: 'unset' }
    else explicit = persistent ??= await host.readPersistentEnv()
    const envPath = explicit.kind === 'set' ? normalizeDshHome(explicit.value, host.osHome) : undefined
    const resolution = resolveDataLocation({ read, env: decided ? undefined : envPath, defaultHome: host.defaultHome })
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
        return { home: resolution.home, via: resolution.via, pointer, explicit, link }
      }
      case 'unavailable': {
        const path = resolution.pointer?.path
        log(`[desktop] data location: unavailable (${resolution.reason}) ${path ?? resolution.detail ?? ''}; asking\n`)
        const answer = await host.ask(promptView({ kind: 'unavailable', reason: resolution.reason, path }, text))
        if (answer === 'quit') {
          log('[desktop] data location: the person chose to quit\n')
          return undefined
        }
        if (answer !== 'choose') continue
        const chosen = await host.chooseFolder(text.chooseTitle)
        if (chosen === undefined) continue
        const checked = checkChosenFolder(chosen, resolution.pointer, envPath)
        if (checked.kind === 'rejected') {
          log(`[desktop] data location: refused ${chosen} (${checked.reason})\n`)
          await host.tell(checked.reason === 'no-data' ? text.refusedNoData(chosen) : text.refusedOtherData(chosen))
          continue
        }
        log(`[desktop] data location: the person pointed the app at ${checked.pointer.path}\n`)
        writePointer(host.userData, await syncTerminal(host, checked.pointer, envPath))
        decided = true
        continue
      }
      case 'confirm-env': {
        const current = resolution.pointer.path
        log(`[desktop] data location: ${describeExplicit(explicit)} changed to a folder that is ${resolution.reason}; asking\n`)
        const answer = await host.ask(promptView({ kind: 'confirm-env', reason: resolution.reason, envPath: resolution.envPath, current }, text))
        if (answer === 'use-new') {
          log(`[desktop] data location: the person chose the new location ${resolution.envPath}\n`)
          writePointer(host.userData, adoptEnvLocation(resolution.envPath, resolution.pointer))
        } else {
          log(`[desktop] data location: the person kept ${current} over ${resolution.envPath}\n`)
          writePointer(host.userData, keepPointerOverEnv(resolution.envPath, resolution.pointer))
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
 * The default home for an operating-system home directory.
 * @param osHome - the operating-system home.
 * @returns `~/.dsh`.
 */
export function defaultHarnessHome(osHome: string): string {
  return join(osHome, '.dsh')
}
