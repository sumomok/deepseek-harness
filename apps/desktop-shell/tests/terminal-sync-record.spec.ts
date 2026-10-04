/**
 * The record a data move leaves of its terminal write, and what `/state`
 * reports as `terminal` on each launch: the launch's own write, the record on
 * the launches that finish the move, or nothing. The durable write is wrapped
 * so a test can make the record's write fail.
 * @module
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalSync, TerminalSyncHost } from '../src/data-location-boot.ts'
import * as durableFile from '../src/durable-file.ts'
import type { BootMove } from '../src/move-boot.ts'
import { JOURNAL_VERSION, writeJournal, type MoveId, type MoveJournal, type MoveResult } from '../src/move/journal.ts'
import type { ExplicitRead, TerminalWrite } from '../src/terminal-env.ts'
import {
  parseTerminalSync, syncMoveTerminal, TERMINAL_SYNC_FILENAME, TERMINAL_SYNC_VERSION, terminalForLaunch, type TerminalSyncLaunch,
} from '../src/terminal-sync-record.ts'

/** Whether the next durable write throws. */
const failing = vi.hoisted(() => ({ write: false }))

vi.mock('../src/durable-file.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof durableFile>()
  return {
    ...actual,
    writeDurably: (...args: Parameters<typeof actual.writeDurably>) => {
      if (failing.write) throw new Error('injected: the disk is full')
      actual.writeDurably(...args)
    },
  }
})

const posixOnly = process.platform === 'win32' ? it.skip : it

let root = ''

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-terminal-sync-record-')))
  expect(root.startsWith(realpathSync(tmpdir()))).toBe(true)
})

afterEach(async () => {
  failing.write = false
  chmodSync(root, 0o700)
  await rm(root, { recursive: true, force: true })
})

const HOME = '/Users/me/DSH-Data'
const MOVE = 'move-1' as MoveId
const WRITTEN: TerminalWrite = { kind: 'profile', update: { kind: 'written', file: '/Users/me/.zshrc', backup: '/Users/me/.zshrc.dsh-backup' } }
const SYNCED: TerminalSync = { kind: 'synced', value: HOME, write: WRITTEN }
const OVERRIDDEN: TerminalSync = { kind: 'overridden', value: HOME, write: WRITTEN, reported: '/elsewhere' }

/**
 * The record's path.
 * @returns it.
 */
function recordFile(): string {
  return join(root, TERMINAL_SYNC_FILENAME)
}

/** A log that must stay silent. */
function noLog(): void {
  throw new Error('nothing to log')
}

/** One of each outcome, every write kind among them. */
const OUTCOMES: TerminalSync[] = [
  SYNCED,
  { kind: 'synced', value: HOME, write: { kind: 'user-environment' } },
  OVERRIDDEN,
  { kind: 'overridden', value: HOME, write: WRITTEN, reported: undefined },
  { kind: 'unconfirmed', value: HOME, write: { kind: 'profile', update: { kind: 'unchanged', file: '/Users/me/.zshrc' } }, detail: 'timed out' },
  {
    kind: 'not-written', value: HOME,
    write: { kind: 'profile', update: { kind: 'foreign-assignment', file: '/Users/me/.zshrc', places: [{ file: '/Users/me/.zshrc', line: 12 }] } },
  },
  { kind: 'not-written', value: HOME, write: { kind: 'profile', update: { kind: 'damaged-block', file: '/Users/me/.zshrc' } } },
  { kind: 'not-written', value: HOME, write: { kind: 'profile', update: { kind: 'unsupported-shell', shell: '/usr/bin/fish' } } },
  { kind: 'not-written', value: HOME, write: { kind: 'profile', update: { kind: 'dangling-profile', link: '/Users/me/.zshrc' } } },
  { kind: 'not-written', value: HOME, write: { kind: 'unsupported-platform', platform: 'linux' } },
  { kind: 'failed', value: HOME, detail: 'Error: PowerShell exited with 1' },
]

/**
 * A journal for a move to {@link HOME} in phase `switching`.
 * @param moveId - the move.
 * @param lastSeenEnvBefore - `DSH_HOME` as last seen before the move, if any.
 * @returns the journal.
 */
function journalOf(moveId: MoveId = MOVE, lastSeenEnvBefore?: string): MoveJournal {
  return {
    version: JOURNAL_VERSION, moveId, phase: 'switching', pid: 1, source: '/s', sourceAliases: ['/s'], target: HOME,
    targetPreexisting: false, partial: '/p', hidden: '/h', sameVolume: false, dataId: '11111111-2222-4333-8444-555555555555' as MoveJournal['dataId'],
    pointerBefore: {}, terminalBefore: { kind: 'unset' }, terminalSnapshot: { kind: 'unknown', detail: '' }, homeLinkBefore: { kind: 'absent' },
    baseline: { sessions: 0, quarantined: [] }, linkRewrites: [], repairRounds: 0, pointerWritten: true, terminalWritten: true,
    homeLinkRestored: false, targetExposed: true, retiredInPlace: false, originalGeneration: 0, cleanupAttempts: 0, cleanupLeftoverBytes: 0,
    awaitingChoice: false, keepTarget: false, keepOriginal: false, targetAbandoned: false, originalAbandoned: false, leftovers: [],
    startedAt: '', ...lastSeenEnvBefore === undefined ? {} : { lastSeenEnvBefore },
  }
}

/**
 * Write a journal for move {@link MOVE} to {@link HOME}.
 * @param lastSeenEnvBefore - `DSH_HOME` as last seen before the move, if any.
 * @returns the move directory.
 */
function journalIn(lastSeenEnvBefore?: string): string {
  const dir = join(root, 'data-move')
  mkdirSync(dir, { recursive: true })
  writeJournal(dir, journalOf(MOVE, lastSeenEnvBefore))
  return dir
}

/**
 * A launch that settled on `home` without writing the terminal itself.
 * @param pending - the move on disk.
 * @param changes - the fields that differ.
 * @returns the launch.
 */
function launchOn(pending: BootMove, changes: Partial<TerminalSyncLaunch> = {}): TerminalSyncLaunch {
  return { home: HOME, settled: undefined, pending, lastResult: undefined, ...changes }
}

/**
 * A launch that checks a move's switch.
 * @param moveId - the move.
 * @param changes - the fields that differ.
 * @returns the launch.
 */
function checking(moveId: MoveId = MOVE, changes: Partial<TerminalSyncLaunch> = {}): TerminalSyncLaunch {
  return launchOn({ kind: 'health-check', journal: { ...journalOf(moveId), phase: 'switched' } }, changes)
}

/**
 * A launch that carries on a move's cleanup.
 * @param moveId - the move.
 * @returns the launch.
 */
function cleaningUp(moveId: MoveId = MOVE): TerminalSyncLaunch {
  return launchOn({ kind: 'cleanup', journal: { ...journalOf(moveId), phase: 'cleanup' } })
}

/**
 * A finished move's result.
 * @param outcome - how it ended.
 * @param changes - the fields that differ.
 * @returns the result.
 */
function resultOf(outcome: MoveResult['outcome'], changes: Partial<MoveResult> = {}): MoveResult {
  return { version: JOURNAL_VERSION, moveId: MOVE, outcome, source: '/s', target: HOME, leftovers: [], finishedAt: '', ...changes }
}

/** A move that finished on a new location that failed its check after the person chose to keep it. */
const KEPT_AFTER_FAILURE = resultOf('moved', { failure: { kind: 'fewer-sessions' }, keptOriginal: { path: '/s (original)' } })

/**
 * A terminal whose write and read-back come to `sync`.
 * @param sync - the outcome the write is to come to.
 * @param written - collects every value written.
 * @param log - the log.
 * @returns the host.
 */
function hostFor(
  sync: TerminalSync, written: Array<string | undefined> = [], log: (line: string) => void = () => undefined,
): TerminalSyncHost {
  let reads: ExplicitRead
  switch (sync.kind) {
    case 'synced':
      reads = { kind: 'set', value: sync.value, source: 'login-shell' }
      break
    case 'overridden':
      reads = sync.reported === undefined ? { kind: 'unset' } : { kind: 'set', value: sync.reported, source: 'login-shell' }
      break
    case 'unconfirmed':
      reads = { kind: 'unknown', detail: sync.detail }
      break
    case 'not-written':
    case 'failed':
      // The write never took, so nothing reads the terminal back.
      reads = { kind: 'unknown', detail: 'not read back' }
      break
    default:
      return sync satisfies never
  }
  return {
    osHome: '/Users/me',
    log,
    writeTerminalEnv: async (value) => {
      written.push(value)
      if (sync.kind === 'failed') throw new Error('PowerShell exited with 1')
      return sync.write
    },
    readPersistentEnv: async () => reads,
  }
}

describe('a data move\'s terminal write', () => {
  it('writes the new location and returns the value to remember', async () => {
    const written: Array<string | undefined> = []
    expect(await syncMoveTerminal(hostFor(SYNCED, written), journalIn(), root, HOME)).toBe(HOME)
    expect(written).toEqual([HOME])
    expect(await syncMoveTerminal(hostFor(OVERRIDDEN), journalIn('/before'), root, HOME)).toBe('/elsewhere')
  })

  it('records every outcome, naming the move, for the launches that finish it', async () => {
    for (const sync of OUTCOMES) {
      await syncMoveTerminal(hostFor(sync), journalIn(), root, HOME)
      expect(JSON.parse(readFileSync(recordFile(), 'utf8'))).toMatchObject({ version: TERMINAL_SYNC_VERSION, moveId: MOVE })
      expect(terminalForLaunch(root, checking(), 'darwin', noLog)).toEqual(sync)
    }
  })

  it('refuses without a move recorded, and records nothing', async () => {
    await expect(syncMoveTerminal(hostFor(SYNCED), join(root, 'data-move'), root, HOME)).rejects.toThrow('no data move is recorded')
    expect(existsSync(recordFile())).toBe(false)
  })

  it('logs a record it cannot write, and removes the one an earlier write of the move left', async () => {
    const dir = journalIn()
    await syncMoveTerminal(hostFor(SYNCED), dir, root, HOME)
    failing.write = true
    const lines: string[] = []
    expect(await syncMoveTerminal(hostFor(OVERRIDDEN, [], (line) => { lines.push(line) }), dir, root, HOME)).toBe('/elsewhere')
    expect(lines.filter(line => line.includes('could not record what the terminal write came to'))).toHaveLength(1)
    expect(existsSync(recordFile())).toBe(false)
    expect(terminalForLaunch(root, checking(), 'darwin', noLog)).toBeUndefined()
  })
})

describe('the record at launch', () => {
  it('is reported, and left, on every launch that checks the switch of the move that wrote it or carries on its cleanup', async () => {
    await syncMoveTerminal(hostFor(SYNCED), journalIn(), root, HOME)
    expect(terminalForLaunch(root, checking(), 'darwin', noLog)).toEqual(SYNCED)
    // A launch that checks the same switch again, after the one before stopped partway.
    expect(terminalForLaunch(root, checking(), 'darwin', noLog)).toEqual(SYNCED)
    // A launch after the check passed, when the launch that ran it stopped for a mandatory update or crashed.
    expect(terminalForLaunch(root, cleaningUp(), 'darwin', noLog)).toEqual(SYNCED)
    expect(terminalForLaunch(root, cleaningUp(), 'darwin', noLog)).toEqual(SYNCED)
    expect(existsSync(recordFile())).toBe(true)
  })

  it('gives way to the launch\'s own write, which removes it', async () => {
    await syncMoveTerminal(hostFor(SYNCED), journalIn(), root, HOME)
    expect(terminalForLaunch(root, checking(MOVE, { settled: OVERRIDDEN }), 'darwin', noLog)).toEqual(OVERRIDDEN)
    expect(existsSync(recordFile())).toBe(false)
    // A launch that checks the same switch again after a crash reports neither write.
    expect(terminalForLaunch(root, checking(), 'darwin', noLog)).toBeUndefined()
    expect(terminalForLaunch(root, launchOn({ kind: 'none' }, { settled: SYNCED }), 'darwin', noLog)).toEqual(SYNCED)
  })

  it('is reported once, then removed, after the move finished on a new location the person kept though it failed its check', async () => {
    await syncMoveTerminal(hostFor(OVERRIDDEN), journalIn(), root, HOME)
    expect(terminalForLaunch(root, launchOn({ kind: 'none' }, { lastResult: KEPT_AFTER_FAILURE }), 'darwin', noLog)).toEqual(OVERRIDDEN)
    expect(existsSync(recordFile())).toBe(false)
    expect(terminalForLaunch(root, launchOn({ kind: 'none' }, { lastResult: KEPT_AFTER_FAILURE }), 'darwin', noLog)).toBeUndefined()
  })

  it('is removed, unreported, by a launch with no move on disk after any other result, and no later launch reports it', async () => {
    const results: Array<MoveResult | undefined> = [
      undefined,
      resultOf('moved'),
      resultOf('failed', { failure: { kind: 'fewer-sessions' } }),
      resultOf('cancelled'),
      { ...KEPT_AFTER_FAILURE, moveId: 'move-2' as MoveId },
    ]
    for (const lastResult of results) {
      await syncMoveTerminal(hostFor(SYNCED), journalIn(), root, HOME)
      expect(terminalForLaunch(root, launchOn({ kind: 'none' }, { lastResult }), 'darwin', noLog)).toBeUndefined()
      expect(existsSync(recordFile())).toBe(false)
      expect(terminalForLaunch(root, checking(), 'darwin', noLog)).toBeUndefined()
    }
  })

  it('is removed, unreported, by a launch that finishes another move', async () => {
    for (const launch of [checking('move-2' as MoveId), cleaningUp('move-2' as MoveId)]) {
      await syncMoveTerminal(hostFor(SYNCED), journalIn(), root, HOME)
      expect(terminalForLaunch(root, { ...launch, lastResult: KEPT_AFTER_FAILURE }, 'darwin', noLog)).toBeUndefined()
      expect(existsSync(recordFile())).toBe(false)
    }
  })

  it('is reported only on the location it was written for, comparing paths as the platform does', async () => {
    await syncMoveTerminal(hostFor(SYNCED), journalIn(), root, HOME)
    expect(terminalForLaunch(root, checking(MOVE, { home: '/users/ME/dsh-data' }), 'darwin', noLog)).toEqual(SYNCED)
    expect(terminalForLaunch(root, checking(MOVE, { home: '/users/ME/dsh-data' }), 'linux', noLog)).toBeUndefined()
    expect(existsSync(recordFile())).toBe(false)
    await syncMoveTerminal(hostFor(SYNCED), journalIn(), root, HOME)
    expect(terminalForLaunch(root, checking(MOVE, { home: '/Users/me/.dsh' }), 'darwin', noLog)).toBeUndefined()
    expect(existsSync(recordFile())).toBe(false)
    await syncMoveTerminal(hostFor(SYNCED), journalIn(), root, HOME)
    const elsewhere = launchOn({ kind: 'none' }, { home: '/Users/me/.dsh', lastResult: KEPT_AFTER_FAILURE })
    expect(terminalForLaunch(root, elsewhere, 'darwin', noLog)).toBeUndefined()
    expect(existsSync(recordFile())).toBe(false)
  })

  it('reports nothing without a record', () => {
    expect(terminalForLaunch(root, checking(), 'darwin', noLog)).toBeUndefined()
    expect(terminalForLaunch(root, launchOn({ kind: 'none' }, { lastResult: KEPT_AFTER_FAILURE }), 'darwin', noLog)).toBeUndefined()
  })

  it('removes, unreported, a record that is damaged, of another version, or without the move or a whole outcome', () => {
    const texts = [
      '{ torn',
      JSON.stringify({ version: 2, moveId: MOVE, sync: SYNCED }),
      JSON.stringify({ version: 1, sync: SYNCED }),
      JSON.stringify({ version: 1, moveId: MOVE, sync: { kind: 'synced', value: HOME } }),
      JSON.stringify([1]),
    ]
    for (const text of texts) {
      writeFileSync(recordFile(), text)
      expect(terminalForLaunch(root, checking(), 'darwin', noLog)).toBeUndefined()
      expect(existsSync(recordFile())).toBe(false)
    }
  })

  posixOnly('logs a record it cannot remove, and leaves it unreported', async () => {
    await syncMoveTerminal(hostFor(SYNCED), journalIn(), root, HOME)
    chmodSync(root, 0o500)
    const lines: string[] = []
    expect(terminalForLaunch(root, launchOn({ kind: 'none' }), 'darwin', (line) => { lines.push(line) })).toBeUndefined()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`could not remove ${recordFile()}`)
  })
})

describe('main.ts', () => {
  it('picks the terminal outcome once the data location is settled, from its own write, the move on disk, and the last result', () => {
    const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    const settle = source.indexOf('const settled = await settleDataLocation(')
    const pick = source.indexOf('settledTerminal = terminalForLaunch(')
    expect(settle).toBeGreaterThan(-1)
    expect(pick).toBeGreaterThan(source.indexOf('if (settled === undefined) {', settle))
    expect(source.slice(pick)).toMatch(new RegExp([
      String.raw`^settledTerminal = terminalForLaunch\(app\.getPath\('userData'\), \{\s+`,
      String.raw`home: settled\.home, settled: settled\.terminal, pending: pendingMove, `,
      String.raw`lastResult: readMoveResult\(moveDir\(app\.getPath\('userData'\)\)\),\s+\}, process\.platform, sink\)`,
    ].join(''), 'u'))
    expect(source.match(/settledTerminal = /gu)).toHaveLength(1)
  })
})

describe('a recorded outcome', () => {
  it('is refused with any field missing or of another kind', () => {
    const bad: unknown[] = [
      undefined, 'synced', [], { kind: 'teleported', value: HOME, write: WRITTEN }, { kind: 'synced', write: WRITTEN },
      { kind: 'failed', value: HOME }, { kind: 'unconfirmed', value: HOME, write: WRITTEN },
      { kind: 'overridden', value: HOME, write: WRITTEN, reported: 7 },
      { kind: 'synced', value: HOME, write: { kind: 'profile', update: { kind: 'written' } } },
      { kind: 'synced', value: HOME, write: { kind: 'profile', update: { kind: 'written', file: '/f', backup: 3 } } },
      { kind: 'synced', value: HOME, write: { kind: 'profile', update: { kind: 'unsupported-shell' } } },
      { kind: 'synced', value: HOME, write: { kind: 'profile', update: { kind: 'dangling-profile' } } },
      { kind: 'synced', value: HOME, write: { kind: 'profile', update: { kind: 'foreign-assignment', file: '/f', places: 'line 3' } } },
      { kind: 'synced', value: HOME, write: { kind: 'profile', update: { kind: 'foreign-assignment', file: '/f', places: [{ file: '/f', line: 1.5 }] } } },
      { kind: 'synced', value: HOME, write: { kind: 'profile', update: { kind: 'appended', file: '/f' } } },
      { kind: 'synced', value: HOME, write: { kind: 'unsupported-platform', platform: 'plan9' } },
      { kind: 'synced', value: HOME, write: { kind: 'registry' } },
    ]
    for (const value of bad) expect(parseTerminalSync(value)).toBeUndefined()
  })
})
