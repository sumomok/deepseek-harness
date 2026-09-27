/**
 * The data move on its worker thread: a real worker carries a fixture move
 * through the switch, the health check, and a rollback, asking the main
 * process for the terminal effects; a stand-in thread shows when the main
 * side gives a move up as hung and when it does not.
 * @module
 */

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ExecutorError, runMoveExecutor, type ExecutorCommand, type ExecutorMessage, type ExecutorThread, type MainEffects,
} from '../src/move/executor.ts'
import { readJournal } from '../src/move/journal.ts'
import { copyRequestOf, nodeMoveEffects, recordHealth, startMove, type MoveProgress } from '../src/move/run.ts'
import type { TerminalSnapshot } from '../src/terminal-env.ts'
import { buildFixture, type Fixture } from './move-fixture.ts'
import { prepareMove, type MoveSetup } from './move-harness.ts'

const fixtures: Fixture[] = []
const posixOnly = process.platform === 'win32' ? it.skip : it

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await rm(fixture.root, { recursive: true, force: true })
})

/**
 * A fixture move to another volume, started.
 * @returns the setup and the target.
 */
async function started(): Promise<{ setup: MoveSetup; target: string; f: Fixture }> {
  const f = await buildFixture({ bigBytes: 200_000 })
  fixtures.push(f)
  const target = join(f.targetParent, 'DSH-Data')
  const setup = prepareMove({ root: f.root, home: f.home, target, sameVolume: false, start: 'pointer' })
  startMove(setup.dir, setup.start, { pid: process.pid, now: new Date() })
  return { setup, target, f }
}

/** Terminal effects in this process that record what they were asked. */
function terminal(): MainEffects & { synced: string[]; restored: TerminalSnapshot[] } {
  const synced: string[] = []
  const restored: TerminalSnapshot[] = []
  return {
    synced,
    restored,
    syncTerminal: async (target) => { synced.push(target); return target },
    restoreTerminal: async (snapshot) => { restored.push(snapshot) },
  }
}

/** The worker request for a setup. */
function requestOf(setup: MoveSetup): Parameters<typeof runMoveExecutor>[0] {
  return { dir: setup.dir, userData: setup.userData, defaultHome: setup.defaultHome, platform: process.platform, locale: 'en', pid: process.pid }
}

describe('the data move on a worker thread', () => {
  posixOnly('switches on the worker, runs the terminal sync in this process, then finishes after the health check', async () => {
    const { setup, target } = await started()
    const main = terminal()
    const progress: MoveProgress[] = []
    const outcome = await runMoveExecutor(requestOf(setup), main, { onProgress: (p) => { progress.push(p) } })
    expect(outcome).toEqual({ kind: 'switched' })
    expect(main.synced).toEqual([target])
    expect(progress.some(p => p.stage === 'copying')).toBe(true)
    expect(readJournal(setup.dir)?.phase).toBe('switched')
    expect(JSON.parse(readFileSync(join(setup.userData, 'data-location.json'), 'utf8'))).toMatchObject({ path: target })
    recordHealth(setup.dir, true)
    expect(await runMoveExecutor(requestOf(setup), main)).toMatchObject({ kind: 'ended', result: { outcome: 'moved' } })
    expect(readJournal(setup.dir)).toBeUndefined()
  })

  posixOnly('rolls back on the worker and hands the snapshot to this process to restore the terminal', async () => {
    const { setup, f } = await started()
    const main = terminal()
    await runMoveExecutor(requestOf(setup), main)
    recordHealth(setup.dir, false)
    expect(await runMoveExecutor(requestOf(setup), main)).toMatchObject({ kind: 'ended', result: { outcome: 'failed' } })
    expect(main.restored).toEqual([setup.start.terminalSnapshot])
    expect(existsSync(join(f.home, '.dsh-data-id'))).toBe(true)
  })

  it('cancels a move asked to cancel before it copied anything', async () => {
    const { setup } = await started()
    const controller = new AbortController()
    controller.abort()
    expect(await runMoveExecutor(requestOf(setup), terminal(), { cancel: controller.signal }))
      .toMatchObject({ kind: 'ended', result: { outcome: 'cancelled' } })
  })
})

describe('the heartbeat', () => {
  it('reports before directory operations, copied entries, removed entries, and waits', async () => {
    const { setup, target, f } = await started()
    let beats = 0
    const effects = nodeMoveEffects({
      userData: setup.userData, defaultHome: setup.defaultHome, platform: process.platform, locale: 'en',
      syncTerminal: async () => undefined, restoreTerminal: async () => undefined, activity: () => { beats += 1 },
    })
    effects.fs.kind(target)
    expect(beats).toBe(1)
    const journal = readJournal(setup.dir)
    if (journal === undefined) throw new Error('no journal')
    const before = beats
    await effects.copy(copyRequestOf(journal, setup.dir, process.platform), new AbortController().signal, () => undefined)
    expect(beats).toBeGreaterThan(before + 5)
    const doomed = join(f.root, 'doomed')
    mkdirSync(doomed)
    writeFileSync(join(doomed, 'a'), 'a')
    const beforeRemove = beats
    await effects.remove(doomed)
    expect(beats).toBeGreaterThan(beforeRemove + 2)
    const beforeSleep = beats
    await effects.sleep(1)
    expect(beats).toBe(beforeSleep + 1)
  })
})

/** A stand-in worker the test drives by hand. */
class FakeThread extends EventEmitter implements ExecutorThread {
  readonly commands: ExecutorCommand[] = []
  terminated = false
  postMessage = (command: ExecutorCommand): void => { this.commands.push(command) }
  terminate = async (): Promise<number> => { this.terminated = true; return 1 }
  send(message: ExecutorMessage): void { this.emit('message', message) }
}

describe('watching the worker', () => {
  const request = { dir: '/d', userData: '/u', defaultHome: '/h', platform: process.platform, locale: 'en' as const, pid: 1 }
  const idle: MainEffects = { syncTerminal: async () => undefined, restoreTerminal: async () => undefined }

  it('gives a silent worker up as hung and asks it to stop', async () => {
    const thread = new FakeThread()
    const run = runMoveExecutor(request, idle, { stallMs: 30, start: () => thread })
    await expect(run).rejects.toMatchObject({ stalled: true })
    expect(thread.terminated).toBe(true)
  })

  it('keeps a worker that reports, and does not count a terminal effect in this process against it', async () => {
    const thread = new FakeThread()
    let release: (() => void) | undefined
    const slow: MainEffects = {
      syncTerminal: () => new Promise((resolve) => { release = () => { resolve('/t') } }),
      restoreTerminal: async () => undefined,
    }
    const run = runMoveExecutor(request, slow, { stallMs: 200, start: () => thread })
    const beat = setInterval(() => { thread.send({ type: 'alive' }) }, 25)
    await new Promise((resolve) => { setTimeout(resolve, 400) })
    clearInterval(beat)
    thread.send({ type: 'call', id: 7, call: { effect: 'syncTerminal', target: '/t' } })
    // A report that arrives while the effect runs does not restart the clock either.
    await new Promise((resolve) => { setTimeout(resolve, 25) })
    thread.send({ type: 'alive' })
    // Longer than the stall limit, with the worker silent: it is waiting for this process.
    await new Promise((resolve) => { setTimeout(resolve, 600) })
    release?.()
    await new Promise((resolve) => { setTimeout(resolve, 25) })
    expect(thread.commands).toContainEqual({ type: 'reply', id: 7, ok: true, value: '/t' })
    thread.send({ type: 'done', outcome: { kind: 'switched' } })
    expect(await run).toEqual({ kind: 'switched' })
    expect(thread.terminated).toBe(false)
  })

  it('carries the worker\'s error name and a failed terminal effect back, and passes a cancel on', async () => {
    const thread = new FakeThread()
    const failing: MainEffects = { syncTerminal: async () => { throw new Error('no shell') }, restoreTerminal: async () => undefined }
    const controller = new AbortController()
    const run = runMoveExecutor(request, failing, { start: () => thread, cancel: controller.signal })
    controller.abort()
    expect(thread.commands).toContainEqual({ type: 'cancel' })
    thread.send({ type: 'call', id: 1, call: { effect: 'syncTerminal', target: '/t' } })
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(thread.commands).toContainEqual({ type: 'reply', id: 1, ok: false, message: 'no shell' })
    thread.send({ type: 'failed', name: 'JournalError', message: 'abandoned copies: not JSON' })
    const error = await run.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ExecutorError)
    expect(error).toMatchObject({ name: 'JournalError', stalled: false })
  })

  it('reports a worker that exits without an answer', async () => {
    const thread = new FakeThread()
    const run = runMoveExecutor(request, idle, { start: () => thread })
    thread.emit('exit', 1)
    await expect(run).rejects.toThrow('exited with code 1')
  })
})
