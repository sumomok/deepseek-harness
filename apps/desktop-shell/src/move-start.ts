/**
 * Starting a data move: the checks the shell makes before it writes the
 * journal, and the journal's start. Nothing is written until every check has
 * passed; the move lock is the last check, and a failure to write the journal
 * releases it again.
 *
 * A move is refused when the preflight refuses the location, when the record
 * of abandoned copies cannot be read (a new copy could not be recorded, and
 * the page for that file is where it is repaired or set aside), when the
 * terminal's setting cannot be read (a rollback could not put it back
 * exactly), when a move is already recorded, when the data has no readable
 * identity, and when another installation's live process holds the lock.
 * @module @deepseek-ai/dsh-desktop-shell/move-start
 */

import { realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { readDataId, readGeneration, readPointer } from './data-location.ts'
import { countSessions, quarantinedPlugins } from './move-boot.ts'
import {
  ABANDONED_FILENAME, DONE_LOG_FILENAME, JOURNAL_FILENAME, JournalError, moveDir, readAbandonedCopies, readJournal, type MoveJournal,
} from './move/journal.ts'
import { acquireMoveLock, releaseMoveLock, type LockOwner } from './move/lock.ts'
import {
  evaluatePreflight, gatherPreflightFacts, type ForbiddenPlaces, type PreflightProbes, type PreflightResult,
} from './move/preflight.ts'
import { readHomeLinkBefore, readPointerFiles, startMove } from './move/run.ts'
import type { ExplicitRead, TerminalSnapshot } from './terminal-env.ts'

/** What a move is asked to do. */
export interface MoveRequest {
  /** The folder the person picked. */
  chosen: string
  /** The data directory in use (`DSH_HOME` as settled). */
  home: string
  userData: string
  /** `~/.dsh`. */
  defaultHome: string
  platform: NodeJS.Platform
  forbidden: ForbiddenPlaces
  /** Workspace records the server reported; absent when it reported none. */
  workspaces?: number
  pid: number
  now: Date
}

/** The reads a start makes outside the file system. */
export interface MoveStartProbes {
  preflight: PreflightProbes
  /** The terminal's setting, byte for byte ({@link snapshotTerminal}). */
  snapshotTerminal: () => Promise<TerminalSnapshot>
  /** What a terminal opened now sees as `DSH_HOME`. */
  readTerminal: () => Promise<ExplicitRead>
  isAlive: (pid: number) => boolean
}

/** Why a move did not start. */
export type MoveRefusal =
  | { kind: 'preflight'; result: PreflightResult }
  | { kind: 'abandoned-unreadable'; path: string; detail: string }
  | { kind: 'terminal-unreadable'; detail: string }
  | { kind: 'in-progress' }
  | { kind: 'no-identity'; detail: string }
  | { kind: 'locked'; owner: LockOwner }
  /** The server, or a process it started, could not be confirmed stopped; the move was withdrawn before anything was copied. */
  | { kind: 'server-still-running'; pids: number[] }

/** Outcome of {@link beginDataMove}. */
export type MoveStartOutcome =
  | { kind: 'started'; journal: MoveJournal; preflight: PreflightResult }
  | { kind: 'refused'; refusal: MoveRefusal }

/**
 * Check a move and, when every check passes, take the lock and write the
 * journal in phase `requested`.
 * @param request - where to, from where, and the places the data may not go.
 * @param probes - the disk, terminal, and process reads.
 * @returns the journal, or why the move did not start.
 * @throws when a probe fails, or the lock or the journal cannot be written.
 */
export async function beginDataMove(request: MoveRequest, probes: MoveStartProbes): Promise<MoveStartOutcome> {
  const dir = moveDir(request.userData)
  const refused = (refusal: MoveRefusal): MoveStartOutcome => ({ kind: 'refused', refusal })
  try {
    if (readJournal(dir) !== undefined) return refused({ kind: 'in-progress' })
  } catch (error) {
    if (!(error instanceof JournalError)) throw error
    return refused({ kind: 'in-progress' })
  }
  try {
    readAbandonedCopies(dir)
  } catch (error) {
    if (!(error instanceof JournalError)) throw error
    return refused({ kind: 'abandoned-unreadable', path: join(dir, ABANDONED_FILENAME), detail: error.message })
  }
  const facts = await gatherPreflightFacts(
    { platform: request.platform, source: request.home, chosen: request.chosen, forbidden: request.forbidden }, probes.preflight,
  )
  const preflight = evaluatePreflight(facts)
  if (!preflight.ok) return refused({ kind: 'preflight', result: preflight })
  const snapshot = await probes.snapshotTerminal()
  if (snapshot.kind === 'unknown') return refused({ kind: 'terminal-unreadable', detail: snapshot.detail })
  const source = facts.source
  const id = readDataId(source)
  if (id.kind !== 'ok') return refused({ kind: 'no-identity', detail: id.kind === 'unreadable' ? id.detail : 'no identity marker' })
  const terminalBefore = await probes.readTerminal()
  const self: LockOwner = { userData: request.userData, pid: request.pid }
  const lock = acquireMoveLock(source, self, probes.isAlive)
  if (lock.kind === 'held') return refused({ kind: 'locked', owner: lock.owner })
  try {
    const pointer = readPointer(request.userData)
    const aliases = [source, request.home]
    if (sameReal(request.defaultHome, source)) aliases.push(request.defaultHome)
    const journal = startMove(dir, {
      source,
      sourceAliases: [...new Set(aliases)],
      target: preflight.target.target,
      targetPreexisting: preflight.target.preexisting,
      sameVolume: preflight.sameVolume,
      dataId: id.id,
      pointerBefore: readPointerFiles(request.userData),
      ...pointer.kind === 'ok' && pointer.pointer.lastSeenEnv !== undefined ? { lastSeenEnvBefore: pointer.pointer.lastSeenEnv } : {},
      terminalBefore,
      terminalSnapshot: snapshot,
      homeLinkBefore: readHomeLinkBefore(request.defaultHome),
      baseline: {
        sessions: countSessions(source),
        ...request.workspaces === undefined ? {} : { workspaces: request.workspaces },
        quarantined: quarantinedPlugins(source),
      },
      originalGeneration: readGeneration(source),
    }, { pid: request.pid, now: request.now })
    return { kind: 'started', journal, preflight }
  } catch (error) {
    releaseMoveLock([source], self)
    throw error
  }
}

/**
 * Take back a move that has only been requested: nothing was copied, renamed,
 * or written anywhere but its journal and its lock, so both go and the move
 * leaves no result behind.
 * @param journal - the journal {@link beginDataMove} wrote.
 * @param request - the installation and process that took the lock.
 * @throws when the journal is no longer in phase `requested`, or a file cannot be removed.
 */
export function withdrawRequestedMove(journal: MoveJournal, request: Pick<MoveRequest, 'userData' | 'pid'>): void {
  const dir = moveDir(request.userData)
  const current = readJournal(dir)
  if (current?.moveId !== journal.moveId || current.phase !== 'requested') {
    throw new JournalError(`journal: move ${journal.moveId} is no longer only requested (phase ${String(current?.phase)})`)
  }
  for (const name of [JOURNAL_FILENAME, DONE_LOG_FILENAME]) rmSync(join(dir, name), { force: true })
  releaseMoveLock([journal.source], { userData: request.userData, pid: request.pid })
}

/**
 * Hand the data over to a move that was just requested: stop the server and
 * everything it started. When some of it cannot be confirmed gone the move is
 * taken back before anything was copied and the server is started again.
 * @param journal - the journal {@link beginDataMove} wrote.
 * @param request - the installation and process that took the lock.
 * @param deps - the stop of the server's whole tree (the processes still running) and its restart.
 * @returns `go` when the move may run, or the refusal to report.
 * @throws when the move cannot be taken back.
 */
export async function handOverToMove(
  journal: MoveJournal,
  request: Pick<MoveRequest, 'userData' | 'pid'>,
  deps: { stopServerTree: () => Promise<Array<{ pid: number }>>; restartServer: () => Promise<unknown> },
): Promise<{ kind: 'go' } | { kind: 'refused'; refusal: MoveRefusal }> {
  const survivors = await deps.stopServerTree()
  if (survivors.length === 0) return { kind: 'go' }
  withdrawRequestedMove(journal, request)
  await deps.restartServer()
  return { kind: 'refused', refusal: { kind: 'server-still-running', pids: survivors.map(entry => entry.pid) } }
}

/**
 * Whether a path leads to the same real directory as another.
 * @param path - a path that may be a link.
 * @param real - a real path.
 * @returns true when `path` resolves to `real`.
 */
function sameReal(path: string, real: string): boolean {
  try {
    return realpathSync.native(path) === real
  } catch {
    // ENOENT: `~/.dsh` is absent, so it is no spelling of the data directory.
    return false
  }
}
