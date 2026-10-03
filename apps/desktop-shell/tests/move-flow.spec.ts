/**
 * A data move carried with the person in the loop: the progress window
 * follows the worker, a move stopped partway shows its page and applies the
 * person's choice (a choice on a page that is out of date redraws it), a
 * hung or failed move shows why and quits, an unreadable record of
 * abandoned copies is asked about as at launch, and a launch on a move that
 * switched rolls it back when the server does not start on the new location
 * or the location fails its check, except on a new location the person chose
 * to keep, where the move finishes and a page names the kept original. The
 * windows are a recording stand-in; the moves run on real fixture homes and
 * the real worker.
 * @module
 */

import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AbandonedRecordHost, LocationAnswer } from '../src/data-location-boot.ts'
import { DATA_LOCATION_TEXT } from '../src/data-location-text.ts'
import { bootMove, launchOnSwitchedMove, type HealthReading, type SwitchedLaunch } from '../src/move-boot.ts'
import {
  carryMove, rollBackCopyOf, settleForeignLock, type ForeignLockDeps, type MoveFlowDeps, type MoveFlowEnd, type MoveUi,
} from '../src/move-flow.ts'
import { lockLostPage, lockPage, type ForeignLock, type MoveLink, type MovePage, type ProgressView } from '../src/move-page.ts'
import { MOVE_TEXT } from '../src/move-text.ts'
import type { ExecutorCommand, ExecutorMessage, ExecutorRequest, ExecutorThread } from '../src/move/executor.ts'
import { ABANDONED_FILENAME, JOURNAL_FILENAME, readJournal, readMoveResult, type HealthFailures } from '../src/move/journal.ts'
import { acquireMoveLock, inspectMoveLock, LOCK_FILENAME, type LockOwner, type LockProbes, type LockSelf } from '../src/move/lock.ts'
import { advanceMove, recordHealth, startMove, type MoveFs } from '../src/move/run.ts'
import type { TreeCheck } from '../src/process-tree.ts'
import { buildFixture, listTree, type Fixture } from './move-fixture.ts'
import { harnessEffects, plantIntruder, prepareMove, type MoveSetup, type Start } from './move-harness.ts'

const fixtures: Fixture[] = []
const posixOnly = process.platform === 'win32' ? it.skip : it
const text = MOVE_TEXT.en
const LOCK_PROBES: LockProbes = { startTimeOf: async () => undefined, now: () => new Date() }

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await rm(fixture.root, { recursive: true, force: true })
})

/** A started move to another volume. */
async function started(start: Start = 'pointer'): Promise<{ setup: MoveSetup; f: Fixture; target: string }> {
  const f = await buildFixture({ bigBytes: 50_000 })
  fixtures.push(f)
  const target = join(f.targetParent, 'DSH-Data')
  const setup = prepareMove({ root: f.root, home: f.home, target, sameVolume: false, start })
  startMove(setup.dir, setup.start, { pid: process.pid, now: new Date() })
  await acquireMoveLock(f.home, selfOf(setup), LOCK_PROBES)
  return { setup, f, target }
}

/**
 * This installation and process, as the move lock names them.
 * @param setup - the move.
 * @returns the lock's owner fields.
 */
function selfOf(setup: MoveSetup): LockSelf {
  return { userData: setup.userData, pid: process.pid, startedAt: '' }
}

/**
 * The content hash of every file below a directory, links by their text, the move's markers left out.
 * @param root - the directory.
 * @returns the hashes by relative path.
 */
function hashes(root: string): Record<string, string> {
  const found: Record<string, string> = {}
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(root, rel))) {
      if (name.startsWith('.dsh-') || name.startsWith('._')) continue
      const path = join(root, rel, name)
      const stats = lstatSync(path)
      if (stats.isDirectory()) walk(join(rel, name))
      else found[join(rel, name)] = stats.isSymbolicLink() ? `link ${readlinkSync(path)}` : createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk('')
  return found
}

/** A recording stand-in for the windows, answering pages from a queue. */
function recordingUi(answers: Array<Exclude<MoveLink, { kind: 'reveal' }>>): MoveUi & { views: ProgressView[]; pages: MovePage[] } {
  const views: ProgressView[] = []
  const pages: MovePage[] = []
  return {
    views,
    pages,
    cancel: new AbortController().signal,
    showProgress: (view) => { views.push(view) },
    showPage: async (page) => {
      pages.push(page)
      const answer = answers.shift()
      if (answer === undefined) throw new Error(`unexpected page: ${page.title}`)
      return answer
    },
  }
}

/** The launch prompts' host, answering from a queue. */
function abandonedHost(setup: MoveSetup, answers: LocationAnswer[]): AbandonedRecordHost & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    userData: setup.userData, platform: process.platform, text: DATA_LOCATION_TEXT.en, log: () => undefined, reveal: () => undefined,
    ask: async (view) => {
      asked.push(view.message)
      const answer = answers.shift()
      if (answer === undefined) throw new Error(`unexpected prompt: ${view.message}`)
      return answer
    },
  }
}

/** The flow's dependencies for a setup. */
function depsOf(setup: MoveSetup, ui: MoveUi, extra: Partial<MoveFlowDeps> = {}): MoveFlowDeps {
  return {
    request: {
      dir: setup.dir, userData: setup.userData, defaultHome: setup.defaultHome, platform: process.platform, locale: 'en', pid: process.pid,
      lockSelf: selfOf(setup),
    },
    main: { syncTerminal: async target => target, restoreTerminal: async () => undefined },
    ui, text, locale: 'en', abandoned: abandonedHost(setup, []), log: () => undefined, now: () => new Date(),
    lockProbes: { startTimeOf: async () => undefined }, ...extra,
  }
}

describe('carrying a data move', () => {
  posixOnly('follows the copy in the progress window and relaunches onto the new location once switched', async () => {
    const { setup, target } = await started()
    const ui = recordingUi([])
    expect(await carryMove(depsOf(setup, ui))).toEqual({ kind: 'relaunch', home: target })
    expect(ui.views.some(view => view.line.includes('moved') && view.cancellable)).toBe(true)
    expect(ui.views.at(-1)).toMatchObject({ line: text.finishing, cancellable: false })
  })

  posixOnly('relaunches onto the original after a failed health check, and gives the lock back', async () => {
    const { setup, f } = await started()
    await acquireMoveLock(f.home, { userData: setup.userData, pid: process.pid, startedAt: '' }, LOCK_PROBES)
    await carryMove(depsOf(setup, recordingUi([])))
    recordHealth(setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    expect(await carryMove(depsOf(setup, recordingUi([])))).toEqual({ kind: 'relaunch', home: f.home })
    expect(await inspectMoveLock(f.home, { userData: setup.userData }, LOCK_PROBES)).toEqual({ kind: 'none' })
  })

  posixOnly('records a failed health check on the worker before it carries the move back', async () => {
    const { setup, f } = await started()
    await carryMove(depsOf(setup, recordingUi([])))
    const deps = depsOf(setup, recordingUi([]))
    const end = await carryMove({
      ...deps, request: { ...deps.request, before: { kind: 'health-failed', detail: 'sessions missing', failures: ['fewer-sessions'] } },
    })
    expect(end).toEqual({ kind: 'relaunch', home: f.home })
    expect(readJournal(setup.dir)).toBeUndefined()
  })

  posixOnly('shows a move stopped partway, redraws it after a choice it no longer offers, and applies one it does', async () => {
    const { setup, f, target } = await started('default-home')
    await carryMove(depsOf(setup, recordingUi([])))
    const hidden = readJournal(setup.dir)?.hidden ?? ''
    plantIntruder(f.home)
    recordHealth(setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    const ui = recordingUi([{ kind: 'choose', choice: 'rollback' }, { kind: 'choose', choice: 'keep-target' }])
    expect(await carryMove(depsOf(setup, ui))).toEqual({ kind: 'relaunch', home: target })
    const [first, second] = ui.pages
    expect(first?.title).toBe(text.blockedTitle)
    expect(first?.notice).toBeUndefined()
    expect(first?.paragraphs[0]).toBe(text.sourceOccupiedAcross(f.home) + text.alsoAtTarget(target))
    expect(first?.buttons.map(button => button.label)).toEqual([text.keepTarget, text.reveal(process.platform), text.quit])
    expect(first?.reveal).toEqual([hidden])
    expect(second?.notice).toBe(text.refreshed)
    expect(readJournal(setup.dir)?.phase).toBe('switched')
    // A failed health check after keeping the new location finishes the move there, keeps the original, and says so.
    const keptUi = recordingUi([{ kind: 'quit' }])
    const deps = depsOf(setup, keptUi)
    const detail = 'the server did not start on the new location: dsh server printed no URL line within 180s.'
    const end = await carryMove({ ...deps, request: { ...deps.request, before: { kind: 'health-failed', detail, failures: ['not-started'] } } })
    // The journal and the result keep the detail; the page names the failure in the person's words.
    expect(end).toMatchObject({ kind: 'done', outcome: { kind: 'ended', result: { outcome: 'moved', detail } } })
    const kept = readMoveResult(setup.dir)?.keptOriginal?.path
    expect(kept).toBeDefined()
    expect(existsSync(kept ?? '')).toBe(true)
    expect(keptUi.pages).toEqual([{
      title: text.keptTargetTitle,
      paragraphs: [text.keptTarget(target, kept, ['not-started'])],
      buttons: [{ label: text.reveal(process.platform), link: { kind: 'reveal', index: 0 } }, { label: text.quit, link: { kind: 'quit' } }],
      reveal: [kept],
    }])
    expect(text.keptTarget(target, kept, ['not-started'])).toBe(
      `The new location "${target}" you chose to keep did not pass its check: DSH could not start there. `
      + `DSH keeps using it as you chose, and starts from there when you reopen it. Your original data was not deleted; it is kept in "${kept ?? ''}". DSH quits now.`,
    )
  })

  posixOnly('finishes a kept new location\'s cleanup without a page when no failed check was recorded in that run', async () => {
    const { setup, f, target } = await started('default-home')
    await carryMove(depsOf(setup, recordingUi([])))
    plantIntruder(f.home)
    recordHealth(setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    expect(await carryMove(depsOf(setup, recordingUi([{ kind: 'choose', choice: 'keep-target' }])))).toEqual({ kind: 'relaunch', home: target })
    // The failed check recorded by a run that stopped before its cleanup; the launch after it carries the cleanup on.
    recordHealth(setup.dir, { detail: 'sessions 1 < 2', failures: ['fewer-sessions'] })
    expect(readJournal(setup.dir)?.phase).toBe('cleanup')
    const end = await carryMove(depsOf(setup, recordingUi([])))
    expect(end).toMatchObject({ kind: 'done', outcome: { kind: 'ended', result: { outcome: 'moved', detail: 'sessions 1 < 2' } } })
  })

  posixOnly('quits from a stopped move\'s page and leaves the journal', async () => {
    const { setup, f } = await started('default-home')
    await carryMove(depsOf(setup, recordingUi([])))
    plantIntruder(f.home)
    recordHealth(setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    expect(await carryMove(depsOf(setup, recordingUi([{ kind: 'quit' }])))).toEqual({ kind: 'quit' })
    expect(readJournal(setup.dir)?.phase).toBe('rolling-back')
  })
})

describe('the launch on a move that switched', () => {
  const BASELINE = { sessions: 2, workspaces: 0, quarantined: [] }

  /**
   * Launch dependencies that record their calls.
   * @param start - the server's start.
   * @param read - the health reading.
   * @param stop - the stop of the server's tree.
   * @returns the dependencies, the calls in order, the rollbacks' details and failures, and the log lines.
   */
  function launchDeps(start: () => Promise<string>, read: () => HealthReading, stop: () => Promise<TreeCheck> = async () => ({ kind: 'gone' })): {
    deps: SwitchedLaunch<string>
    calls: string[]
    details: string[]
    failures: HealthFailures[]
    lines: string[]
  } {
    const calls: string[] = []
    const details: string[] = []
    const failures: HealthFailures[] = []
    const lines: string[] = []
    return {
      calls,
      details,
      failures,
      lines,
      deps: {
        start: async () => { calls.push('start'); return await start() },
        read: () => { calls.push('read'); return read() },
        stopServerTree: async () => { calls.push('stop'); return await stop() },
        rollBack: async (detail, found) => { calls.push('roll back'); details.push(detail); failures.push(found) },
        pass: () => { calls.push('pass') },
        log: (line) => { lines.push(line) },
      },
    }
  }

  posixOnly('rolls the move back when the server does not start there, so the next launch starts on the original', async () => {
    const { setup, f } = await started()
    await carryMove(depsOf(setup, recordingUi([])))
    const journal = readJournal(setup.dir)
    if (journal === undefined) throw new Error('no journal')
    expect(bootMove(setup.dir).kind).toBe('health-check')
    const deps = depsOf(setup, recordingUi([]))
    let end: MoveFlowEnd | undefined
    const calls: string[] = []
    const outcome = await launchOnSwitchedMove(journal.baseline, {
      start: async () => { calls.push('start'); throw new Error('listen EACCES: permission denied\n<server output>') },
      read: () => { throw new Error('no reading after a failed start') },
      stopServerTree: async () => { calls.push('stop'); return { kind: 'gone' } },
      rollBack: async (detail, failures) => {
        calls.push('roll back')
        expect(failures).toEqual(['not-started'])
        end = await carryMove({ ...deps, request: { ...deps.request, before: { kind: 'health-failed', detail, failures } } })
      },
      pass: () => { throw new Error('no pass after a failed start') },
      log: () => undefined,
    })
    expect(outcome).toEqual({ kind: 'rolled-back' })
    expect(calls).toEqual(['start', 'stop', 'roll back'])
    expect(end).toEqual({ kind: 'relaunch', home: f.home })
    expect(bootMove(setup.dir).kind).toBe('none')
    expect(readMoveResult(setup.dir)).toMatchObject({
      outcome: 'failed', detail: 'the server did not start on the new location: listen EACCES: permission denied',
    })
  })

  it('rolls back when the new location cannot be read, or the check fails, and never records a pass', async () => {
    const unreadable = launchDeps(async () => 'server', () => { throw new Error('EIO: i/o error, scandir') })
    expect(await launchOnSwitchedMove(BASELINE, unreadable.deps)).toEqual({ kind: 'rolled-back' })
    expect(unreadable.calls).toEqual(['start', 'read', 'stop', 'roll back'])
    expect(unreadable.details).toEqual(['the new location could not be read: EIO: i/o error, scandir'])
    expect(unreadable.failures).toEqual([['unreadable']])
    const failing = launchDeps(async () => 'server', () => ({ sessions: 1, quarantined: ['x'] }))
    expect(await launchOnSwitchedMove(BASELINE, failing.deps)).toEqual({ kind: 'rolled-back' })
    expect(failing.calls).toEqual(['start', 'read', 'stop', 'roll back'])
    expect(failing.details).toEqual(['sessions 1 < 2; newly quarantined: x'])
    expect(failing.failures).toEqual([['fewer-sessions', 'plugin-quarantined']])
    expect(failing.lines).toEqual(['[desktop] data move: health check failed: sessions 1 < 2; newly quarantined: x\n'])
  })

  it('still rolls back when the stop before it throws', async () => {
    const launch = launchDeps(async () => { throw new Error('dsh server printed no URL line within 180s.') }, () => BASELINE, async () => {
      throw new Error('taskkill: access denied')
    })
    expect(await launchOnSwitchedMove(BASELINE, launch.deps)).toEqual({ kind: 'rolled-back' })
    expect(launch.calls).toEqual(['start', 'stop', 'roll back'])
    expect(launch.details).toEqual(['the server did not start on the new location: dsh server printed no URL line within 180s.'])
    expect(launch.failures).toEqual([['not-started']])
    expect(launch.lines.join('')).toContain('could not stop the server before the rollback: Error: taskkill: access denied')
  })

  it('records a pass and hands the started server on when the check passes', async () => {
    const launch = launchDeps(async () => 'server', () => ({ sessions: 2, quarantined: [] }))
    expect(await launchOnSwitchedMove(BASELINE, launch.deps)).toEqual({ kind: 'healthy', started: 'server' })
    expect(launch.calls).toEqual(['start', 'read', 'pass'])
  })
})

/** A stand-in worker that answers from a script. */
class ScriptedThread extends EventEmitter implements ExecutorThread {
  /** @param first - what it posts right away; nothing for a worker that hangs. */
  constructor(first?: ExecutorMessage) {
    super()
    if (first !== undefined) setTimeout(() => { this.emit('message', first) }, 1)
  }

  postMessage = (_command: ExecutorCommand): void => undefined
  terminate = async (): Promise<number> => 1
}

describe('a move that cannot go on', () => {
  it('says a hung move stopped and quits', async () => {
    const { setup } = await started()
    const ui = recordingUi([{ kind: 'quit' }])
    expect(await carryMove(depsOf(setup, ui, { start: () => new ScriptedThread(), stallMs: 20 }))).toEqual({ kind: 'quit' })
    expect(ui.pages[0]).toMatchObject({ title: text.stoppedTitle, paragraphs: [text.stalled] })
    expect(readJournal(setup.dir)).toBeDefined()
  })

  it('asks about an unreadable record of abandoned copies as the launch does, then goes on', async () => {
    const { setup, target } = await started()
    mkdirSync(join(setup.dir), { recursive: true })
    writeFileSync(join(setup.dir, ABANDONED_FILENAME), '{')
    const threads = [
      new ScriptedThread({ type: 'failed', name: 'JournalError', message: 'abandoned copies: not JSON' }),
      new ScriptedThread({ type: 'done', outcome: { kind: 'switched' } }),
    ]
    const host = abandonedHost(setup, ['move-aside', 'confirm'])
    const end = await carryMove(depsOf(setup, recordingUi([]), { start: () => threads.shift() ?? new ScriptedThread(), abandoned: host }))
    expect(end).toEqual({ kind: 'relaunch', home: target })
    expect(host.asked).toEqual([DATA_LOCATION_TEXT.en.abandonedUnreadableTitle, DATA_LOCATION_TEXT.en.confirmMoveAsideTitle])
    expect(existsSync(join(setup.dir, ABANDONED_FILENAME))).toBe(false)
  })

  it('quits when the person quits from that question', async () => {
    const { setup } = await started()
    writeFileSync(join(setup.dir, ABANDONED_FILENAME), '{')
    const thread = new ScriptedThread({ type: 'failed', name: 'JournalError', message: 'abandoned copies: not JSON' })
    const end = await carryMove(depsOf(setup, recordingUi([]), { start: () => thread, abandoned: abandonedHost(setup, ['quit']) }))
    expect(end).toEqual({ kind: 'quit' })
  })

  it('keeps the move lock\'s heartbeat while the move runs, in the place the lock is, and stops with the move', async () => {
    const { setup, f } = await started()
    // A move resumed after a relaunch: the journal and the lock both name the earlier process.
    writeFileSync(join(f.home, LOCK_FILENAME), JSON.stringify({ userData: setup.userData, pid: 999, startedAt: '', heartbeatAt: '2026-01-01T00:00:00Z' }))
    writeFileSync(join(setup.dir, JOURNAL_FILENAME), JSON.stringify({ ...readJournal(setup.dir), phase: 'copying', pid: 999 }))
    const thread = new ScriptedThread()
    setTimeout(() => { thread.emit('message', { type: 'done', outcome: { kind: 'switched' } }) }, 80)
    let clock = 0
    const end = await carryMove(depsOf(setup, recordingUi([]), {
      start: () => thread, heartbeatMs: 10, now: () => new Date(Date.UTC(2026, 8, 28, 0, 0, clock += 1)),
    }))
    expect(end.kind).toBe('relaunch')
    const lock = JSON.parse(readFileSync(join(f.home, LOCK_FILENAME), 'utf8')) as { pid: number; heartbeatAt: string }
    expect(lock.pid).toBe(process.pid)
    expect(Date.parse(lock.heartbeatAt)).toBeGreaterThan(Date.UTC(2026, 8, 28, 0, 0, 2))
    const settled = readFileSync(join(f.home, LOCK_FILENAME), 'utf8')
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(readFileSync(join(f.home, LOCK_FILENAME), 'utf8')).toBe(settled)
    expect(existsSync(join(f.targetParent, LOCK_FILENAME))).toBe(false)
  })

  it('hands the person\'s choice to the worker with what the page showed, once, and goes on from the journal the worker left', async () => {
    const { setup, target } = await started()
    const journal = readJournal(setup.dir)
    if (journal === undefined) throw new Error('no journal')
    const blocked: ExecutorMessage = {
      type: 'done', outcome: { kind: 'blocked', reason: 'target-occupied', dataAt: [journal.source], choices: ['rollback'], targetPrint: null },
    }
    const result = { version: journal.version, moveId: journal.moveId, outcome: 'moved' as const, source: journal.source, target, leftovers: [] }
    const requests: ExecutorRequest[] = []
    const threads: Array<() => ScriptedThread> = [
      () => new ScriptedThread(blocked),
      () => {
        const thread = new ScriptedThread({ type: 'prepared', prepared: { result: 'applied', journal: { ...journal, phase: 'cleanup' } } })
        setTimeout(() => { thread.emit('message', { type: 'done', outcome: { kind: 'ended', result } }) }, 5)
        return thread
      },
    ]
    const logged: string[] = []
    const end = await carryMove(depsOf(setup, recordingUi([{ kind: 'choose', choice: 'rollback' }]), {
      start: (request) => { requests.push(request); return (threads.shift() ?? (() => new ScriptedThread()))() },
      log: (line) => { logged.push(line) },
    }))
    expect(requests.map(request => request.before)).toEqual([
      undefined, { kind: 'resolve', choice: 'rollback', seen: { reason: 'target-occupied', targetPrint: null } },
    ])
    expect(end).toEqual({ kind: 'done', outcome: { kind: 'ended', result } })
    expect(logged.some(line => line.includes('the person\'s choice: applied'))).toBe(true)
  })

  it('takes the step before the move only once, even when the move has to start again', async () => {
    const { setup, target } = await started()
    writeFileSync(join(setup.dir, ABANDONED_FILENAME), '{')
    const requests: ExecutorRequest[] = []
    const threads = [
      () => {
        const thread = new ScriptedThread({ type: 'prepared', prepared: { result: 'recorded', journal: readJournal(setup.dir) } })
        setTimeout(() => { thread.emit('message', { type: 'failed', name: 'JournalError', message: 'abandoned copies: not JSON' }) }, 5)
        return thread
      },
      () => new ScriptedThread({ type: 'done', outcome: { kind: 'switched' } }),
    ]
    const deps = depsOf(setup, recordingUi([]), {
      start: (request) => { requests.push(request); return (threads.shift() ?? (() => new ScriptedThread()))() },
      abandoned: abandonedHost(setup, ['move-aside', 'confirm']),
    })
    const end = await carryMove({ ...deps, request: { ...deps.request, before: { kind: 'health-failed', detail: 'x', failures: ['unreadable'] } } })
    expect(end).toEqual({ kind: 'relaunch', home: target })
    expect(requests.map(request => request.before)).toEqual([{ kind: 'health-failed', detail: 'x', failures: ['unreadable'] }, undefined])
  })

  posixOnly('stops a copy whose lock was discarded, tries it again on request, and abandons it: the copy goes and the original opens as before', async () => {
    const { setup, f, target } = await started()
    writeFileSync(join(setup.dir, JOURNAL_FILENAME), JSON.stringify({ ...readJournal(setup.dir), phase: 'copying' }))
    unlinkSync(join(f.home, LOCK_FILENAME))
    const before = listTree(f.home)
    const stopped = recordingUi([{ kind: 'retry' }, { kind: 'quit' }])
    expect(await carryMove(depsOf(setup, stopped))).toEqual({ kind: 'quit' })
    expect(stopped.pages).toHaveLength(2)
    expect(stopped.pages[0]).toEqual({
      title: text.lockLostTitle, paragraphs: [text.lockLost, text.abandonNote], reveal: [],
      buttons: [
        { label: text.retry, link: { kind: 'retry' } }, { label: text.abandonMove, link: { kind: 'abandon' } },
        { label: text.quit, link: { kind: 'quit' } },
      ],
    })
    expect(readJournal(setup.dir)?.phase).toBe('copying')
    const abandoned = recordingUi([{ kind: 'abandon' }])
    expect(await carryMove(depsOf(setup, abandoned))).toEqual({ kind: 'relaunch', home: f.home })
    expect(readJournal(setup.dir)).toBeUndefined()
    expect(listTree(f.home)).toEqual(before)
    expect(existsSync(target)).toBe(false)
    expect(readdirSync(f.targetParent).filter(name => name.startsWith('.dsh-data.partial') || name.includes('DSH-Data'))).toEqual([])
  })

  it('tries again without a page when the lock reads as the move\'s again, once in a row, then says why each time', async () => {
    const { setup, f, target } = await started()
    writeFileSync(join(setup.dir, JOURNAL_FILENAME), JSON.stringify({ ...readJournal(setup.dir), phase: 'hiding-source' }))
    const lost = (): ScriptedThread => new ScriptedThread({ type: 'failed', name: 'MoveLockLostError', message: 'lost' })
    const threads = [lost(), lost(), lost(), lost(), new ScriptedThread({ type: 'done', outcome: { kind: 'switched' } })]
    const self = selfOf(setup)
    const sibling = { ...self, pid: 22222, startedAt: 'P2', heartbeatAt: new Date().toISOString() }
    const ui: MoveUi & { pages: MovePage[] } = recordingUi([{ kind: 'retry' }, { kind: 'retry' }, { kind: 'retry' }])
    const answer = ui.showPage
    let shown = 0
    // Each page is answered with the lock put in the state the next page is about.
    ui.showPage = async (page) => {
      shown += 1
      if (shown === 1) writeFileSync(join(f.home, LOCK_FILENAME), JSON.stringify(sibling))
      if (shown === 2) writeFileSync(join(f.home, LOCK_FILENAME), JSON.stringify({ ...sibling, userData: '/u/other' }))
      if (shown === 3) writeFileSync(join(f.home, LOCK_FILENAME), JSON.stringify({ ...self, heartbeatAt: new Date().toISOString() }))
      return await answer(page)
    }
    const deps = depsOf(setup, ui, { start: () => threads.shift() ?? new ScriptedThread(), lockProbes: { startTimeOf: async pid => pid === 22222 ? 'P2' : undefined } })
    expect(await carryMove(deps)).toEqual({ kind: 'relaunch', home: target })
    expect(ui.pages.map(page => [page.title, page.paragraphs[0]])).toEqual([
      // The first loss read as the move's again and was tried again alone; the second in a row could not be read.
      [text.lockUncheckedTitle, text.lockUnchecked],
      [text.lockSiblingTitle, text.lockSibling],
      [text.lockLostTitle, text.lockLost],
    ])
    expect(ui.pages[0]).toMatchObject({
      paragraphs: [text.lockUnchecked, text.rollBackNote('unreachable')],
      buttons: [
        { label: text.retry, link: { kind: 'retry' } }, { label: text.rollBackMove, link: { kind: 'roll-back' } },
        { label: text.quit, link: { kind: 'quit' } },
      ],
    })
    expect(threads).toEqual([])
    // A single loss that reads as the move's again: no page at all.
    const again = await started()
    writeFileSync(join(again.setup.dir, JOURNAL_FILENAME), JSON.stringify({ ...readJournal(again.setup.dir), phase: 'hiding-source' }))
    const once = [lost(), new ScriptedThread({ type: 'done', outcome: { kind: 'switched' } })]
    const quiet = recordingUi([])
    expect(await carryMove(depsOf(again.setup, quiet, { start: () => once.shift() ?? new ScriptedThread() }))).toEqual({ kind: 'relaunch', home: again.target })
    expect(quiet.pages).toEqual([])
  })

  it('tries a lost lock again alone once more after a run that completed in between', async () => {
    const { setup, target } = await started()
    const journal = readJournal(setup.dir)
    if (journal === undefined) throw new Error('no journal')
    writeFileSync(join(setup.dir, JOURNAL_FILENAME), JSON.stringify({ ...journal, phase: 'hiding-source' }))
    const lost = (): ScriptedThread => new ScriptedThread({ type: 'failed', name: 'MoveLockLostError', message: 'lost' })
    const blocked: ExecutorMessage = {
      type: 'done', outcome: { kind: 'blocked', reason: 'target-occupied', dataAt: [journal.source], choices: ['rollback'], targetPrint: null },
    }
    // Lost, tried again alone; that run completes (blocked, answered); lost again, which is again the first in a row.
    const threads = [lost(), new ScriptedThread(blocked), lost(), new ScriptedThread({ type: 'done', outcome: { kind: 'switched' } })]
    const ui = recordingUi([{ kind: 'choose', choice: 'rollback' }])
    expect(await carryMove(depsOf(setup, ui, { start: () => threads.shift() ?? new ScriptedThread() }))).toEqual({ kind: 'relaunch', home: target })
    expect(ui.pages.map(page => page.title)).toEqual([text.blockedTitle])
    expect(threads).toEqual([])
  })

  it('says what taking the move back does with the copy at the new location', async () => {
    const { setup } = await started()
    const journal = readJournal(setup.dir)
    if (journal === undefined) throw new Error('no journal')
    const there: Pick<MoveFs, 'kind'> = { kind: () => 'dir' }
    const away: Pick<MoveFs, 'kind'> = { kind: () => 'absent' }
    expect(rollBackCopyOf({ ...journal, sameVolume: true }, there)).toBe('none')
    expect(rollBackCopyOf({ ...journal, targetExposed: false }, there)).toBe('deleted')
    expect(rollBackCopyOf({ ...journal, targetExposed: true }, there)).toBe('kept')
    expect(rollBackCopyOf({ ...journal, targetExposed: false }, away)).toBe('unreachable')
    expect(rollBackCopyOf({ ...journal, targetExposed: true }, away)).toBe('unreachable-exposed')
    // A copy whose removal was given up is left where it is, whether it can be found and whether it was used.
    const givenUp = { path: journal.target, bytes: 1 }
    expect(rollBackCopyOf({ ...journal, leftovers: [givenUp] }, there)).toBe('unreachable')
    expect(rollBackCopyOf({ ...journal, targetExposed: true, leftovers: [givenUp] }, there)).toBe('unreachable')
    expect(rollBackCopyOf({ ...journal, targetExposed: true, leftovers: [givenUp] }, away)).toBe('unreachable')
    expect(rollBackCopyOf({ ...journal, leftovers: [{ path: join(journal.target, 'sessions', 'x'), bytes: 1 }] }, there)).toBe('unreachable')
    expect(rollBackCopyOf({ ...journal, leftovers: [{ path: `${journal.target}-other`, bytes: 1 }] }, there)).toBe('deleted')
    const copies = ['none', 'deleted', 'kept', 'unreachable', 'unreachable-exposed'] as const
    for (const set of [MOVE_TEXT.zh, MOVE_TEXT.en]) {
      const notes = copies.map(copy => set.rollBackNote(copy))
      expect(new Set(notes).size).toBe(5)
      for (const copy of copies) {
        expect(lockLostPage(set, 'missing', { kind: 'roll-back', copy }).paragraphs[1]).toBe(set.rollBackNote(copy))
      }
    }
    expect(MOVE_TEXT.zh.rollBackNote('none')).toContain('不会删除任何东西')
    expect(MOVE_TEXT.zh.rollBackNote('kept')).toContain('改个名字留下')
    expect(MOVE_TEXT.zh.rollBackNote('deleted')).toContain('删掉')
    expect(MOVE_TEXT.zh.rollBackNote('unreachable')).toContain('原样留在那里')
    expect(MOVE_TEXT.zh.rollBackNote('unreachable-exposed')).toContain('再问你一次')
    expect(MOVE_TEXT.en.rollBackNote('unreachable-exposed')).toContain('asks you again')
  })

  it('names each failure of a kept new location in the person\'s language, joined into one sentence', () => {
    const failures = ['not-started', 'unreadable', 'fewer-sessions', 'plugin-quarantined', 'workspaces-differ'] as const
    for (const set of [MOVE_TEXT.zh, MOVE_TEXT.en]) {
      const sentences = failures.map(failure => set.keptTarget('/T', undefined, [failure]))
      expect(new Set(sentences).size).toBe(failures.length)
    }
    expect(MOVE_TEXT.zh.keptTarget('/Volumes/T7/DSH', '/Users/a/DSH 原来的数据', ['fewer-sessions', 'plugin-quarantined'])).toBe(
      '你选择保留的新位置「/Volumes/T7/DSH」没有通过检查：这里的对话比搬运前少；有插件在这里没能加载。'
      + 'DSH 按你的选择继续使用这个位置，重新打开 DSH 时仍从这里启动。原来的数据没有删除，保留在「/Users/a/DSH 原来的数据」。DSH 现在退出。',
    )
    expect(MOVE_TEXT.en.keptTarget('/T', undefined, ['unreadable', 'workspaces-differ'])).toBe(
      'The new location "/T" you chose to keep did not pass its check: the data there could not be read; '
      + 'it holds a different number of workspaces than before the move. DSH keeps using it as you chose, and starts from there when you reopen it. DSH quits now.',
    )
  })

  posixOnly('takes back a move stopped while hiding the original after its lock was discarded, keeping what was written there since', async () => {
    const { setup, f, target } = await started()
    const originals = hashes(f.home)
    // Run until the original gave up its identity and took this move's marker, just before it is renamed.
    const stop = new Error('stop here')
    await advanceMove(setup.dir, harnessEffects(setup), {
      pid: process.pid,
      guard: (journal, facts) => { if (journal.phase === 'hiding-source' && facts.source.movedId && facts.source.state === 'ours') throw stop },
    }).catch((error: unknown) => { if (error !== stop) throw error })
    expect(existsSync(join(f.home, '.dsh-data-id'))).toBe(false)
    // Another installation discarded the lock and wrote to the data.
    unlinkSync(join(f.home, LOCK_FILENAME))
    writeFileSync(join(f.home, 'other-work.txt'), 'written by another DSH')
    const seen: Array<{ phase: string | undefined; hidden: boolean }> = []
    const ui = recordingUi([{ kind: 'roll-back' }])
    const answer = ui.showPage
    ui.showPage = async (page) => {
      const journal = readJournal(setup.dir)
      seen.push({ phase: journal?.phase, hidden: existsSync(journal?.hidden ?? '') })
      return await answer(page)
    }
    expect(await carryMove(depsOf(setup, ui))).toEqual({ kind: 'relaunch', home: f.home })
    expect(seen).toEqual([{ phase: 'hiding-source', hidden: false }])
    expect(ui.pages[0]?.title).toBe(text.lockLostTitle)
    expect(readJournal(setup.dir)).toBeUndefined()
    expect(existsSync(join(f.home, '.dsh-data-id'))).toBe(true)
    const after = hashes(f.home)
    expect(after['other-work.txt']).toBeDefined()
    delete after['other-work.txt']
    expect(after).toEqual(originals)
    expect(existsSync(target)).toBe(false)
  })

  posixOnly('goes on after a relaunch that was itself cut short left its own lock behind', async () => {
    const { setup, f, target } = await started()
    // The first run recorded itself and copied; a relaunch refreshed the lock and was killed before it recorded itself.
    writeFileSync(join(setup.dir, JOURNAL_FILENAME), JSON.stringify({ ...readJournal(setup.dir), phase: 'copying', pid: 11111 }))
    writeFileSync(join(f.home, LOCK_FILENAME), JSON.stringify({ userData: setup.userData, pid: 22222, startedAt: 'P2', heartbeatAt: new Date().toISOString() }))
    expect(await carryMove(depsOf(setup, recordingUi([])))).toEqual({ kind: 'relaunch', home: target })
  })

  it('shows any other failure with its detail and quits', async () => {
    const { setup } = await started()
    const ui = recordingUi([{ kind: 'quit' }])
    const thread = new ScriptedThread({ type: 'failed', name: 'MoveStuckError', message: 'data move made no progress: copying: copy' })
    expect(await carryMove(depsOf(setup, ui, { start: () => thread }))).toEqual({ kind: 'quit' })
    expect(ui.pages[0]?.paragraphs[0]).toBe(text.failed('data move made no progress: copying: copy'))
  })
})

describe('another installation\'s lock on the data', () => {
  const other: LockOwner = { userData: '/u/other', pid: 222, startedAt: 'T', heartbeatAt: '2026-09-28T00:00:00.000Z' }

  /**
   * The flow's dependencies, reading the lock back with the real inspection.
   * @param ui - the recording windows.
   * @param lock - the lock the first page shows.
   * @param home - the data directory.
   * @param now - the clock the inspection compares the heartbeat with.
   * @returns the dependencies.
   */
  function lockDeps(ui: MoveUi, lock: ForeignLock, home: string, now = new Date('2026-09-28T00:01:30.000Z')): ForeignLockDeps {
    const probes: LockProbes = { startTimeOf: async () => undefined, now: () => now }
    return { ui, text, lock, home, platform: 'darwin', log: () => undefined, inspect: () => inspectMoveLock(home, { userData: '/u/this' }, probes) }
  }

  /** A data directory holding the other installation's lock. */
  async function locked(): Promise<{ home: string; path: string }> {
    const f = await buildFixture({ bigBytes: 10 })
    fixtures.push(f)
    const path = join(f.home, LOCK_FILENAME)
    writeFileSync(path, `${JSON.stringify(other)}\n`)
    return { home: f.home, path }
  }

  it('shows the lock file of an unfinished move and offers to discard that move; a running one and an unreadable one only quit', () => {
    const page = lockPage(text, { kind: 'unfinished', owner: other, path: '/d/.dsh-move.lock' }, '/d', 'darwin')
    expect(page).toEqual({
      title: text.unfinishedTitle,
      paragraphs: [text.unfinished('/d', '/u/other')],
      buttons: [
        { label: text.reveal('darwin'), link: { kind: 'reveal', index: 0 } },
        { label: text.discardMove, link: { kind: 'discard-lock' } },
        { label: text.quit, link: { kind: 'quit' } },
      ],
      reveal: ['/d/.dsh-move.lock'],
    })
    const held = lockPage(text, { kind: 'held', owner: other }, '/d', 'darwin')
    expect(held).toMatchObject({ title: text.lockedTitle, paragraphs: [text.locked('/d', '/u/other')], reveal: [] })
    expect(held.buttons.map(button => button.link.kind)).toEqual(['quit'])
    const unreadable = lockPage(text, { kind: 'unreadable', path: '/d/.dsh-move.lock', detail: 'x' }, '/d', 'win32')
    expect(unreadable).toMatchObject({ paragraphs: [text.lockUnreadable('/d/.dsh-move.lock')], reveal: ['/d/.dsh-move.lock'] })
    expect(unreadable.buttons.map(button => button.link.kind)).toEqual(['reveal', 'quit'])
  })

  it('removes only the lock file, and only after the person confirms', async () => {
    const { home, path } = await locked()
    const before = readdirSync(home).sort()
    const ui = recordingUi([{ kind: 'discard-lock' }, { kind: 'confirm' }])
    const end = await settleForeignLock(lockDeps(ui, { kind: 'unfinished', owner: other, path }, home))
    expect(end).toBe('discarded')
    expect(ui.pages.map(page => page.title)).toEqual([text.unfinishedTitle, text.confirmDiscardTitle])
    expect(ui.pages[1]).toMatchObject({
      paragraphs: [text.confirmDiscard(path, '/u/other')],
      buttons: [{ label: text.confirmDiscardButton, link: { kind: 'confirm' } }, { label: text.back, link: { kind: 'back' } }],
    })
    expect(readdirSync(home).sort()).toEqual(before.filter(name => name !== LOCK_FILENAME))
  })

  it('keeps the lock when the person goes back and quits, or quits or closes the window on the confirmation', async () => {
    const { home, path } = await locked()
    const lock = { kind: 'unfinished' as const, owner: other, path }
    const back = recordingUi([{ kind: 'discard-lock' }, { kind: 'back' }, { kind: 'quit' }])
    expect(await settleForeignLock(lockDeps(back, lock, home))).toBe('quit')
    expect(back.pages.map(page => page.title)).toEqual([text.unfinishedTitle, text.confirmDiscardTitle, text.unfinishedTitle])
    expect(existsSync(path)).toBe(true)
    // Closing the window answers the page with quit.
    const quit = recordingUi([{ kind: 'discard-lock' }, { kind: 'quit' }])
    expect(await settleForeignLock(lockDeps(quit, lock, home))).toBe('quit')
    expect(quit.pages).toHaveLength(2)
    expect(existsSync(path)).toBe(true)
  })

  it('shows the lock again, marked as updated, when its holder refreshed it while the page was open, and never relaunches', async () => {
    const { home, path } = await locked()
    const lock = { kind: 'unfinished' as const, owner: other, path }
    // That installation came back and refreshed its heartbeat after the page was drawn.
    const fresh = `${JSON.stringify({ ...other, heartbeatAt: '2026-09-28T00:01:00.000Z' })}\n`
    writeFileSync(path, fresh)
    const ui = recordingUi([{ kind: 'discard-lock' }, { kind: 'confirm' }, { kind: 'quit' }])
    expect(await settleForeignLock(lockDeps(ui, lock, home))).toBe('quit')
    expect(readFileSync(path, 'utf8')).toBe(fresh)
    expect(ui.pages[2]).toMatchObject({ title: text.lockedTitle, notice: text.refreshed })
    // Refreshed, but stale again by the time it is read back: its page comes back with the notice, and a second confirmation removes it.
    const later = recordingUi([{ kind: 'discard-lock' }, { kind: 'confirm' }, { kind: 'discard-lock' }, { kind: 'confirm' }])
    expect(await settleForeignLock(lockDeps(later, lock, home, new Date('2026-09-28T01:00:00.000Z')))).toBe('discarded')
    expect(later.pages.map(page => page.notice)).toEqual([undefined, undefined, text.refreshed, undefined])
    expect(existsSync(path)).toBe(false)
  })

  it('never offers to discard a lock whose process still runs', async () => {
    const { home, path } = await locked()
    const ui = recordingUi([{ kind: 'discard-lock' }])
    expect(await settleForeignLock(lockDeps(ui, { kind: 'held', owner: other }, home))).toBe('quit')
    expect(ui.pages).toHaveLength(1)
    expect(existsSync(path)).toBe(true)
  })
})
