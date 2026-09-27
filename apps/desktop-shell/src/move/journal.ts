/**
 * The data-move journal and the decision of what to do next.
 *
 * The journal, `<userData>/data-move/journal.json`, records one move from its
 * confirmation to its end: the phase, the paths involved, and everything a
 * rollback restores (the pointer's files byte for byte, the terminal's
 * `DSH_HOME`, what `~/.dsh` was). It lives under Electron's user-data
 * directory, never in the source or the target: the source is deleted at the
 * end and the target may be removed or unplugged.
 *
 * What happens next is decided by {@link nextAction}, a pure function of the
 * journal and of what is on disk now ({@link MoveFacts}). Every action is one
 * step that can be repeated: after an interruption at any point the same
 * facts lead to the same or the following action, never back to one whose
 * effect is already undone. The step table is in the phase-2 plan, section 2.
 *
 * Two orderings carry the rule that at most one directory holds this data's
 * identity marker without a move marker at any moment: the copy is renamed to
 * the target while it still carries the move marker and no identity; the
 * source gives up its identity (renamed to `.dsh-data-id.moved`) and takes a
 * move marker before the target gets the identity. A rollback does the same in
 * reverse.
 * @module @deepseek-ai/dsh-desktop-shell/move/journal
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { writeDurably } from '../durable-file.ts'
import type { DataId } from '../data-location.ts'
import type { ExplicitRead } from '../terminal-env.ts'
import type { InPlaceRewrite } from './links.ts'

/** The only journal format this build reads and writes. */
export const JOURNAL_VERSION = 1
/** Directory under user data holding the journal, the done log, and the last result. */
export const MOVE_DIRNAME = 'data-move'
/** The journal's file name. */
export const JOURNAL_FILENAME = 'journal.json'
/** The done log's file name. */
export const DONE_LOG_FILENAME = 'done.jsonl'
/** The last move's result, which Settings shows. */
export const RESULT_FILENAME = 'last-result.json'
/** The identity marker's name in a source that gave it up. */
export const MOVED_ID_FILENAME = '.dsh-data-id.moved'
/** Rounds of repairs after failed checks before the move is given up (design doc 3.2 step 4). */
export const MAX_REPAIR_ROUNDS = 2

/** Identity of one move; names the partial and hidden folders and fills their move markers. */
export type MoveId = string & { readonly __brand: 'MoveId' }

/** Phases of a move, in the order a successful move passes them. */
export const MOVE_PHASES = [
  'requested', 'copying', 'verifying', 'catching-up', 'finalizing', 'hiding-source', 'switching', 'switched', 'cleanup',
  'cancelling', 'abandoning', 'rolling-back',
] as const

/** One phase. */
export type MovePhase = typeof MOVE_PHASES[number]

/** Phases in which the person may still cancel: the copy exists only as the partial folder. */
export const CANCELLABLE_PHASES: ReadonlySet<MovePhase> = new Set(['requested', 'copying', 'verifying', 'catching-up'])

/** What `~/.dsh` was before the move. */
export type HomeLinkBefore = { kind: 'absent' } | { kind: 'link'; target: string } | { kind: 'other' }

/** The pointer's two files before the move, as their raw text; an absent file is `undefined`. */
export interface PointerBefore {
  main?: string
  backup?: string
}

/** What the health check compares the moved home with. */
export interface MoveBaseline {
  /** Session directories before the move. */
  sessions: number
  /** Workspace records before the move. */
  workspaces: number
  /** Plugins already quarantined before the move. */
  quarantined: string[]
}

/** Something a removal could not delete, recorded so the move can finish. */
export interface JournalLeftover {
  path: string
  bytes: number
}

/** The journal. */
export interface MoveJournal {
  version: typeof JOURNAL_VERSION
  moveId: MoveId
  phase: MovePhase
  /** The process that wrote the journal last. */
  pid: number
  /** The real path of the data directory. */
  source: string
  /** Every spelling of the data directory; the first is `source`. */
  sourceAliases: string[]
  /** Where the data ends up. */
  target: string
  /** Whether `target` was an empty folder the person picked (recreated on rollback). */
  targetPreexisting: boolean
  /** Where the copy is made. */
  partial: string
  /** Where the source is kept until the new location has passed its health check. */
  hidden: string
  /** Whether the move is a rename on one volume. */
  sameVolume: boolean
  dataId: DataId
  pointerBefore: PointerBefore
  /** The pointer's `lastSeenEnv` before the move. */
  lastSeenEnvBefore?: string
  terminalBefore: ExplicitRead
  homeLinkBefore: HomeLinkBefore
  baseline: MoveBaseline
  /** Links rewritten in place after a rename on one volume. */
  linkRewrites: InPlaceRewrite[]
  repairRounds: number
  /** Set before the pointer is first written; a rollback then restores it. */
  pointerWritten: boolean
  /** Set before the terminal is first written; a rollback then restores it. */
  terminalWritten: boolean
  /** Set once `~/.dsh` has been put back during a rollback. */
  homeLinkRestored: boolean
  cleanupAttempts: number
  leftovers: JournalLeftover[]
  /** Why the move is being given up or rolled back. */
  failure?: { phase: MovePhase; detail: string }
  startedAt: string
}

/** What starting a move needs; the rest of the journal is derived. */
export type MoveStart = Pick<MoveJournal,
  'source' | 'sourceAliases' | 'target' | 'targetPreexisting' | 'sameVolume' | 'dataId' | 'pointerBefore'
  | 'lastSeenEnvBefore' | 'terminalBefore' | 'homeLinkBefore' | 'baseline'>

/** How a move ended, as Settings reports it. */
export interface MoveResult {
  version: typeof JOURNAL_VERSION
  moveId: MoveId
  outcome: 'moved' | 'cancelled' | 'failed'
  source: string
  target: string
  detail?: string
  leftovers: JournalLeftover[]
  finishedAt: string
}

/**
 * The move directory under user data.
 * @param userData - Electron's user-data directory.
 * @returns the directory holding the journal.
 */
export function moveDir(userData: string): string {
  return join(userData, MOVE_DIRNAME)
}

/**
 * A new journal for a confirmed move.
 * @param start - the paths and the state to restore.
 * @param options - the process id and the clock.
 * @returns the journal in phase `requested`.
 */
export function newJournal(start: MoveStart, options: { pid: number; now: Date; moveId?: MoveId }): MoveJournal {
  const moveId = options.moveId ?? randomUUID() as MoveId
  return {
    version: JOURNAL_VERSION,
    moveId,
    phase: 'requested',
    pid: options.pid,
    ...start,
    partial: join(dirname(start.target), `.dsh-data.partial-${moveId}`),
    hidden: join(dirname(start.source), `.dsh-moved-${moveId}`),
    linkRewrites: [],
    repairRounds: 0,
    pointerWritten: false,
    terminalWritten: false,
    homeLinkRestored: false,
    cleanupAttempts: 0,
    leftovers: [],
    startedAt: options.now.toISOString(),
  }
}

/** Why a journal file cannot be used. */
export class JournalError extends Error {
  /** @param message - what is wrong. */
  constructor(message: string) {
    super(message)
    this.name = 'JournalError'
  }
}

/**
 * Whether `value` is a string array.
 * @param value - the value.
 * @returns true for an array of strings.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/**
 * Check a parsed `ExplicitRead`.
 * @param value - the value.
 * @returns it, or `undefined` when it is not one.
 */
function explicitRead(value: unknown): ExplicitRead | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  switch (record['kind']) {
    case 'unset':
      return { kind: 'unset' }
    case 'unknown':
      return typeof record['detail'] === 'string' ? { kind: 'unknown', detail: record['detail'] } : undefined
    case 'set': {
      const source = record['source']
      if (typeof record['value'] !== 'string') return undefined
      if (source !== 'process' && source !== 'login-shell' && source !== 'user-environment') return undefined
      return { kind: 'set', value: record['value'], source }
    }
    default:
      return undefined
  }
}

/**
 * Check a parsed journal document.
 * @param value - the parsed JSON.
 * @returns the journal.
 * @throws a {@link JournalError} naming the first field that is wrong.
 */
export function validateJournal(value: unknown): MoveJournal {
  const fail = (field: string): never => { throw new JournalError(`journal: ${field} is missing or invalid`) }
  if (typeof value !== 'object' || value === null) return fail('document')
  const r = value as Record<string, unknown>
  if (r['version'] !== JOURNAL_VERSION) return fail('version')
  const text = (field: string): string => typeof r[field] === 'string' ? r[field] : fail(field)
  const path = (field: string): string => {
    const found = text(field)
    return isAbsolute(found) ? found : fail(field)
  }
  const flag = (field: string): boolean => typeof r[field] === 'boolean' ? r[field] : fail(field)
  const count = (field: string): number => typeof r[field] === 'number' && Number.isInteger(r[field]) && r[field] >= 0 ? r[field] : fail(field)
  const phase = text('phase')
  if (!(MOVE_PHASES as readonly string[]).includes(phase)) return fail('phase')
  const aliases = r['sourceAliases']
  if (!isStringArray(aliases) || aliases.length === 0 || !aliases.every(alias => isAbsolute(alias))) return fail('sourceAliases')
  const pointerBefore = r['pointerBefore']
  if (typeof pointerBefore !== 'object' || pointerBefore === null) return fail('pointerBefore')
  const { main, backup } = pointerBefore as Record<string, unknown>
  if ((main !== undefined && typeof main !== 'string') || (backup !== undefined && typeof backup !== 'string')) return fail('pointerBefore')
  const terminalBefore = explicitRead(r['terminalBefore']) ?? fail('terminalBefore')
  const homeLink = r['homeLinkBefore']
  if (typeof homeLink !== 'object' || homeLink === null) return fail('homeLinkBefore')
  const link = homeLink as Record<string, unknown>
  let homeLinkBefore: HomeLinkBefore
  if (link['kind'] === 'absent' || link['kind'] === 'other') homeLinkBefore = { kind: link['kind'] }
  else if (link['kind'] === 'link' && typeof link['target'] === 'string') homeLinkBefore = { kind: 'link', target: link['target'] }
  else return fail('homeLinkBefore')
  const baseline = r['baseline']
  if (typeof baseline !== 'object' || baseline === null) return fail('baseline')
  const b = baseline as Record<string, unknown>
  if (typeof b['sessions'] !== 'number' || typeof b['workspaces'] !== 'number' || !isStringArray(b['quarantined'])) return fail('baseline')
  const rewrites = r['linkRewrites']
  if (!Array.isArray(rewrites)) return fail('linkRewrites')
  const linkRewrites: InPlaceRewrite[] = rewrites.map((item: unknown) => {
    const rw = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {}
    const { rel, from, to } = rw
    return typeof rel === 'string' && typeof from === 'string' && typeof to === 'string' ? { rel, from, to } : fail('linkRewrites')
  })
  const leftoversRaw = r['leftovers']
  if (!Array.isArray(leftoversRaw)) return fail('leftovers')
  const leftovers: JournalLeftover[] = leftoversRaw.map((item: unknown) => {
    const lo = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {}
    return typeof lo['path'] === 'string' && typeof lo['bytes'] === 'number' ? { path: lo['path'], bytes: lo['bytes'] } : fail('leftovers')
  })
  const dataId = text('dataId')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(dataId)) return fail('dataId')
  const journal: MoveJournal = {
    version: JOURNAL_VERSION,
    moveId: text('moveId') as MoveId,
    phase: phase as MovePhase,
    pid: count('pid'),
    source: path('source'),
    sourceAliases: aliases,
    target: path('target'),
    targetPreexisting: flag('targetPreexisting'),
    partial: path('partial'),
    hidden: path('hidden'),
    sameVolume: flag('sameVolume'),
    dataId: dataId as DataId,
    pointerBefore: { ...typeof main === 'string' ? { main } : {}, ...typeof backup === 'string' ? { backup } : {} },
    terminalBefore,
    homeLinkBefore,
    baseline: { sessions: b['sessions'], workspaces: b['workspaces'], quarantined: b['quarantined'] },
    linkRewrites,
    repairRounds: count('repairRounds'),
    pointerWritten: flag('pointerWritten'),
    terminalWritten: flag('terminalWritten'),
    homeLinkRestored: flag('homeLinkRestored'),
    cleanupAttempts: count('cleanupAttempts'),
    leftovers,
    startedAt: text('startedAt'),
  }
  const lastSeenEnvBefore = r['lastSeenEnvBefore']
  if (lastSeenEnvBefore !== undefined) {
    if (typeof lastSeenEnvBefore !== 'string' || !isAbsolute(lastSeenEnvBefore)) return fail('lastSeenEnvBefore')
    journal.lastSeenEnvBefore = lastSeenEnvBefore
  }
  const failure = r['failure']
  if (failure !== undefined) {
    const f = typeof failure === 'object' && failure !== null ? failure as Record<string, unknown> : {}
    const failedPhase = f['phase']
    if (typeof failedPhase !== 'string' || !(MOVE_PHASES as readonly string[]).includes(failedPhase) || typeof f['detail'] !== 'string') {
      return fail('failure')
    }
    journal.failure = { phase: failedPhase as MovePhase, detail: f['detail'] }
  }
  return journal
}

/**
 * Read the journal.
 * @param dir - the move directory.
 * @returns the journal, or `undefined` when there is none.
 * @throws a {@link JournalError} when the file exists but cannot be read or is invalid.
 */
export function readJournal(dir: string): MoveJournal | undefined {
  let text: string
  try {
    text = readFileSync(join(dir, JOURNAL_FILENAME), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new JournalError(`journal: cannot read: ${String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new JournalError(`journal: not JSON: ${String(error)}`)
  }
  return validateJournal(parsed)
}

/**
 * Replace the journal durably.
 * @param dir - the move directory; must exist.
 * @param journal - the new content.
 * @throws when it cannot be written.
 */
export function writeJournal(dir: string, journal: MoveJournal): void {
  writeDurably(join(dir, JOURNAL_FILENAME), Buffer.from(`${JSON.stringify(journal, null, 2)}\n`))
}

/**
 * Read the last move's result.
 * @param dir - the move directory.
 * @returns the result, or `undefined` when there is none or it cannot be read.
 */
export function readMoveResult(dir: string): MoveResult | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(dir, RESULT_FILENAME), 'utf8'))
  } catch {
    // ENOENT when no move has finished, or a damaged file: either way there
    // is no result to show.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const r = parsed as Record<string, unknown>
  const outcome = r['outcome']
  if (r['version'] !== JOURNAL_VERSION || (outcome !== 'moved' && outcome !== 'cancelled' && outcome !== 'failed')) return undefined
  if (typeof r['moveId'] !== 'string' || typeof r['source'] !== 'string' || typeof r['target'] !== 'string') return undefined
  if (typeof r['finishedAt'] !== 'string' || !Array.isArray(r['leftovers'])) return undefined
  const leftovers = (r['leftovers'] as unknown[]).flatMap((item) => {
    const lo = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {}
    return typeof lo['path'] === 'string' && typeof lo['bytes'] === 'number' ? [{ path: lo['path'], bytes: lo['bytes'] }] : []
  })
  return {
    version: JOURNAL_VERSION,
    moveId: r['moveId'] as MoveId,
    outcome,
    source: r['source'],
    target: r['target'],
    ...typeof r['detail'] === 'string' ? { detail: r['detail'] } : {},
    leftovers,
    finishedAt: r['finishedAt'],
  }
}

/** What is at one of the move's directories. */
export interface DirFacts {
  exists: boolean
  /** Its identity marker: this data's identity, another, or none. */
  dataId: 'ours' | 'other' | 'none'
  /** Whether it holds `.dsh-data-id.moved`. */
  movedId: boolean
  /** Its move marker: this move's, another, or none. */
  state: 'ours' | 'other' | 'none'
  /** Whether it is an empty directory. */
  empty: boolean
}

/** What is on disk now. */
export interface MoveFacts {
  source: DirFacts
  partial: DirFacts
  target: DirFacts
  hidden: DirFacts
}

/** Why a move can neither go on nor be undone without the person. */
export type BlockedReason =
  /**
   * Something that is not this data now occupies the data directory's old
   * path (a terminal `dsh` recreated `~/.dsh`, say), so the original cannot be
   * put back there, or its rename could not be completed.
   */
  | 'source-occupied'
  /** The original is neither at its old path nor hidden beside it: its disk is not attached, or it was removed. */
  | 'source-missing'

/** One step. */
export type MoveAction =
  | { kind: 'abandon'; detail: string }
  | { kind: 'roll-back'; detail: string }
  | { kind: 'cancel' }
  | { kind: 'blocked'; reason: BlockedReason; dataAt: string[] }
  | { kind: 'keep-unmarked'; path: string }
  | { kind: 'plan-links' }
  | { kind: 'set-phase'; phase: MovePhase }
  | { kind: 'create-partial' }
  | { kind: 'copy' }
  | { kind: 'verify'; hash: 'all' | 'none'; then: MovePhase }
  | { kind: 'remove-empty-target' }
  | { kind: 'rename-partial-to-target' }
  | { kind: 'retire-source-id' }
  | { kind: 'mark-source' }
  | { kind: 'rename-source-to-hidden' }
  | { kind: 'write-target-id' }
  | { kind: 'clear-target-state' }
  | { kind: 'rename-source-to-target' }
  | { kind: 'rewrite-links' }
  | { kind: 'write-pointer' }
  | { kind: 'sync-terminal' }
  | { kind: 'await-health' }
  | { kind: 'remove-hidden' }
  | { kind: 'remove-partial' }
  | { kind: 'remove-target' }
  | { kind: 'recreate-empty-target' }
  | { kind: 'restore-home-link' }
  | { kind: 'mark-target' }
  | { kind: 'unlink-target-id' }
  | { kind: 'rename-hidden-to-source' }
  | { kind: 'restore-source-id' }
  | { kind: 'clear-source-state' }
  | { kind: 'return-target-to-source' }
  | { kind: 'restore-pointer' }
  | { kind: 'restore-terminal' }
  | { kind: 'finish'; outcome: MoveResult['outcome'] }

/**
 * Whether a directory's removal was already given up and recorded.
 * @param journal - the journal.
 * @param path - the directory.
 * @returns true when a leftover under that path is recorded.
 */
function leftBehind(journal: MoveJournal, path: string): boolean {
  return journal.leftovers.some(left => left.path === path || left.path.startsWith(`${path}/`) || left.path.startsWith(`${path}\\`))
}

/**
 * Where this data is on disk now, for the person when the move is blocked:
 * the original (at its old path, or hidden beside it) first, then a complete
 * copy at the target.
 * @param journal - the journal.
 * @param facts - what is on disk now.
 * @returns the directories holding the data.
 */
export function dataLocations(journal: MoveJournal, facts: MoveFacts): string[] {
  const { source, target, hidden } = facts
  const found: string[] = []
  if (source.exists && (source.dataId === 'ours' || source.movedId)) found.push(journal.source)
  if (hidden.exists && hidden.state === 'ours') found.push(journal.hidden)
  const copyComplete = !journal.sameVolume && !CANCELLABLE_PHASES.has(journal.phase)
  if (target.exists && (target.dataId === 'ours' || (copyComplete && target.state === 'ours'))) found.push(journal.target)
  return found
}

/**
 * The blocked step.
 * @param journal - the journal.
 * @param facts - what is on disk now.
 * @returns a `blocked` action naming why and where the data is.
 */
function blocked(journal: MoveJournal, facts: MoveFacts): MoveAction {
  return { kind: 'blocked', reason: facts.source.exists ? 'source-occupied' : 'source-missing', dataAt: dataLocations(journal, facts) }
}

/**
 * The step that removes a folder this move made, or records it as left
 * behind when it does not carry this move's marker and is not empty.
 * @param dir - the folder's facts.
 * @param path - the folder.
 * @param remove - the removal step.
 * @returns the step.
 */
function removeIfMarked(dir: DirFacts, path: string, remove: MoveAction): MoveAction {
  return dir.state === 'ours' || dir.empty ? remove : { kind: 'keep-unmarked', path }
}

/**
 * Decide the next step.
 *
 * The original is never given up for a path that does not hold it: a
 * directory at the source path that is not this data (no identity, no retired
 * identity) stops the move as `blocked`, with the journal kept, and no copy is
 * deleted while the original is not back at its path.
 * @param journal - the journal.
 * @param facts - what is on disk now.
 * @param cancelRequested - whether the person asked to cancel.
 * @returns the step.
 */
export function nextAction(journal: MoveJournal, facts: MoveFacts, cancelRequested: boolean): MoveAction {
  const { source, partial, target, hidden } = facts
  const phase = journal.phase
  if (cancelRequested && CANCELLABLE_PHASES.has(phase)) return { kind: 'cancel' }
  const emptyPreexisting = journal.targetPreexisting && target.exists && target.empty
  const sourceIsOurs = source.exists && source.dataId === 'ours'
  switch (phase) {
    case 'requested':
      if (!sourceIsOurs) return { kind: 'abandon', detail: 'the data directory is not where it was, or no longer carries its identity' }
      if (target.exists && !emptyPreexisting) return { kind: 'abandon', detail: 'something is already at the target' }
      return journal.sameVolume ? { kind: 'plan-links' } : { kind: 'set-phase', phase: 'copying' }
    case 'copying':
      if (!partial.exists || partial.state !== 'ours') return { kind: 'create-partial' }
      return { kind: 'copy' }
    case 'verifying':
      return { kind: 'verify', hash: 'all', then: 'catching-up' }
    case 'catching-up':
      return { kind: 'verify', hash: 'none', then: 'finalizing' }
    case 'finalizing':
      if (partial.exists) {
        if (!target.exists) return { kind: 'rename-partial-to-target' }
        return emptyPreexisting ? { kind: 'remove-empty-target' } : { kind: 'abandon', detail: 'something is already at the target' }
      }
      if (target.exists && target.state === 'ours') return { kind: 'set-phase', phase: 'hiding-source' }
      return { kind: 'abandon', detail: 'the copy is gone' }
    case 'hiding-source':
      return journal.sameVolume ? hideByRename(journal, facts, emptyPreexisting) : hideBeside(journal, facts)
    case 'switching':
      return journal.pointerWritten ? { kind: 'sync-terminal' } : { kind: 'write-pointer' }
    case 'switched':
      return { kind: 'await-health' }
    case 'cleanup':
      if (!journal.sameVolume && hidden.exists && !leftBehind(journal, journal.hidden)) {
        return removeIfMarked(hidden, journal.hidden, { kind: 'remove-hidden' })
      }
      return { kind: 'finish', outcome: 'moved' }
    case 'cancelling':
    case 'abandoning':
      if (partial.exists && !leftBehind(journal, journal.partial)) return removeIfMarked(partial, journal.partial, { kind: 'remove-partial' })
      if (target.exists && target.state === 'ours' && target.dataId !== 'ours' && !leftBehind(journal, journal.target)) {
        return sourceIsOurs ? { kind: 'remove-target' } : blocked(journal, facts)
      }
      if (journal.targetPreexisting && !target.exists) return { kind: 'recreate-empty-target' }
      return { kind: 'finish', outcome: phase === 'cancelling' ? 'cancelled' : 'failed' }
    case 'rolling-back':
      return rollbackAction(journal, facts)
    default:
      return phase satisfies never
  }
}

/**
 * The next step of hiding the source on another volume: the source retires
 * its identity, takes this move's marker, and is renamed beside itself; only
 * then does the target get the identity. Once the source is hidden, whatever
 * appears at its old path is ignored.
 * @param journal - the journal.
 * @param facts - what is on disk now.
 * @returns the step.
 */
function hideBeside(journal: MoveJournal, facts: MoveFacts): MoveAction {
  const { source, target, hidden } = facts
  if (!(hidden.exists && hidden.state === 'ours')) {
    if (source.exists && source.dataId === 'ours') return { kind: 'retire-source-id' }
    if (source.exists && source.movedId) return source.state === 'ours' ? { kind: 'rename-source-to-hidden' } : { kind: 'mark-source' }
    return blocked(journal, facts)
  }
  if (!target.exists) return { kind: 'roll-back', detail: 'the copy is gone' }
  if (target.dataId !== 'ours') return { kind: 'write-target-id' }
  if (target.state === 'ours') return { kind: 'clear-target-state' }
  return { kind: 'set-phase', phase: 'switching' }
}

/**
 * The next step of moving the source by rename on one volume. Once the data
 * is at the target, whatever appears at its old path is ignored.
 * @param journal - the journal.
 * @param facts - what is on disk now.
 * @param emptyPreexisting - whether the target is the empty folder the person picked.
 * @returns the step.
 */
function hideByRename(journal: MoveJournal, facts: MoveFacts, emptyPreexisting: boolean): MoveAction {
  const { source, target } = facts
  if (source.exists && source.dataId === 'ours') {
    if (!target.exists) return { kind: 'rename-source-to-target' }
    return emptyPreexisting ? { kind: 'remove-empty-target' } : { kind: 'abandon', detail: 'something is already at the target' }
  }
  if (target.exists && target.dataId === 'ours') return { kind: 'rewrite-links' }
  return blocked(journal, facts)
}

/**
 * The next rollback step (plan S8′): `~/.dsh` first; then, only once the
 * original can go back to its path, the target is made unusable and the
 * original is put back; only after that is any copy deleted; the pointer and
 * the terminal last.
 * @param journal - the journal.
 * @param facts - what is on disk now.
 * @returns the step.
 */
function rollbackAction(journal: MoveJournal, facts: MoveFacts): MoveAction {
  const { source, partial, target, hidden } = facts
  if (!journal.homeLinkRestored) return { kind: 'restore-home-link' }
  const sourceIsOurs = source.exists && source.dataId === 'ours'
  if (journal.sameVolume) {
    if (target.exists && target.dataId === 'ours') return source.exists ? blocked(journal, facts) : { kind: 'return-target-to-source' }
    if (!sourceIsOurs) return blocked(journal, facts)
  } else {
    const hiddenIsOurs = hidden.exists && hidden.state === 'ours'
    if (source.exists && !sourceIsOurs && !source.movedId) return blocked(journal, facts)
    if (!source.exists && !hiddenIsOurs) return blocked(journal, facts)
    if (target.exists && target.dataId === 'ours' && target.state !== 'ours') return { kind: 'mark-target' }
    if (target.exists && target.dataId === 'ours') return { kind: 'unlink-target-id' }
    if (!source.exists) return { kind: 'rename-hidden-to-source' }
    if (source.movedId && source.dataId === 'none') return { kind: 'restore-source-id' }
    if (source.state === 'ours') return { kind: 'clear-source-state' }
    if (target.exists && target.state === 'ours' && sourceIsOurs && !leftBehind(journal, journal.target)) return { kind: 'remove-target' }
    if (partial.exists && !leftBehind(journal, journal.partial)) return removeIfMarked(partial, journal.partial, { kind: 'remove-partial' })
    if (!sourceIsOurs) return blocked(journal, facts)
  }
  if (journal.targetPreexisting && !target.exists) return { kind: 'recreate-empty-target' }
  if (journal.pointerWritten) return { kind: 'restore-pointer' }
  if (journal.terminalWritten) return { kind: 'restore-terminal' }
  return { kind: 'finish', outcome: 'failed' }
}
