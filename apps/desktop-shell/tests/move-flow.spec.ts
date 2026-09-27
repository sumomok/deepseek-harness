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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AbandonedRecordHost, LocationAnswer } from '../src/data-location-boot.ts'
import { DATA_LOCATION_TEXT } from '../src/data-location-text.ts'
import { carryMove, type MoveFlowDeps, type MoveUi } from '../src/move-flow.ts'
import type { MoveLink, MovePage, ProgressView } from '../src/move-page.ts'
import { MOVE_TEXT } from '../src/move-text.ts'
import type { ExecutorCommand, ExecutorMessage, ExecutorThread } from '../src/move/executor.ts'
import { ABANDONED_FILENAME, readJournal } from '../src/move/journal.ts'
import { acquireMoveLock, inspectMoveLock } from '../src/move/lock.ts'
import { recordHealth, startMove } from '../src/move/run.ts'
import { buildFixture, type Fixture } from './move-fixture.ts'
import { plantIntruder, prepareMove, type MoveSetup, type Start } from './move-harness.ts'

const fixtures: Fixture[] = []
const posixOnly = process.platform === 'win32' ? it.skip : it
const text = MOVE_TEXT.en

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
    ui, text, locale: 'en', abandoned: abandonedHost(setup, []), log: () => undefined, now: () => new Date(), ...extra,
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
    acquireMoveLock(f.home, { userData: setup.userData, pid: process.pid }, () => true)
    await carryMove(depsOf(setup, recordingUi([])))
    recordHealth(setup.dir, false)
    expect(await carryMove(depsOf(setup, recordingUi([])))).toEqual({ kind: 'relaunch', home: f.home })
    expect(inspectMoveLock(f.home, { userData: setup.userData, pid: process.pid }, () => true)).toEqual({ kind: 'none' })
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

  it('shows any other failure with its detail and quits', async () => {
    const { setup } = await started()
    const ui = recordingUi([{ kind: 'quit' }])
    const thread = new ScriptedThread({ type: 'failed', name: 'MoveStuckError', message: 'data move made no progress: copying: copy' })
    expect(await carryMove(depsOf(setup, ui, { start: () => thread }))).toEqual({ kind: 'quit' })
    expect(ui.pages[0]?.paragraphs[0]).toBe(text.failed('data move made no progress: copying: copy'))
  })
})
