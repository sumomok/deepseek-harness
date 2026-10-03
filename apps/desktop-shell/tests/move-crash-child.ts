/**
 * Child process for the data-move crash tests, run by plain Node from source.
 *
 * It drives one prepared move to its end with the harness's `driveMove`.
 * Every call that changes
 * the disk or the outside world, and every progress report, is numbered; when
 * the number given as `killAt` has completed, the process kills itself with
 * SIGKILL, so nothing after that point runs, not even a `finally`.
 *
 * Input: one JSON argument (see {@link ChildInput}). Output: one JSON line on
 * standard output with the number of events seen and how the move ended.
 * @module
 */

import { closeSync, existsSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { readJournal, type BlockedChoice } from '../src/move/journal.ts'
import type { MoveEffects, MoveFs } from '../src/move/run.ts'
import { driveMove, harnessEffects, type Faults, type MoveSetup } from './move-harness.ts'

/** What the parent passes. */
export interface ChildInput {
  setup: MoveSetup
  target: string
  healthy: boolean
  /** The event after which the process kills itself; 0 never. */
  killAt: number
  faults: Faults
  /**
   * Before the first full check, damage the copy (a file's first bytes, and a
   * stray file), so the check fails and the move repairs the copy.
   */
  damageFirstCheck: boolean
  /** Drop a `.DS_Store` into the target folder and the copy while copying, as Finder does. */
  finderFiles: boolean
  /** The person's choice when the move is blocked. */
  choose?: BlockedChoice
}

const input = JSON.parse(process.argv[2] ?? '{}') as ChildInput
const labels: string[] = []

/**
 * Count one completed event and die when it is the chosen one.
 * @param label - what completed.
 */
function event(label: string): void {
  labels.push(label)
  if (labels.length === input.killAt) process.kill(process.pid, 'SIGKILL')
}

const real = harnessEffects(input.setup, input.faults)
const fs: MoveFs = {
  ...real.fs,
  writeFile: (path, content) => { real.fs.writeFile(path, content); event(`writeFile ${path}`) },
  rename: (from, to) => { real.fs.rename(from, to); event(`rename ${from} -> ${to}`) },
  unlink: (path) => { real.fs.unlink(path); event(`unlink ${path}`) },
  mkdir: (path) => { real.fs.mkdir(path); event(`mkdir ${path}`) },
  rmdir: (path) => { real.fs.rmdir(path); event(`rmdir ${path}`) },
}
const effects: MoveEffects = {
  ...real,
  fs,
  copy: async (request, signal, onProgress) => {
    if (input.finderFiles) {
      for (const dir of [input.setup.start.target, request.dest]) {
        if (existsSync(dir)) writeFileSync(join(dir, '.DS_Store'), 'finder')
      }
    }
    await real.copy(request, signal, (progress) => { onProgress(progress); event('copy progress') })
    event('copy')
  },
  verify: async (request, signal, onProgress) => {
    if (input.damageFirstCheck && request.hash === 'all' && readJournal(input.setup.dir)?.repairRounds === 0) {
      const big = join(request.dest, 'attachments', 'v1', 'objects', 'big.bin')
      const fd = openSync(big, 'r+')
      try {
        writeSync(fd, Buffer.from('DAMAGED-DAMAGED!'), 0, 16, 0)
      } finally {
        closeSync(fd)
      }
      writeFileSync(join(request.dest, 'stray.txt'), 'not in the source\n')
    }
    const problems = await real.verify(request, signal, (progress) => { onProgress(progress); event('verify progress') })
    event('verify')
    return problems
  },
  repair: async (request, extras, forget) => {
    await real.repair(request, extras, forget)
    event('repair')
  },
  remove: async (path) => {
    const report = await real.remove(path)
    event(`remove ${path}`)
    return report
  },
  scanLinks: async (source) => {
    const links = await real.scanLinks(source)
    event('scanLinks')
    return links
  },
  rewriteLink: (root, rewrite) => {
    const outcome = real.rewriteLink(root, rewrite)
    event(`rewriteLink ${rewrite.rel}`)
    return outcome
  },
  writePointer: (pointer) => { real.writePointer(pointer); event('writePointer') },
  restorePointer: (before) => { real.restorePointer(before); event('restorePointer') },
  syncTerminal: async (target) => {
    const seen = await real.syncTerminal(target)
    event('syncTerminal')
    return seen
  },
  restoreTerminal: async (snapshot) => { await real.restoreTerminal(snapshot); event('restoreTerminal') },
  terminalSeen: async (before) => {
    const seen = await real.terminalSeen(before)
    event('terminalSeen')
    return seen
  },
  restoreHomeLink: (before) => { real.restoreHomeLink(before); event('restoreHomeLink') },
}

driveMove(input.setup, input.target, input.healthy, effects, event, () => input.choose).then(
  (ended) => { process.stdout.write(`${JSON.stringify({ events: labels, ended })}\n`) },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  },
)
