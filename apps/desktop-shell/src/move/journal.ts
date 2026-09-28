/**
 * The data-move journal and the decision of what to do next.
 *
 * The journal, `<userData>/data-move/journal.json`, records one move from its
 * confirmation to its end: the phase, the paths involved, and everything a
 * rollback restores (the pointer's files byte for byte, the terminal's
 * `DSH_HOME`, what `~/.dsh` was). It lives under Electron's user-data
 * directory, never in the source or the target: the source is deleted at the
 * end and the target may be retired or unplugged.
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
 *
 * Once anything outside the move could have used the target (from the moment
 * the pointer is about to name it; {@link MoveJournal.targetExposed}), no step
 * deletes it: a rollback retires it in place instead. It loses its identity,
 * takes a retired marker, and is renamed to a visible sibling folder the
 * person can check and delete themselves.
 * @module @deepseek-ai/dsh-desktop-shell/move/journal
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { writeDurably } from '../durable-file.ts'
import type { DataId } from '../data-location.ts'
import { parseTerminalSnapshot, type ExplicitRead, type TerminalSnapshot } from '../terminal-env.ts'
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
export { RETIRED_FILENAME } from '../data-location.ts'
/** Copies left on a drive that was not attached when the person rolled back without them; see {@link AbandonedCopy}. */
export const ABANDONED_FILENAME = 'abandoned-copies.json'
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
  /**
   * Workspace records before the move, as the server reports them; absent
   * when no count was available, and then not compared.
   */
  workspaces?: number
  /** Plugins already quarantined before the move. */
  quarantined: string[]
}

/**
 * A hash over every entry of a directory tree (see `fingerprintTree` in
 * [[@deepseek-ai/dsh-desktop-shell/move/tree]]). It only chooses what the
 * person is told; no step deletes or keeps anything because of it.
 */
export type TargetPrint = string

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
  /**
   * The persistent setting itself before the move (the profile's bytes, or
   * the Windows variable with its registry type), for a byte-exact rollback;
   * `terminalBefore` says what a terminal saw, which may come from another
   * file.
   */
  terminalSnapshot: TerminalSnapshot
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
  /**
   * Set, and never cleared, in the same write that first records the pointer
   * as naming the target (before the pointer or the terminal is told about
   * it): from then on something outside the move may have used the target,
   * and no step deletes it.
   */
  targetExposed: boolean
  /** Removals of the hidden original that left something behind, in phase `cleanup`. */
  cleanupAttempts: number
  /** Bytes the last of those removals left behind; zero before any did. */
  cleanupLeftoverBytes: number
  /**
   * The move stopped as blocked while rolling back; it goes on only after the
   * person chooses (see `resolveBlocked`), even once the obstruction is gone.
   */
  awaitingChoice: boolean
  /** The person chose to keep the new location after the move was blocked. */
  keepTarget: boolean
  /** The original is kept, not deleted, at the end (kept by choice after a failed health check). */
  keepOriginal: boolean
  /** The person chose to roll back without the copy, whose disk is not attached; it stays where it is. */
  targetAbandoned: boolean
  /**
   * The person chose to keep the new location while the original could not
   * be found (on another volume). Cleared as soon as the original is seen
   * again, since the move then hides and deletes it as usual; still set when
   * the move ends, the original's possible paths are recorded as abandoned.
   */
  originalAbandoned: boolean
  /**
   * The target's print when the move last entered `rolling-back` (or the
   * person last chose to); absent when the target was not there. A blocked
   * rollback tells the person the new location changed when its print now
   * differs or this is absent.
   */
  targetFingerprint?: TargetPrint
  /** The visible sibling folder the retired target is renamed to; chosen before the rename. */
  unusedCopy?: string
  /**
   * Renaming the retired target failed (on Windows, a program holding a file
   * in it open past every retry): it stays at its path, retired, and the
   * rollback goes on. The result names that path as the unused copy.
   */
  retiredInPlace: boolean
  /**
   * The original's generation (`.dsh-data-generation`): read when the move
   * starts, raised when a rollback gives the original a number above the
   * copy's, so a copy left behind is older.
   */
  originalGeneration: number
  /**
   * The copy's generation, above the original's, chosen and recorded before
   * it is written into the copy (on another volume); absent until then.
   */
  targetGeneration?: number
  /** The visible sibling folder the original is renamed to when it is kept; chosen before the rename. */
  keptOriginal?: string
  leftovers: JournalLeftover[]
  /** Why the move is being given up or rolled back. */
  failure?: { phase: MovePhase; detail: string }
  startedAt: string
}

/** What starting a move needs; the rest of the journal is derived. */
export type MoveStart = Pick<MoveJournal,
  'source' | 'sourceAliases' | 'target' | 'targetPreexisting' | 'sameVolume' | 'dataId' | 'pointerBefore'
  | 'lastSeenEnvBefore' | 'terminalBefore' | 'terminalSnapshot' | 'homeLinkBefore' | 'baseline' | 'originalGeneration'>

/** A folder the move left for the person to check and delete themselves. */
export interface KeptFolder {
  path: string
}

/** How a move ended, as Settings reports it. */
export interface MoveResult {
  version: typeof JOURNAL_VERSION
  moveId: MoveId
  outcome: 'moved' | 'cancelled' | 'failed'
  source: string
  target: string
  detail?: string
  /** What a removal could not delete; Settings may offer to try again. */
  leftovers: JournalLeftover[]
  /** A rollback retired the copy at the new location into this folder; nothing deletes it. */
  unusedCopy?: KeptFolder
  /** A rollback went on without the copy at the new location, whose drive was not attached; it is still there. */
  abandonedCopy?: KeptFolder
  /**
   * The person kept the new location while the original could not be found;
   * the original is still wherever its drive is, recorded as abandoned, and
   * retired as an unused copy once that drive is attached again.
   */
  abandonedOriginal?: KeptFolder
  /**
   * The new location failed its check again after the person chose it; the
   * application goes on from it, and the original is kept here. Never among
   * `leftovers`: nothing deletes it.
   */
  keptOriginal?: KeptFolder
  finishedAt: string
}

/**
 * One copy of this data left on a drive that was away: the copy at the new
 * location a rollback went on without, or the original the person moved on
 * without.
 */
export interface AbandonedCopy {
  path: string
  dataId: DataId
  moveId: MoveId
  abandonedAt: string
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
    targetExposed: false,
    retiredInPlace: false,
    cleanupAttempts: 0,
    cleanupLeftoverBytes: 0,
    awaitingChoice: false,
    keepTarget: false,
    keepOriginal: false,
    targetAbandoned: false,
    originalAbandoned: false,
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
  const terminalSnapshot = parseTerminalSnapshot(r['terminalSnapshot']) ?? fail('terminalSnapshot')
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
  const workspaces = b['workspaces']
  if (typeof b['sessions'] !== 'number' || (workspaces !== undefined && typeof workspaces !== 'number') || !isStringArray(b['quarantined'])) {
    return fail('baseline')
  }
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
    terminalSnapshot,
    homeLinkBefore,
    baseline: { sessions: b['sessions'], ...typeof workspaces === 'number' ? { workspaces } : {}, quarantined: b['quarantined'] },
    linkRewrites,
    repairRounds: count('repairRounds'),
    pointerWritten: flag('pointerWritten'),
    terminalWritten: flag('terminalWritten'),
    homeLinkRestored: flag('homeLinkRestored'),
    targetExposed: flag('targetExposed'),
    retiredInPlace: flag('retiredInPlace'),
    originalGeneration: count('originalGeneration'),
    cleanupAttempts: count('cleanupAttempts'),
    cleanupLeftoverBytes: count('cleanupLeftoverBytes'),
    awaitingChoice: flag('awaitingChoice'),
    keepTarget: flag('keepTarget'),
    keepOriginal: flag('keepOriginal'),
    targetAbandoned: flag('targetAbandoned'),
    originalAbandoned: flag('originalAbandoned'),
    leftovers,
    startedAt: text('startedAt'),
  }
  const lastSeenEnvBefore = r['lastSeenEnvBefore']
  if (lastSeenEnvBefore !== undefined) {
    if (typeof lastSeenEnvBefore !== 'string' || !isAbsolute(lastSeenEnvBefore)) return fail('lastSeenEnvBefore')
    journal.lastSeenEnvBefore = lastSeenEnvBefore
  }
  if (r['targetFingerprint'] !== undefined) journal.targetFingerprint = text('targetFingerprint')
  if (r['unusedCopy'] !== undefined) journal.unusedCopy = path('unusedCopy')
  if (r['targetGeneration'] !== undefined) journal.targetGeneration = count('targetGeneration')
  if (r['keptOriginal'] !== undefined) journal.keptOriginal = path('keptOriginal')
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
  const kept = (field: string): { [key: string]: KeptFolder } => {
    const value = r[field]
    const path = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['path'] : undefined
    return typeof path === 'string' ? { [field]: { path } } : {}
  }
  return {
    version: JOURNAL_VERSION,
    moveId: r['moveId'] as MoveId,
    outcome,
    source: r['source'],
    target: r['target'],
    ...typeof r['detail'] === 'string' ? { detail: r['detail'] } : {},
    leftovers,
    ...kept('unusedCopy'),
    ...kept('abandonedCopy'),
    ...kept('abandonedOriginal'),
    ...kept('keptOriginal'),
    finishedAt: r['finishedAt'],
  }
}

/**
 * Read the copies left on drives that were away when the person rolled back
 * without them. Each still carries this data's identity; A7 refuses such a
 * folder as a data directory (see {@link isAbandonedCopy}).
 * @param dir - the move directory.
 * @returns the copies; none when the file is absent.
 * @throws a {@link JournalError} when the file exists but cannot be read or is invalid.
 */
export function readAbandonedCopies(dir: string): AbandonedCopy[] {
  let text: string
  try {
    text = readFileSync(join(dir, ABANDONED_FILENAME), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new JournalError(`abandoned copies: cannot read: ${String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new JournalError(`abandoned copies: not JSON: ${String(error)}`)
  }
  const copies = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['copies'] : undefined
  if ((parsed as Record<string, unknown> | null)?.['version'] !== JOURNAL_VERSION || !Array.isArray(copies)) {
    throw new JournalError('abandoned copies: invalid document')
  }
  return copies.map((item: unknown) => {
    const c = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {}
    const { path, dataId, moveId, abandonedAt } = c
    if (typeof path !== 'string' || !isAbsolute(path) || typeof dataId !== 'string' || typeof moveId !== 'string' || typeof abandonedAt !== 'string') {
      throw new JournalError('abandoned copies: invalid entry')
    }
    return { path, dataId: dataId as DataId, moveId: moveId as MoveId, abandonedAt }
  })
}

/**
 * A free name, in the move directory, for setting an unreadable record of
 * abandoned copies aside: `abandoned-copies.corrupt-<time>.json`, with `-2`,
 * `-3`, … before `.json` when that name is taken.
 * @param dir - the move directory.
 * @param now - the time the name carries.
 * @returns the file name, not yet used in `dir`.
 */
export function abandonedCopiesAsideName(dir: string, now: Date): string {
  const stem = `abandoned-copies.corrupt-${now.toISOString().replace(/[:.]/g, '-')}`
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? `${stem}.json` : `${stem}-${n}.json`
    if (!existsSync(join(dir, name))) return name
  }
}

/**
 * Rename an unreadable record of abandoned copies to `name` in the same
 * directory, so the launch can go on without it. A record that has become
 * readable (or absent) since is left where it is, so a repaired file is never
 * set aside.
 * @param dir - the move directory.
 * @param name - from {@link abandonedCopiesAsideName}.
 * @returns whether the file was renamed.
 * @throws what renaming throws; a {@link JournalError} when `name` has been taken since.
 */
export function setAbandonedCopiesAside(dir: string, name: string): boolean {
  try {
    readAbandonedCopies(dir)
    return false
  } catch (error) {
    if (!(error instanceof JournalError)) throw error
  }
  // renameSync replaces an existing target on every platform we ship; the
  // check keeps an earlier set-aside file from being overwritten.
  if (existsSync(join(dir, name))) throw new JournalError(`abandoned copies: ${name} already exists`)
  renameSync(join(dir, ABANDONED_FILENAME), join(dir, name))
  return true
}

/**
 * The document holding the abandoned copies.
 * @param copies - the copies.
 * @returns its text.
 */
export function abandonedCopiesText(copies: readonly AbandonedCopy[]): string {
  return `${JSON.stringify({ version: JOURNAL_VERSION, copies }, null, 2)}\n`
}

/**
 * Whether a folder is a copy a rollback went on without: A7 refuses it as a
 * data directory. The copy has the same identity as the data the person uses
 * now, so the identity alone cannot tell them apart; the recorded path does.
 * @param copies - the recorded copies ({@link readAbandonedCopies}).
 * @param path - the folder, as the pointer or `DSH_HOME` names it.
 * @param dataId - the identity it carries.
 * @param samePath - whether two paths name the same folder (case-folding where the file system does).
 * @returns true when it is a recorded copy.
 */
export function isAbandonedCopy(
  copies: readonly AbandonedCopy[], path: string, dataId: DataId, samePath: (a: string, b: string) => boolean,
): boolean {
  return copies.some(copy => copy.dataId === dataId && samePath(copy.path, path))
}

/** What is at one of the move's directories. */
export interface DirFacts {
  exists: boolean
  /** Its identity marker: this data's identity, another, or none. */
  dataId: 'ours' | 'other' | 'none'
  /** Whether it holds `.dsh-data-id.moved`. */
  movedId: boolean
  /** Whether it holds the retired marker ({@link RETIRED_FILENAME}). */
  retired: boolean
  /** Its generation; 0 when it has none. */
  generation: number
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
  /**
   * The target's print now; read only while a rollback waits for the
   * person's choice, to tell them whether the new location changed.
   */
  targetPrint?: TargetPrint
  /** What is at the folder chosen for the retired target, once one is chosen. */
  unusedCopy?: DirFacts
  /** What is at the folder chosen for the kept original, once one is chosen. */
  keptOriginal?: DirFacts
}

/** Why a move can neither go on nor be undone without the person. */
export type BlockedReason =
  /** Something that is not this data now occupies the data directory's old path (a terminal `dsh` recreated `~/.dsh`, say). */
  | 'source-occupied'
  /** The original is neither at its old path nor hidden beside it: its disk is not attached, or it was removed. */
  | 'original-missing'
  /** The copy at the new location cannot be found: its disk is not attached. */
  | 'target-missing'
  /** Something that is not this move's copy now occupies the new location's path. */
  | 'target-occupied'
  /**
   * Files at the new location changed after the move started going back (or
   * the person last chose); going back keeps them in an unused copy.
   */
  | 'target-changed'
  /** The obstruction is gone, and the move waits for the person to choose how to go on. */
  | 'choice-needed'

/** What the person can choose on a blocked move. */
export type BlockedChoice =
  /** Use the new location: finish the move forward, with the copy there. */
  | 'keep-target'
  /** Go back to the old location: continue the rollback. */
  | 'rollback'

/** One step. */
export type MoveAction =
  | { kind: 'abandon'; detail: string }
  | { kind: 'roll-back'; detail: string }
  | { kind: 'cancel' }
  | { kind: 'blocked'; reason: BlockedReason; dataAt: string[]; choices: BlockedChoice[] }
  | { kind: 'keep-unmarked'; path: string }
  | { kind: 'original-found' }
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
  | { kind: 'write-target-generation' }
  | { kind: 'write-original-generation' }
  | { kind: 'clear-target-state' }
  | { kind: 'rename-source-to-target' }
  | { kind: 'rewrite-links' }
  | { kind: 'write-pointer' }
  | { kind: 'sync-terminal' }
  | { kind: 'await-health' }
  | { kind: 'remove-hidden' }
  | { kind: 'remove-partial' }
  | { kind: 'remove-target' }
  | { kind: 'mark-target-retired' }
  | { kind: 'clear-target-retired' }
  | { kind: 'name-unused-copy' }
  | { kind: 'rename-target-to-unused' }
  | { kind: 'mark-hidden-retired' }
  | { kind: 'name-kept-original' }
  | { kind: 'rename-hidden-to-kept' }
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
export function leftBehind(journal: MoveJournal, path: string): boolean {
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
  const { source, hidden } = facts
  const found: string[] = []
  if (source.exists && (source.dataId === 'ours' || source.movedId)) found.push(journal.source)
  if (hidden.exists && hidden.state === 'ours') found.push(journal.hidden)
  if (targetIsComplete(journal, facts)) found.push(journal.target)
  return found
}

/** Phases after the copy was checked and put in place. */
const COPY_IN_PLACE: ReadonlySet<MovePhase> = new Set(['hiding-source', 'switching', 'switched', 'cleanup', 'rolling-back'])

/**
 * Whether the target holds a complete copy of the data: the identity, or,
 * on another volume once the checked copy was renamed into place, this move's
 * marker. A folder that is neither (someone else's, at the same path) is not.
 * @param journal - the journal.
 * @param facts - what is on disk now.
 * @returns true when the person could keep the target as the data.
 */
export function targetIsComplete(journal: MoveJournal, facts: MoveFacts): boolean {
  const { target } = facts
  if (!target.exists) return false
  if (target.dataId === 'ours') return true
  return !journal.sameVolume && COPY_IN_PLACE.has(journal.phase) && target.state === 'ours'
}

/**
 * The choices a blocked move offers. Keeping the target needs a complete
 * copy there. Rolling back needs the move to have got as far as hiding the
 * source, the original to be found, and nothing in its way at its old path.
 * @param journal - the journal.
 * @param facts - what is on disk now.
 * @param reason - why the move is blocked.
 * @returns the choices, in the order to show them.
 */
export function blockedChoices(journal: MoveJournal, facts: MoveFacts, reason: BlockedReason): BlockedChoice[] {
  const choices: BlockedChoice[] = []
  if (targetIsComplete(journal, facts)) choices.push('keep-target')
  const { source, hidden, target } = facts
  // On one volume the original is what was renamed to the target.
  const original = (source.exists && (source.dataId === 'ours' || source.movedId)) || (hidden.exists && hidden.state === 'ours')
    || (journal.sameVolume && target.exists && target.dataId === 'ours')
  const inPlace = journal.phase === 'rolling-back' || journal.phase === 'hiding-source'
  if (original && inPlace && ROLLBACK_CHOOSABLE.has(reason)) choices.push('rollback')
  return choices
}

/**
 * Reasons a rollback can go on from once the person chooses it: the choice
 * itself settles them. An occupied or missing original is settled only by the
 * person moving the folder or attaching the disk.
 */
const ROLLBACK_CHOOSABLE: ReadonlySet<BlockedReason> = new Set(['choice-needed', 'target-missing', 'target-changed', 'target-occupied'])

/**
 * The blocked step.
 * @param journal - the journal.
 * @param facts - what is on disk now.
 * @param reason - why.
 * @returns a `blocked` action naming why, where the data is, and what the person can choose.
 */
function blocked(journal: MoveJournal, facts: MoveFacts, reason: BlockedReason): MoveAction {
  return { kind: 'blocked', reason, dataAt: dataLocations(journal, facts), choices: blockedChoices(journal, facts, reason) }
}

/**
 * Why the original cannot be reached: something else at its path, or nothing.
 * @param facts - what is on disk now.
 * @returns the reason.
 */
function sourceReason(facts: MoveFacts): BlockedReason {
  return facts.source.exists ? 'source-occupied' : 'original-missing'
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
 * Whether the application may start the server while this journal is on
 * disk. Only a move that has switched to the new location (to run its health
 * check) or is deleting the old copy lets the server run: in every other
 * phase the move finishes, is undone, or waits for the person first, and a
 * server running on either location could write data a later step deletes.
 * @param journal - the journal, or `undefined` when no move is recorded.
 * @returns true when the server may start.
 */
export function mayStartServer(journal: MoveJournal | undefined): boolean {
  if (journal === undefined) return true
  return journal.phase === 'switched' || journal.phase === 'cleanup'
}

/**
 * Decide the next step.
 *
 * The original is never given up for a path that does not hold it: a
 * directory at the source path that is not this data (no identity, no retired
 * identity) stops the move as `blocked`, with the journal kept, and no copy is
 * deleted while the original is not back at its path. A rollback that was
 * blocked goes on only after the person chooses.
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
  // The original came back: the move handles it as usual again, and nothing about it is recorded as abandoned.
  if (journal.originalAbandoned && ((hidden.exists && hidden.state === 'ours') || (source.exists && (sourceIsOurs || source.movedId)))) {
    return { kind: 'original-found' }
  }
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
      // The target may have gone or changed since it was named: switch only to our data.
      if (!(target.exists && target.dataId === 'ours' && target.state !== 'ours')) return { kind: 'roll-back', detail: 'the new location is no longer this data' }
      return journal.pointerWritten ? { kind: 'sync-terminal' } : { kind: 'write-pointer' }
    case 'switched':
      return { kind: 'await-health' }
    case 'cleanup':
      if (journal.keepOriginal) return keepOriginalAction(journal, facts)
      if (!journal.sameVolume && hidden.exists && !leftBehind(journal, journal.hidden)) {
        return removeIfMarked(hidden, journal.hidden, { kind: 'remove-hidden' })
      }
      return { kind: 'finish', outcome: 'moved' }
    case 'cancelling':
    case 'abandoning':
      if (partial.exists && !leftBehind(journal, journal.partial)) return removeIfMarked(partial, journal.partial, { kind: 'remove-partial' })
      // Only reached before the source is hidden, so before the target could be exposed.
      if (target.exists && target.state === 'ours' && target.dataId !== 'ours' && !leftBehind(journal, journal.target)) {
        return sourceIsOurs ? { kind: 'remove-target' } : blocked(journal, facts, sourceReason(facts))
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
 * appears at its old path is ignored. After the person chose to keep the
 * target, a missing or occupied old path no longer stops it.
 * @param journal - the journal.
 * @param facts - what is on disk now.
 * @returns the step.
 */
function hideBeside(journal: MoveJournal, facts: MoveFacts): MoveAction {
  const { source, target, hidden } = facts
  if (!(hidden.exists && hidden.state === 'ours')) {
    if (source.exists && source.dataId === 'ours') return { kind: 'retire-source-id' }
    if (source.exists && source.movedId) return source.state === 'ours' ? { kind: 'rename-source-to-hidden' } : { kind: 'mark-source' }
    if (!journal.keepTarget) return blocked(journal, facts, sourceReason(facts))
  }
  if (!target.exists) return journal.keepTarget ? blocked(journal, facts, 'target-missing') : { kind: 'roll-back', detail: 'the copy is gone' }
  // Only the checked copy (marked as this move) or this data may be named; never someone else's folder at that path.
  if (target.dataId !== 'ours' && target.state !== 'ours') return blocked(journal, facts, 'target-occupied')
  // A rollback may have started retiring it before the person chose to keep it.
  if (target.retired) return { kind: 'clear-target-retired' }
  // The copy's number goes above the original's before it is named, so the original is the older one from then on.
  if (journal.targetGeneration === undefined || journal.targetGeneration <= journal.originalGeneration
    || target.generation !== journal.targetGeneration) {
    return { kind: 'write-target-generation' }
  }
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
  return blocked(journal, facts, sourceReason(facts))
}

/**
 * The next rollback step (plan S8′): `~/.dsh` first; then, only once the
 * original can go back to its path, the target is marked retired and loses
 * its identity, and the original is put back; then the copy is dealt with,
 * and the pointer and the terminal last. A copy nothing outside the move
 * could have used is deleted. An exposed one ({@link MoveJournal.targetExposed})
 * is never deleted: it is renamed to a visible folder beside it, which the
 * result names.
 * @param journal - the journal.
 * @param facts - what is on disk now.
 * @returns the step.
 */
function rollbackAction(journal: MoveJournal, facts: MoveFacts): MoveAction {
  const { source, partial, target } = facts
  if (journal.awaitingChoice) {
    return blocked(journal, facts, obstruction(journal, facts) ?? (targetChanged(journal, facts) ? 'target-changed' : 'choice-needed'))
  }
  if (!journal.homeLinkRestored) return { kind: 'restore-home-link' }
  const reason = obstruction(journal, facts)
  if (reason !== undefined) return blocked(journal, facts, reason)
  const sourceIsOurs = source.exists && source.dataId === 'ours'
  if (journal.sameVolume) {
    // The data itself goes back by rename, with anything written at the target since; nothing is deleted.
    if (target.exists && target.dataId === 'ours') return { kind: 'return-target-to-source' }
  } else {
    if (target.exists && target.dataId === 'ours') {
      if (target.state !== 'ours') return { kind: 'mark-target' }
      if (!target.retired) return { kind: 'mark-target-retired' }
      return { kind: 'unlink-target-id' }
    }
    if (!source.exists) return { kind: 'rename-hidden-to-source' }
    // The original's number goes above the copy's before it takes its identity back, so the copy is the older one.
    if (journal.targetGeneration !== undefined
      && (journal.originalGeneration <= journal.targetGeneration || source.generation < journal.originalGeneration)) {
      return { kind: 'write-original-generation' }
    }
    if (source.movedId && source.dataId === 'none') return { kind: 'restore-source-id' }
    if (source.state === 'ours') return { kind: 'clear-source-state' }
    if (target.exists && target.state === 'ours' && sourceIsOurs && !leftBehind(journal, journal.target) && !journal.retiredInPlace) {
      if (!journal.targetExposed) return { kind: 'remove-target' }
      if (!target.retired) return { kind: 'mark-target-retired' }
      if (journal.unusedCopy === undefined || facts.unusedCopy?.exists === true) return { kind: 'name-unused-copy' }
      return { kind: 'rename-target-to-unused' }
    }
    if (partial.exists && !leftBehind(journal, journal.partial)) return removeIfMarked(partial, journal.partial, { kind: 'remove-partial' })
  }
  if (!sourceIsOurs) return blocked(journal, facts, sourceReason(facts))
  if (journal.targetPreexisting && !target.exists) return { kind: 'recreate-empty-target' }
  if (journal.pointerWritten) return { kind: 'restore-pointer' }
  if (journal.terminalWritten) return { kind: 'restore-terminal' }
  return { kind: 'finish', outcome: 'failed' }
}

/**
 * The next step of keeping the original after the new location, which the
 * person chose, failed its check again: the hidden original takes the retired
 * marker and is renamed to a visible folder beside it, which the result
 * names. Nothing deletes it.
 * @param journal - the journal.
 * @param facts - what is on disk now.
 * @returns the step.
 */
function keepOriginalAction(journal: MoveJournal, facts: MoveFacts): MoveAction {
  const { hidden } = facts
  if (!journal.sameVolume && hidden.exists && hidden.state === 'ours') {
    if (!hidden.retired) return { kind: 'mark-hidden-retired' }
    if (journal.keptOriginal === undefined || facts.keptOriginal?.exists === true) return { kind: 'name-kept-original' }
    return { kind: 'rename-hidden-to-kept' }
  }
  return { kind: 'finish', outcome: 'moved' }
}

/**
 * Whether the target differs from what it was when the move last entered
 * `rolling-back`, or when the person last chose. Only chooses what the person
 * is told.
 * @param journal - the journal, with the print taken then.
 * @param facts - what is on disk now.
 * @returns true when the target is there and its print differs or none was taken.
 */
function targetChanged(journal: MoveJournal, facts: MoveFacts): boolean {
  return facts.targetPrint !== undefined && journal.targetFingerprint !== facts.targetPrint
}

/**
 * Whether the retired target has been renamed to its unused-copy folder, or left retired at its path.
 * @param journal - the journal.
 * @param facts - what is on disk now.
 * @returns true when the chosen folder holds the retired copy.
 */
function unusedCopyMade(journal: MoveJournal, facts: MoveFacts): boolean {
  if (journal.retiredInPlace) return true
  return journal.unusedCopy !== undefined && facts.unusedCopy?.exists === true && facts.unusedCopy.retired
    && facts.unusedCopy.state === 'ours'
}

/**
 * What stops a rollback from going on, before anything is changed: the old
 * path occupied, the original nowhere, or (on another volume) the copy not
 * reachable, so it could not be made unusable or, once exposed, retired into
 * a folder the result names. The last one is waived once the person chose to
 * roll back without it.
 * @param journal - the journal.
 * @param facts - what is on disk now.
 * @returns the reason, or `undefined` when the rollback can go on.
 */
function obstruction(journal: MoveJournal, facts: MoveFacts): BlockedReason | undefined {
  const { source, target, hidden } = facts
  const sourceIsOurs = source.exists && source.dataId === 'ours'
  if (journal.sameVolume) {
    if (target.exists && target.dataId === 'ours') return source.exists ? 'source-occupied' : undefined
    return sourceIsOurs ? undefined : sourceReason(facts)
  }
  if (source.exists && !sourceIsOurs && !source.movedId) return 'source-occupied'
  if (!source.exists && !(hidden.exists && hidden.state === 'ours')) return 'original-missing'
  if (target.exists || journal.targetAbandoned) return undefined
  // Before the original is put back, the copy must be made unusable; it cannot be while its disk is away.
  if (!source.exists) return 'target-missing'
  // An exposed copy must end retired in a folder the result names, or be left behind by the person's choice.
  if (journal.targetExposed && !unusedCopyMade(journal, facts)) return 'target-missing'
  return undefined
}
