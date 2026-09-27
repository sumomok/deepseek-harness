/**
 * A data move set up on a fixture home, shared by the executor tests and the
 * crash tests: the user-data directory, `~/.dsh`, the pointer before the move,
 * a terminal stand-in that keeps its `DSH_HOME` in a file, and the start of
 * the journal. Imports nothing from vitest, so the crash child process can
 * load it under plain Node.
 * @module
 */

import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DataId } from '../src/data-location.ts'
import { calibrateHomeLink } from '../src/home-link.ts'
import { moveDir, readJournal, type MoveStart } from '../src/move/journal.ts'
import {
  advanceMove, nodeMoveEffects, readHomeLinkBefore, readPointerFiles, recordHealth, type MoveEffects,
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
      homeLinkBefore: readHomeLinkBefore(defaultHome),
      baseline: { sessions: 1, workspaces: 0, quarantined: [] },
    },
  }
}

/**
 * The real effects with the terminal kept in a file.
 * @param setup - the move.
 * @returns the effects.
 */
export function harnessEffects(setup: MoveSetup): MoveEffects {
  return nodeMoveEffects({
    userData: setup.userData,
    defaultHome: setup.defaultHome,
    platform: process.platform,
    syncTerminal: async (target) => {
      writeFileSync(setup.terminalFile, target)
      return target
    },
    restoreTerminal: async (before) => {
      writeFileSync(setup.terminalFile, before.kind === 'set' ? before.value : '')
    },
  })
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
 * @param event - called after the calibration and after the health record, for the crash child's numbering.
 * @returns how the move ended, or `none` when no move was recorded.
 */
export async function driveMove(
  setup: MoveSetup, target: string, healthy: boolean, effects: MoveEffects, event: (label: string) => void = () => {},
): Promise<string> {
  const { dir } = setup
  if (!readdirSync(dir).includes('journal.json')) return 'none'
  for (;;) {
    const outcome = await advanceMove(dir, effects, { pid: process.pid })
    switch (outcome.kind) {
      case 'switched':
        calibrateHomeLink({ defaultHome: setup.defaultHome, dataHome: target, dataId: HARNESS_ID, platform: process.platform })
        event('calibrateHomeLink')
        if (readJournal(dir)?.phase === 'switched') recordHealth(dir, healthy, 'health check failed in the test')
        event('recordHealth')
        break
      case 'cleanup-incomplete':
        break
      case 'ended':
        return outcome.result.outcome
      default:
        return outcome satisfies never
    }
  }
}
