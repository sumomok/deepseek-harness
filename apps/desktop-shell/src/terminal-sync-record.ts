/**
 * The record a data move leaves of its write of the terminal's data location,
 * which the launch that checks the move's switch reports as the
 * data-location service's `/state` `terminal`.
 *
 * A move writes the terminal in the process that then relaunches, so the
 * record is a file, `terminal-sync.json` under user data, naming the move.
 * Every launch that settles the data location reads it
 * ({@link terminalSyncForLaunch}). A launch that checks the switch of the
 * move that wrote it, on the location it wrote, reports it and leaves it, so a
 * launch that checks the same switch again after a crash reports it too; every
 * other launch removes it, so no later launch reports an outcome from before
 * it. A write of the terminal while a launch settles the data location stays
 * in that launch's memory and is never recorded here. Recording is best
 * effort: a record that cannot be written is logged and removed, and the move
 * goes on without it.
 * @module @deepseek-ai/dsh-desktop-shell/terminal-sync-record
 */

import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { syncTerminal, type TerminalSync, type TerminalSyncHost } from './data-location-boot.ts'
import { POINTER_VERSION, type DataLocationPointer } from './data-location.ts'
import { writeDurably } from './durable-file.ts'
import { readJournal, type MoveId } from './move/journal.ts'
import { samePathText } from './path-text.ts'
import type { ForeignAssignment, ProfileUpdate, TerminalWrite } from './terminal-env.ts'

/** The record's file name, under user data. */
export const TERMINAL_SYNC_FILENAME = 'terminal-sync.json'

/** The only record format this build reads and writes. */
export const TERMINAL_SYNC_VERSION = 1

/**
 * Write the new location of a data move as the terminal's `DSH_HOME`, read it
 * back, and record what that came to, naming the move, for the launch that
 * checks its switch. The value last seen before the move, from the journal,
 * is what the write replaces.
 * @param host - the terminal write and read, the home `~` stands for, and the log.
 * @param dir - the move directory.
 * @param userData - Electron's user-data directory.
 * @param target - the move's new location.
 * @returns the `lastSeenEnv` the pointer records afterwards; `undefined` for none.
 * @throws when no move is recorded.
 */
export async function syncMoveTerminal(host: TerminalSyncHost, dir: string, userData: string, target: string): Promise<string | undefined> {
  const journal = readJournal(dir)
  if (journal === undefined) throw new Error('no data move is recorded')
  const pointer: DataLocationPointer = {
    version: POINTER_VERSION, path: target, dataId: journal.dataId,
    ...journal.lastSeenEnvBefore === undefined ? {} : { lastSeenEnv: journal.lastSeenEnvBefore },
  }
  const synced = await syncTerminal(host, pointer, undefined)
  recordTerminalSync(join(userData, TERMINAL_SYNC_FILENAME), journal.moveId, synced.sync, host.log)
  return synced.pointer.lastSeenEnv
}

/**
 * Replace the record. A record that cannot be written is logged and removed,
 * since an earlier write of the same move, before a rollback put the setting
 * back, would otherwise stand for this one.
 * @param file - the record.
 * @param moveId - the move that wrote the terminal.
 * @param sync - what the write came to.
 * @param log - the desktop log sink.
 */
function recordTerminalSync(file: string, moveId: MoveId, sync: TerminalSync, log: (line: string) => void): void {
  try {
    writeDurably(file, Buffer.from(`${JSON.stringify({ version: TERMINAL_SYNC_VERSION, moveId, sync }, null, 2)}\n`))
  } catch (error) {
    log(`[desktop] data move: could not record what the terminal write came to: ${String(error)}\n`)
    removeRecord(file, log)
  }
}

/** The move and the data directory a launch that checks a move's switch reports a record for. */
export interface TerminalSyncExpected {
  /** The move whose switch the launch checks. */
  moveId: MoveId
  /** The data directory in use. */
  home: string
}

/**
 * What the record names, for this launch. A launch that checks the switch of
 * the move that wrote it, on the location it wrote, gets the outcome and
 * leaves the record; every other launch removes it, and a record that cannot
 * be removed is logged and stays unreported, since only a launch that checks
 * that move's switch reports it, and the move writes the terminal again
 * before any such launch follows.
 * @param userData - Electron's user-data directory.
 * @param expected - the move whose switch this launch checks, and the data directory in use; `undefined` when the
 * launch checks no switch.
 * @param platform - how paths compare.
 * @param log - the desktop log sink.
 * @returns what the move's write came to; `undefined` when there is no record, it cannot be read, or it names another
 * move or location.
 */
export function terminalSyncForLaunch(
  userData: string, expected: TerminalSyncExpected | undefined, platform: NodeJS.Platform, log: (line: string) => void,
): TerminalSync | undefined {
  const file = join(userData, TERMINAL_SYNC_FILENAME)
  let text: string | undefined
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    // ENOENT when no move wrote the terminal since a launch removed the record; any other error leaves nothing to report.
  }
  if (text === undefined) return undefined
  const sync = expected === undefined ? undefined : recordedSync(text, expected, platform)
  if (sync === undefined) removeRecord(file, log)
  return sync
}

/**
 * The outcome a record's text names, when it was written by the expected
 * move for the expected location.
 * @param text - the record's text.
 * @param expected - the move and the data directory in use.
 * @param platform - how paths compare.
 * @returns the outcome; `undefined` when the text is damaged, of another version, or names another move or location.
 */
function recordedSync(text: string, expected: TerminalSyncExpected, platform: NodeJS.Platform): TerminalSync | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A damaged record names no outcome to report.
    return undefined
  }
  const record = recordOf(parsed)
  if (record?.['version'] !== TERMINAL_SYNC_VERSION || record['moveId'] !== expected.moveId) return undefined
  const sync = parseTerminalSync(record['sync'])
  return sync !== undefined && samePathText(sync.value, expected.home, platform) ? sync : undefined
}

/**
 * Remove the record; a failure is logged.
 * @param file - the record.
 * @param log - the desktop log sink.
 */
function removeRecord(file: string, log: (line: string) => void): void {
  try {
    rmSync(file, { force: true })
  } catch (error) {
    log(`[desktop] data move: could not remove ${file}: ${String(error)}\n`)
  }
}

/**
 * Check a recorded {@link TerminalSync}.
 * @param value - the parsed record's `sync`.
 * @returns it, or `undefined` when any field is missing or of another kind.
 */
export function parseTerminalSync(value: unknown): TerminalSync | undefined {
  const record = recordOf(value)
  const kind = record?.['kind']
  const syncValue = textOf(record?.['value'])
  if (record === undefined || syncValue === undefined) return undefined
  if (kind === 'failed') {
    const detail = textOf(record['detail'])
    return detail === undefined ? undefined : { kind, value: syncValue, detail }
  }
  const write = parseTerminalWrite(record['write'])
  if (write === undefined) return undefined
  switch (kind) {
    case 'synced':
    case 'not-written':
      return { kind, value: syncValue, write }
    case 'overridden': {
      const reported = record['reported']
      if (reported !== undefined && typeof reported !== 'string') return undefined
      return { kind, value: syncValue, write, reported }
    }
    case 'unconfirmed': {
      const detail = textOf(record['detail'])
      return detail === undefined ? undefined : { kind, value: syncValue, write, detail }
    }
    default:
      return undefined
  }
}

/** Platforms a recorded `unsupported-platform` write may name. */
const PLATFORMS: readonly NodeJS.Platform[] = [
  'aix', 'android', 'cygwin', 'darwin', 'freebsd', 'haiku', 'linux', 'netbsd', 'openbsd', 'sunos', 'win32',
]

/**
 * Check a recorded {@link TerminalWrite}.
 * @param value - the recorded write.
 * @returns it, or `undefined` when it is not one.
 */
function parseTerminalWrite(value: unknown): TerminalWrite | undefined {
  const record = recordOf(value)
  switch (record?.['kind']) {
    case 'user-environment':
      return { kind: 'user-environment' }
    case 'profile': {
      const update = parseProfileUpdate(record['update'])
      return update === undefined ? undefined : { kind: 'profile', update }
    }
    case 'unsupported-platform': {
      const platform = PLATFORMS.find(entry => entry === record['platform'])
      return platform === undefined ? undefined : { kind: 'unsupported-platform', platform }
    }
    default:
      return undefined
  }
}

/**
 * Check a recorded {@link ProfileUpdate}.
 * @param value - the recorded update.
 * @returns it, or `undefined` when it is not one.
 */
function parseProfileUpdate(value: unknown): ProfileUpdate | undefined {
  const record = recordOf(value)
  const file = textOf(record?.['file'])
  switch (record?.['kind']) {
    case 'written': {
      const backup = record['backup']
      if (file === undefined || (backup !== undefined && typeof backup !== 'string')) return undefined
      return { kind: 'written', file, ...backup === undefined ? {} : { backup } }
    }
    case 'unchanged':
      return file === undefined ? undefined : { kind: 'unchanged', file }
    case 'damaged-block':
      return file === undefined ? undefined : { kind: 'damaged-block', file }
    case 'unsupported-shell': {
      const shell = textOf(record['shell'])
      return shell === undefined ? undefined : { kind: 'unsupported-shell', shell }
    }
    case 'dangling-profile': {
      const link = textOf(record['link'])
      return link === undefined ? undefined : { kind: 'dangling-profile', link }
    }
    case 'foreign-assignment': {
      const places = record['places']
      if (file === undefined || !Array.isArray(places)) return undefined
      const read: ForeignAssignment[] = places.flatMap((entry: unknown) => {
        const place = recordOf(entry)
        const placeFile = textOf(place?.['file'])
        const line = place?.['line']
        return placeFile !== undefined && typeof line === 'number' && Number.isInteger(line) ? [{ file: placeFile, line }] : []
      })
      return read.length === places.length ? { kind: 'foreign-assignment', file, places: read } : undefined
    }
    default:
      return undefined
  }
}

/**
 * A parsed JSON object's fields.
 * @param value - the parsed value.
 * @returns its fields, or `undefined` when it is not an object.
 */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * A parsed text field.
 * @param value - the parsed value.
 * @returns it, or `undefined` when it is not text.
 */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
