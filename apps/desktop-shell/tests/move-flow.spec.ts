/**
 * A data move carried with the person in the loop: the progress window
 * follows the worker, a move stopped partway shows its page and applies the
 * person's choice (a choice on a page that is out of date redraws it), a
 * hung or failed move shows why and quits, and an unreadable record of
 * abandoned copies is asked about as at launch. The windows are a recording
 * stand-in; the moves run on real fixture homes and the real worker.
 * @module
 */

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AbandonedRecordHost, LocationAnswer } from '../src/data-location-boot.ts'
import { DATA_LOCATION_TEXT } from '../src/data-location-text.ts'
import { carryMove, settleForeignLock, type ForeignLockDeps, type MoveFlowDeps, type MoveUi } from '../src/move-flow.ts'
import { lockPage, type ForeignLock, type MoveLink, type MovePage, type ProgressView } from '../src/move-page.ts'
import { MOVE_TEXT } from '../src/move-text.ts'
import type { ExecutorCommand, ExecutorMessage, ExecutorRequest, ExecutorThread } from '../src/move/executor.ts'
import { ABANDONED_FILENAME, readJournal } from '../src/move/journal.ts'
import { acquireMoveLock, inspectMoveLock, LOCK_FILENAME, type LockOwner, type LockProbes } from '../src/move/lock.ts'
import { recordHealth, startMove } from '../src/move/run.ts'
import { buildFixture, type Fixture } from './move-fixture.ts'
import { plantIntruder, prepareMove, type MoveSetup, type Start } from './move-harness.ts'

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
  return { setup, f, target }
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
    request: { dir: setup.dir, userData: setup.userData, defaultHome: setup.defaultHome, platform: process.platform, locale: 'en', pid: process.pid },
    main: { syncTerminal: async target => target, restoreTerminal: async () => undefined },
    ui, text, locale: 'en', abandoned: abandonedHost(setup, []), log: () => undefined, now: () => new Date(),
    lockSelf: { userData: setup.userData, pid: process.pid, startedAt: '' }, ...extra,
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
    recordHealth(setup.dir, false)
    expect(await carryMove(depsOf(setup, recordingUi([])))).toEqual({ kind: 'relaunch', home: f.home })
    expect(await inspectMoveLock(f.home, { userData: setup.userData }, LOCK_PROBES)).toEqual({ kind: 'none' })
  })

  posixOnly('records a failed health check on the worker before it carries the move back', async () => {
    const { setup, f } = await started()
    await carryMove(depsOf(setup, recordingUi([])))
    const deps = depsOf(setup, recordingUi([]))
    const end = await carryMove({ ...deps, request: { ...deps.request, before: { kind: 'health-failed', detail: 'sessions missing' } } })
    expect(end).toEqual({ kind: 'relaunch', home: f.home })
    expect(readJournal(setup.dir)).toBeUndefined()
  })

  posixOnly('shows a move stopped partway, redraws it after a choice it no longer offers, and applies one it does', async () => {
    const { setup, f, target } = await started('default-home')
    await carryMove(depsOf(setup, recordingUi([])))
    const hidden = readJournal(setup.dir)?.hidden ?? ''
    plantIntruder(f.home)
    recordHealth(setup.dir, false)
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
    // A failed health check after keeping the new location keeps the original and ends in the background cleanup.
    const deps = depsOf(setup, recordingUi([]))
    const end = await carryMove({ ...deps, request: { ...deps.request, before: { kind: 'health-failed', detail: 'x' } } })
    expect(end).toMatchObject({ kind: 'done', outcome: { kind: 'ended' } })
  })

  posixOnly('quits from a stopped move\'s page and leaves the journal', async () => {
    const { setup, f } = await started('default-home')
    await carryMove(depsOf(setup, recordingUi([])))
    plantIntruder(f.home)
    recordHealth(setup.dir, false)
    expect(await carryMove(depsOf(setup, recordingUi([{ kind: 'quit' }])))).toEqual({ kind: 'quit' })
    expect(readJournal(setup.dir)?.phase).toBe('rolling-back')
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
    writeFileSync(join(f.home, LOCK_FILENAME), JSON.stringify({ userData: setup.userData, pid: 999, startedAt: '', heartbeatAt: '2026-01-01T00:00:00Z' }))
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
    const end = await carryMove({ ...deps, request: { ...deps.request, before: { kind: 'health-failed', detail: 'x' } } })
    expect(end).toEqual({ kind: 'relaunch', home: target })
    expect(requests.map(request => request.before)).toEqual([{ kind: 'health-failed', detail: 'x' }, undefined])
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
