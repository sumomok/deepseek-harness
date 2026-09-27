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

import type { MoveEffects, MoveFs } from '../src/move/run.ts'
import { driveMove, harnessEffects, type MoveSetup } from './move-harness.ts'

/** What the parent passes. */
export interface ChildInput {
  setup: MoveSetup
  target: string
  healthy: boolean
  /** The event after which the process kills itself; 0 never. */
  killAt: number
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

const real = harnessEffects(input.setup)
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
    await real.copy(request, signal, (progress) => { onProgress(progress); event('copy progress') })
    event('copy')
  },
  verify: async (request, signal, onProgress) => {
    const problems = await real.verify(request, signal, (progress) => { onProgress(progress); event('verify progress') })
    event('verify')
    return problems
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
  restoreTerminal: async (before) => { await real.restoreTerminal(before); event('restoreTerminal') },
  restoreHomeLink: (before) => { real.restoreHomeLink(before); event('restoreHomeLink') },
}

driveMove(input.setup, input.target, input.healthy, effects, event).then(
  (ended) => { process.stdout.write(`${JSON.stringify({ events: labels, ended })}\n`) },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  },
)
