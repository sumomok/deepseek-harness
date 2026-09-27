/**
 * A data move set up on a fixture home, shared by the executor tests and the
 * crash tests: the user-data directory, `~/.dsh`, the pointer before the move,
 * a terminal stand-in that keeps its `DSH_HOME` in a file, and the start of
 * the journal. Imports nothing from vitest, so the crash child process can
 * load it under plain Node.
 * @module
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readGeneration, type DataId } from '../src/data-location.ts'
import { calibrateHomeLink } from '../src/home-link.ts'
import { moveDir, readJournal, type BlockedChoice, type MoveStart } from '../src/move/journal.ts'
import {
  advanceMove, nodeMoveEffects, readHomeLinkBefore, readPointerFiles, recordHealth, resolveBlocked, type MoveEffects, type MoveOutcome,
} from '../src/move/run.ts'
import type { ExplicitRead } from '../src/terminal-env.ts'

/** Identity written into the fixture home's marker (same as the fixture's). */
export const HARNESS_ID = '11111111-2222-4333-8444-555555555555' as DataId

/** How the home is found before the move. */
export type Start = 'pointer' | 'default-home'

/** A move ready to start. */
export interface MoveSetup {
  userData: string
  dir: string
  defaultHome: string
  terminalFile: string
  start: MoveStart
}

/**
 * Prepare a move of `home` to `target`.
 * @param input - the fixture's paths and the variant.
 * @returns the setup.
 */
export function prepareMove(input: {
  root: string
  home: string
  target: string
  sameVolume: boolean
  start: Start
  targetPreexisting?: boolean
}): MoveSetup {
  const userData = join(input.root, 'userData')
  mkdirSync(userData, { recursive: true })
  const osHome = join(input.root, 'os-home')
  mkdirSync(osHome, { recursive: true })
  let defaultHome: string
  let lastSeenEnvBefore: string | undefined
  if (input.start === 'pointer') {
    defaultHome = join(osHome, '.dsh')
    symlinkSync(input.home, defaultHome, 'junction')
    writeFileSync(join(userData, 'data-location.json'), `${JSON.stringify({ version: 1, path: input.home, dataId: HARNESS_ID, lastSeenEnv: input.home }, null, 2)}\n`)
    writeFileSync(join(userData, 'data-location.json.bak'), 'older pointer text\n')
    lastSeenEnvBefore = input.home
  } else {
    defaultHome = input.home
  }
  const terminalFile = join(input.root, 'terminal.txt')
  const terminalBefore: ExplicitRead = input.start === 'pointer' ? { kind: 'set', value: input.home, source: 'login-shell' } : { kind: 'unset' }
  writeFileSync(terminalFile, terminalBefore.kind === 'set' ? terminalBefore.value : '')
  if (input.targetPreexisting === true) mkdirSync(input.target, { recursive: true })
  return {
    userData,
    dir: moveDir(userData),
    defaultHome,
    terminalFile,
    start: {
      source: input.home,
      sourceAliases: [input.home],
      target: input.target,
      targetPreexisting: input.targetPreexisting === true,
      sameVolume: input.sameVolume,
      dataId: HARNESS_ID,
      pointerBefore: readPointerFiles(userData),
      ...lastSeenEnvBefore === undefined ? {} : { lastSeenEnvBefore },
      terminalBefore,
      // The harness keeps the terminal in a file of its own, which it writes back itself.
      terminalSnapshot: { kind: 'unsupported-platform', platform: 'harness' },
      homeLinkBefore: readHomeLinkBefore(defaultHome),
      baseline: { sessions: 1, workspaces: 0, quarantined: [] },
      originalGeneration: readGeneration(input.home),
    },
  }
}

/** Failures a scenario injects; each one fails every time its step runs. */
export interface Faults {
  /** Writing the target's identity marker fails (another volume): hiding the source rolls back. */
  targetId?: boolean
  /** Writing the terminal's `DSH_HOME` fails: switching rolls back. */
  terminal?: boolean
  /** Rewriting a link to the target fails (one volume): hiding the source rolls back. */
  rewrite?: boolean
}

/**
 * The real effects with the terminal kept in a file, and the injected failures.
 * @param setup - the move.
 * @param faults - which steps fail.
 * @returns the effects.
 */
export function harnessEffects(setup: MoveSetup, faults: Faults = {}): MoveEffects {
  const effects = nodeMoveEffects({
    userData: setup.userData,
    defaultHome: setup.defaultHome,
    platform: process.platform,
    locale: 'en',
    syncTerminal: async (target) => {
      writeFileSync(setup.terminalFile, target)
      return target
    },
    restoreTerminal: async () => {
      const before = setup.start.terminalBefore
      writeFileSync(setup.terminalFile, before.kind === 'set' ? before.value : '')
    },
  })
  const target = setup.start.target
  return {
    ...effects,
    fs: {
      ...effects.fs,
      writeFile: (path, content) => {
        if (faults.targetId === true && path === join(target, '.dsh-data-id')) throw new Error('injected: cannot write the identity')
        effects.fs.writeFile(path, content)
      },
    },
    syncTerminal: async (value) => {
      if (faults.terminal === true) throw new Error('injected: cannot write the terminal')
      return effects.syncTerminal(value)
    },
    rewriteLink: (root, rewrite) => {
      if (faults.rewrite === true && rewrite.to.startsWith(target)) throw new Error('injected: cannot rewrite a link')
      return effects.rewriteLink(root, rewrite)
    },
  }
}

/**
 * The terminal's `DSH_HOME` as the stand-in holds it.
 * @param setup - the move.
 * @returns the value; empty for none.
 */
export function terminalValue(setup: MoveSetup): string {
  return readFileSync(setup.terminalFile, 'utf8')
}

/**
 * Drive a started move to its end the way the application does: advance, and
 * on `switched` point `~/.dsh` at the target (the next launch's calibration)
 * and record the health check, then advance again.
 * @param setup - the move.
 * @param target - the target directory.
 * @param healthy - the health check's verdict.
 * @param effects - the effects.
 * @param event - called after the calibration, the health record, and a choice, for the crash child's numbering.
 * @param choose - the person's choice on a blocked move; the drive stops at a block when it gives none.
 * @returns how the move ended, `blocked` when it is blocked, or `none` when no move was recorded.
 */
export async function driveMove(
  setup: MoveSetup, target: string, healthy: boolean, effects: MoveEffects, event: (label: string) => void = () => {},
  choose: (outcome: Extract<MoveOutcome, { kind: 'blocked' }>) => BlockedChoice | undefined = () => undefined,
): Promise<string> {
  const { dir } = setup
  if (!readdirSync(dir).includes('journal.json')) return 'none'
  for (;;) {
    const outcome = await advanceMove(dir, effects, { pid: process.pid })
    switch (outcome.kind) {
      case 'switched':
        calibrateHomeLink({ defaultHome: setup.defaultHome, dataHome: target, dataId: HARNESS_ID, platform: process.platform })
        event('calibrateHomeLink')
        if (readJournal(dir)?.phase === 'switched') recordHealth(dir, healthy, 'health check failed in the test', effects.fs)
        event('recordHealth')
        break
      case 'cleanup-incomplete':
        break
      case 'blocked': {
        const choice = choose(outcome)
        if (choice === undefined || resolveBlocked(dir, choice, { reason: outcome.reason, targetPrint: outcome.targetPrint }, effects.fs) !== 'applied') return 'blocked'
        event(`resolve ${choice}`)
        break
      }
      case 'ended':
        return outcome.result.outcome
      default:
        return outcome satisfies never
    }
  }
}

/** Identity of the directory a terminal `dsh` creates where the data was. */
export const INTRUDER_ID = '99999999-2222-4333-8444-555555555555'

/**
 * Make a directory at the data's old path the way a terminal `dsh` would
 * after the data was renamed away: its own identity and a session.
 * @param path - the old path.
 * @returns false when something is already there.
 */
export function plantIntruder(path: string): boolean {
  if (existsSync(path)) return false
  mkdirSync(join(path, 'sessions'), { recursive: true })
  writeFileSync(join(path, '.dsh-data-id'), `${INTRUDER_ID}\n`)
  writeFileSync(join(path, 'sessions', 'theirs.txt'), 'not ours\n')
  return true
}
