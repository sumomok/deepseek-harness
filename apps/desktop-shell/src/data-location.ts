/**
 * Where the Harness home (`DSH_HOME`) lives for this installation, when the
 * person has put it somewhere other than the default `~/.dsh`.
 *
 * Two files name the location and vouch for each other. The pointer,
 * `data-location.json` under Electron's user-data directory, records the
 * directory, the data identity, and the `DSH_HOME` value the shell last saw.
 * The identity marker, `.dsh-data-id` inside the data directory, holds the same
 * identity. A directory is this installation's data only when both agree, so a
 * different disk mounted at the same path, or a folder picked by mistake, is
 * never taken for it.
 *
 * Without a pointer the shell resolves the home exactly as it always has: a
 * non-blank `DSH_HOME` in the process environment, else `~/.dsh`. A pointer
 * whose directory is unavailable never falls back to `~/.dsh`: that would show
 * an empty home as if the data were lost, and the two directories would then
 * drift apart.
 *
 * An explicit `DSH_HOME` overrides the pointer when it is new: a value that
 * differs from `lastSeenEnv` is a change the person made in a terminal or in the
 * system settings, so the pointer follows it — but only to a directory that
 * holds Harness data. A value equal to `lastSeenEnv`, or no value, leaves the
 * pointer in charge. This module decides; it performs no prompt, and the only
 * files it writes are the pointer and the identity marker.
 *
 * A directory a data move set aside is never used, whichever of the pointer,
 * `DSH_HOME`, `~/.dsh`, or the person's pick names it (see {@link isSetAside}):
 * a copy or original in the middle of a move, a retired copy, or a copy
 * recorded as abandoned on a drive that was away.
 * @module @deepseek-ai/dsh-desktop-shell/data-location
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { writeDurably } from './durable-file.ts'
import type { AbandonedCopy } from './move/journal.ts'
import { samePathText } from './path-text.ts'

/** File name of the pointer under Electron's user-data directory. */
export const POINTER_FILENAME = 'data-location.json'
/** File name of the previous pointer, kept beside it on every write. */
export const POINTER_BACKUP_FILENAME = 'data-location.json.bak'
/** File name of the identity marker inside the data directory. */
export const DATA_ID_FILENAME = '.dsh-data-id'
/** The only pointer format this build reads and writes. */
export const POINTER_VERSION = 1
/**
 * File that marks a directory as a move in progress (a partial copy, a hidden
 * source, or a target that has no identity yet). Its content is the move id.
 * A directory holding it is never used as the data directory.
 */
export const MOVE_STATE_FILENAME = '.dsh-move-state'
/**
 * Marker of a folder that held this data and must never be used as a data
 * directory again: a retired copy at the new location, or an original kept
 * after the person chose the new location. Its content names the data and the
 * move.
 */
export const RETIRED_FILENAME = '.dsh-data-retired'
/**
 * File holding a data directory's generation, a decimal integer; absent means
 * 0. A data move gives the copy it switches to a higher number than the
 * original, and a rollback gives the original a higher number than the copy,
 * so of two folders with the same identity the one in use has the higher
 * number; the pointer records it too ({@link DataLocationPointer.generation}).
 * A folder whose number is lower than that is left over, wherever it is
 * mounted ({@link setAsideReason}).
 */
export const GENERATION_FILENAME = '.dsh-data-generation'

/**
 * Identity of one data directory: a random UUID written once into its marker
 * and copied into the pointer. The brand keeps a path or an arbitrary string
 * from being passed where an identity is compared.
 */
export type DataId = string & { readonly __brand: 'DataId' }

/** What `data-location.json` holds. */
export interface DataLocationPointer {
  version: typeof POINTER_VERSION
  /** Absolute path of the data directory. */
  path: string
  /** The identity the directory's marker must carry. */
  dataId: DataId
  /**
   * The `DSH_HOME` value the shell observed when it last settled the location,
   * as an absolute path. Absent when none was set. A later value that differs
   * from it is a change made outside the shell.
   */
  lastSeenEnv?: string
  /** When the location last changed, as an ISO timestamp. */
  movedAt?: string
  /** The data directory's generation ({@link GENERATION_FILENAME}) when it was named; absent means 0. */
  generation?: number
}

/**
 * Outcome of reading the pointer. `corrupt` carries the backup when it is
 * readable: it names where the data was one write earlier, which may no
 * longer be where it is, so it is only ever offered to the person.
 */
export type PointerRead =
  | { kind: 'absent' }
  | { kind: 'ok'; pointer: DataLocationPointer }
  | { kind: 'corrupt'; detail: string; backup?: DataLocationPointer }

/** Outcome of reading a directory's identity marker. */
export type DataIdRead =
  | { kind: 'ok'; id: DataId }
  | { kind: 'absent' }
  | { kind: 'unreadable'; detail: string }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Entries only the Harness creates at the top of its home. Homes written
 * before this build carry no identity marker, so these entries are what
 * recognizes them ({@link looksLikeHarnessHome}, {@link hasHarnessStructure}).
 */
const HOME_STRUCTURE = ['sessions', 'profiles', 'attachments', 'storages'] as const

/**
 * Normalize a `DSH_HOME` value the way `resolveDshHome` reads it: blank is
 * unset, `~` expands against `home`, and the result is absolute.
 * @param value - the raw value, if any.
 * @param home - the operating-system home directory `~` stands for.
 * @returns the absolute path, or `undefined` for an unset or blank value.
 */
export function normalizeDshHome(value: string | undefined, home: string): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined
  if (value === '~') return resolve(home)
  if (value.startsWith('~/') || value.startsWith('~\\')) return resolve(home, value.slice(2))
  return resolve(value)
}

/**
 * Check one parsed pointer document.
 * @param value - the parsed JSON.
 * @returns the pointer, or a sentence naming the first field that is wrong.
 */
function validatePointer(value: unknown): DataLocationPointer | string {
  if (typeof value !== 'object' || value === null) return 'not a JSON object'
  const record = value as Record<string, unknown>
  if (record['version'] !== POINTER_VERSION) return `unsupported version ${JSON.stringify(record['version'])}`
  const path = record['path']
  if (typeof path !== 'string' || !isAbsolute(path)) return 'path is not an absolute path'
  const dataId = record['dataId']
  if (typeof dataId !== 'string' || !UUID_PATTERN.test(dataId)) return 'dataId is not a UUID'
  const pointer: DataLocationPointer = { version: POINTER_VERSION, path, dataId: dataId as DataId }
  const lastSeenEnv = record['lastSeenEnv']
  if (lastSeenEnv !== undefined) {
    if (typeof lastSeenEnv !== 'string' || !isAbsolute(lastSeenEnv)) return 'lastSeenEnv is not an absolute path'
    pointer.lastSeenEnv = lastSeenEnv
  }
  const movedAt = record['movedAt']
  if (movedAt !== undefined) {
    if (typeof movedAt !== 'string') return 'movedAt is not a string'
    pointer.movedAt = movedAt
  }
  const generation = record['generation']
  if (generation !== undefined) {
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) return 'generation is not a count'
    pointer.generation = generation
  }
  return pointer
}

/**
 * Parse a pointer file's text.
 * @param text - the text.
 * @returns the pointer, or `undefined` when the text is not a valid pointer.
 */
export function parsePointerText(text: string): DataLocationPointer | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // SyntaxError: text that is not JSON is not a pointer.
    return undefined
  }
  const pointer = validatePointer(parsed)
  return typeof pointer === 'string' ? undefined : pointer
}

/**
 * The text {@link writePointer} writes for a pointer.
 * @param pointer - the pointer.
 * @returns the file's text.
 */
export function pointerText(pointer: DataLocationPointer): string {
  return `${JSON.stringify(pointer, null, 2)}\n`
}

/**
 * Read and validate one pointer file.
 * @param file - the file to read.
 * @returns the pointer, `'absent'` when the file does not exist, or why it is unusable.
 */
function readPointerFile(file: string): DataLocationPointer | 'absent' | { detail: string } {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    return { detail: `cannot read ${file}: ${String(error)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { detail: `${file} is not JSON: ${String(error)}` }
  }
  const pointer = validatePointer(parsed)
  return typeof pointer === 'string' ? { detail: `${file}: ${pointer}` } : pointer
}

/**
 * Read the pointer. Only the main file decides the location. When it is
 * missing or unusable while the backup exists, the read is `corrupt`, with
 * the backup attached when it is readable; {@link writePointer} replaces the
 * main file by rename, so a backup without a usable main file means the main
 * file was damaged or removed, not that a write stopped halfway.
 * @param userData - Electron's user-data directory.
 * @returns what the pointer says, `absent` when neither file exists, or `corrupt` when the main file is not usable.
 */
export function readPointer(userData: string): PointerRead {
  const main = readPointerFile(join(userData, POINTER_FILENAME))
  if (typeof main === 'object' && !('detail' in main)) return { kind: 'ok', pointer: main }
  const backup = readPointerFile(join(userData, POINTER_BACKUP_FILENAME))
  if (main === 'absent' && backup === 'absent') return { kind: 'absent' }
  const mainDetail = main === 'absent' ? `${join(userData, POINTER_FILENAME)} is missing` : main.detail
  if (typeof backup === 'object' && !('detail' in backup)) return { kind: 'corrupt', detail: mainDetail, backup }
  const details = [mainDetail, ...typeof backup === 'object' ? [backup.detail] : []]
  return { kind: 'corrupt', detail: details.join('; ') }
}

/**
 * Replace the pointer. The pointer being replaced, when it is readable, is
 * first written to the backup, so one bad write never loses the last good one.
 * @param userData - Electron's user-data directory.
 * @param pointer - the new pointer.
 * @throws when either file cannot be written.
 */
export function writePointer(userData: string, pointer: DataLocationPointer): void {
  const main = join(userData, POINTER_FILENAME)
  const current = readPointerFile(main)
  if (typeof current === 'object' && !('detail' in current)) {
    writeDurably(join(userData, POINTER_BACKUP_FILENAME), Buffer.from(pointerText(current)))
  }
  writeDurably(main, Buffer.from(pointerText(pointer)))
}

/**
 * Read a directory's identity marker.
 * @param dir - the data directory.
 * @returns the identity, `absent` when there is no marker, or `unreadable` when it cannot be used.
 */
export function readDataId(dir: string): DataIdRead {
  let text: string
  try {
    text = readFileSync(join(dir, DATA_ID_FILENAME), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unreadable', detail: String(error) }
  }
  const id = text.trim()
  if (!UUID_PATTERN.test(id)) return { kind: 'unreadable', detail: `${DATA_ID_FILENAME} does not hold a UUID` }
  return { kind: 'ok', id: id as DataId }
}

/**
 * Give a data directory an identity when it has none. The marker is created
 * exclusively, so two processes racing here end with one identity.
 * @param dir - an existing data directory.
 * @returns the identity the directory now carries.
 * @throws when the marker exists but is unreadable, or cannot be written.
 */
export function ensureDataId(dir: string): DataId {
  const existing = readDataId(dir)
  if (existing.kind === 'ok') return existing.id
  if (existing.kind === 'unreadable') throw new Error(`${join(dir, DATA_ID_FILENAME)}: ${existing.detail}`)
  const id = randomUUID() as DataId
  try {
    const fd = openSync(join(dir, DATA_ID_FILENAME), 'wx', 0o600)
    try {
      writeSync(fd, `${id}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const raced = readDataId(dir)
    if (raced.kind !== 'ok') throw new Error(`${join(dir, DATA_ID_FILENAME)}: written concurrently and unreadable`)
    return raced.id
  }
  return id
}

/**
 * Whether `path` is a directory, following links.
 * @param path - the path to test.
 * @returns true for a directory, false when it is absent, unreachable, or anything else.
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    // ENOENT for an unplugged disk, EACCES or ENOTDIR for anything else in the
    // way: none of them is a directory this shell can use.
    return false
  }
}

/**
 * Whether a directory without an identity marker is nevertheless a Harness
 * home to adopt: it holds at least two of the top-level directories only the
 * Harness creates. A home started once and never used holds `profiles/` and
 * `storages/` but no `sessions/` yet; a single one of them is not enough.
 * @param dir - the directory to inspect.
 * @returns true when it holds that structure.
 */
export function looksLikeHarnessHome(dir: string): boolean {
  return HOME_STRUCTURE.filter(name => isDirectory(join(dir, name))).length >= 2
}

/**
 * Whether a directory holds any of the top-level directories only the Harness
 * creates. Broader than {@link looksLikeHarnessHome}: it decides what a move
 * must not take over, not what may be adopted.
 * @param dir - the directory to inspect.
 * @returns true when one of them is there.
 */
export function hasHarnessStructure(dir: string): boolean {
  return HOME_STRUCTURE.some(name => isDirectory(join(dir, name)))
}

/**
 * A data directory's generation.
 * @param dir - the directory.
 * @returns its number; 0 when the file is absent or does not hold a count, so an unreadable number never makes a folder the newest.
 */
export function readGeneration(dir: string): number {
  let text: string
  try {
    text = readFileSync(join(dir, GENERATION_FILENAME), 'utf8')
  } catch {
    // ENOENT for a folder no move has numbered; anything else cannot vouch for a number either.
    return 0
  }
  return parseGeneration(text)
}

/**
 * A generation file's number.
 * @param text - its text, or `undefined` when there is none.
 * @returns the number; 0 when absent or not a count.
 */
export function parseGeneration(text: string | undefined): number {
  const trimmed = text?.trim() ?? ''
  const value = Number(trimmed)
  return /^\d+$/.test(trimmed) && Number.isSafeInteger(value) ? value : 0
}

/**
 * Replace a data directory's generation durably.
 * @param dir - the directory.
 * @param generation - the new number.
 * @throws when it cannot be written.
 */
export function writeGeneration(dir: string, generation: number): void {
  writeDurably(join(dir, GENERATION_FILENAME), Buffer.from(`${String(generation)}\n`), 0o600)
}

/**
 * A pointer's `generation` set to a number, left out when it is 0 so a
 * pointer that never had one reads the same as before.
 * @param pointer - the pointer.
 * @param generation - the number.
 * @returns the pointer with it.
 */
export function withGeneration(pointer: DataLocationPointer, generation: number): DataLocationPointer {
  const next = { ...pointer }
  if (generation > 0) next.generation = generation
  else delete next.generation
  return next
}

/** The identity in use and the highest generation known for it. */
export interface DataReference {
  dataId: DataId
  generation: number
}

/** What {@link setAsideReason} compares a folder with. */
export interface SetAsideContext {
  /** The copies recorded as abandoned by data moves. */
  abandoned: readonly AbandonedCopy[]
  /** The identity in use and its generation, when one is known ({@link dataReference}). */
  reference: DataReference | undefined
}

/**
 * Whether a directory carries a move or retired marker.
 * @param dir - the directory.
 * @returns true when one of them is there.
 */
function hasMoveMarker(dir: string): boolean {
  return existsSync(join(dir, MOVE_STATE_FILENAME)) || existsSync(join(dir, RETIRED_FILENAME))
}

/**
 * The identity in use and the highest generation known for it: the pointer's
 * identity (or, without a pointer, the default home's), with the highest of
 * the pointer's number and the numbers in the pointer's folder and the default
 * home when they carry that identity and no move marker. The folders count
 * because a rollback puts the pointer back as it was before the move, older
 * than the original's new number, and a crash may leave the pointer one step
 * behind its folder.
 * @param read - the pointer.
 * @param defaultHome - `~/.dsh`.
 * @returns the reference, or `undefined` when no identity is known.
 */
export function dataReference(read: PointerRead, defaultHome: string): DataReference | undefined {
  const pointer = read.kind === 'ok' ? read.pointer : undefined
  const idAt = (dir: string): DataId | undefined => {
    if (!isDirectory(dir) || hasMoveMarker(dir)) return undefined
    const id = readDataId(dir)
    return id.kind === 'ok' ? id.id : undefined
  }
  const dataId = pointer?.dataId ?? idAt(defaultHome)
  if (dataId === undefined) return undefined
  let generation = pointer?.generation ?? 0
  for (const dir of [...pointer === undefined ? [] : [pointer.path], defaultHome]) {
    if (idAt(dir) === dataId) generation = Math.max(generation, readGeneration(dir))
  }
  return { dataId, generation }
}

/**
 * Why a data move set a directory aside, so it must never be used as the
 * data directory:
 *
 * - `moving`: it holds a move marker ({@link MOVE_STATE_FILENAME});
 * - `retired`: it holds a retired marker ({@link RETIRED_FILENAME});
 * - `abandoned`: it is a recorded abandoned copy, told apart from the data in
 *   use (which has the same identity) by its real path, compared as the
 *   platform compares names, so a link to the data in use at a recorded path
 *   (`~/.dsh` after a move) is not set aside;
 * - `older`: it carries the identity in use with a lower generation than the
 *   reference, wherever it is mounted now.
 * @param dir - the directory, as a pointer, `DSH_HOME`, or a pick names it.
 * @param context - the abandoned copies and the reference.
 * @returns the reason, or `undefined` when the directory may be used.
 */
export function setAsideReason(dir: string, context: SetAsideContext): SetAsideReason | undefined {
  if (!isDirectory(dir)) return undefined
  if (existsSync(join(dir, MOVE_STATE_FILENAME))) return 'moving'
  if (existsSync(join(dir, RETIRED_FILENAME))) return 'retired'
  const id = readDataId(dir)
  if (id.kind !== 'ok') return undefined
  if (context.abandoned.length > 0) {
    let real: string
    try {
      real = realpathSync.native(dir)
    } catch {
      // The directory went away between the checks: nothing is there to set aside.
      return undefined
    }
    if (context.abandoned.some(copy => copy.dataId === id.id && samePathText(copy.path, real, process.platform))) return 'abandoned'
  }
  const { reference } = context
  if (reference !== undefined && reference.dataId === id.id && readGeneration(dir) < reference.generation) return 'older'
  return undefined
}

/** Why a folder is set aside; see {@link setAsideReason}. */
export type SetAsideReason = 'moving' | 'retired' | 'abandoned' | 'older'

/**
 * Whether the person may make a set-aside folder current again: it holds the
 * data (an identity and no move marker) and is set aside only by the record
 * of abandoned copies or by its generation.
 * @param reason - why it is set aside.
 * @returns true for `abandoned` and `older`.
 */
export function canMakeCurrent(reason: SetAsideReason): boolean {
  return reason === 'abandoned' || reason === 'older'
}

/**
 * Whether a data move set a directory aside ({@link setAsideReason}).
 * @param dir - the directory.
 * @param context - the abandoned copies and the reference.
 * @returns true when the directory must not be used.
 */
export function isSetAside(dir: string, context: SetAsideContext): boolean {
  return setAsideReason(dir, context) !== undefined
}

/** Why a pointer's directory cannot be used. `set-aside`: a data move set it aside ({@link isSetAside}). */
export type UnavailableReason = 'missing' | 'id-mismatch' | 'pointer-unreadable' | 'set-aside'

/**
 * Why an explicit `DSH_HOME` that changed is not followed without asking.
 * `missing` and `not-harness-data` can be adopted as a new, empty location;
 * `not-a-folder` (a file, a dangling link, or a path that cannot be reached),
 * `damaged-data` (an identity marker that cannot be read), `set-aside` (a
 * folder a data move set aside, {@link isSetAside}), and
 * `cannot-create` cannot. {@link resolveDataLocation} never returns
 * `cannot-create`: the launch step asks with it after
 * {@link adoptEnvLocation} failed, on a volume that is not mounted or a
 * directory the person may not write, for example.
 */
export type EnvUnverifiedReason = 'missing' | 'not-harness-data' | 'not-a-folder' | 'damaged-data' | 'set-aside' | 'cannot-create'

/**
 * Whether the person may adopt an unverified `DSH_HOME` as a new location.
 * @param reason - why it was not followed.
 * @returns true when {@link adoptEnvLocation} can make it a data directory.
 */
export function canAdoptEnv(reason: EnvUnverifiedReason): boolean {
  switch (reason) {
    case 'missing':
    case 'not-harness-data':
      return true
    case 'not-a-folder':
    case 'damaged-data':
    case 'set-aside':
    case 'cannot-create':
      return false
    default:
      return reason satisfies never
  }
}

/**
 * What is at a path, following links. A path that does not resolve because it,
 * or the nearest entry above it that exists, is a dangling link is `other`,
 * not `absent`: creating a directory through a dangling link fails with
 * ENOENT, so such a path cannot become a data directory.
 * @param path - the absolute path to inspect.
 * @returns `directory`, `absent` when it can be created, or `other` for a file or a path that cannot be reached or created.
 */
function pathKind(path: string): 'directory' | 'absent' | 'other' {
  try {
    return statSync(path).isDirectory() ? 'directory' : 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'other'
  }
  for (let entry = path; ; entry = dirname(entry)) {
    try {
      lstatSync(entry)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'other'
      if (dirname(entry) === entry) return 'absent'
      continue
    }
    // The nearest entry that exists: a directory, or a link to one, can hold
    // the new directory; a dangling link cannot.
    return isDirectory(entry) ? 'absent' : 'other'
  }
}

/**
 * The decision for this launch.
 *
 * - `ready`: use `home`. `pointer` is the pointer to write before the server
 *   starts, when it changed; `adoptId` asks for an identity marker to be
 *   written into `home` first.
 * - `unavailable`: the pointer names a directory that cannot be used, or
 *   cannot be read; the person must retry, pick the folder, or quit.
 *   `suggestion` is the backup of an unreadable pointer, which the person
 *   may confirm.
 * - `confirm-env`: an explicit `DSH_HOME` changed to a directory that holds no
 *   Harness data; the person decides between it and the pointer.
 */
export type Resolution =
  | {
    kind: 'ready'
    home: string
    via: 'default' | 'env' | 'pointer' | 'followed-env'
    pointer?: DataLocationPointer
    adoptId?: boolean
  }
  | {
    kind: 'unavailable'
    reason: UnavailableReason
    pointer?: DataLocationPointer
    suggestion?: DataLocationPointer
    /** The directory that cannot be used when no pointer names it (`DSH_HOME` or `~/.dsh` set aside by a move). */
    path?: string
    /** For `set-aside`: the person may make the folder current again ({@link canMakeCurrent}). */
    escapable?: boolean
    detail?: string
  }
  | { kind: 'confirm-env'; envPath: string; pointer: DataLocationPointer; reason: EnvUnverifiedReason }

/** Inputs of {@link resolveDataLocation}. */
export interface ResolveInput {
  /** What {@link readPointer} returned. */
  read: PointerRead
  /**
   * The explicit `DSH_HOME`, normalized by {@link normalizeDshHome}. Without a
   * pointer only the process environment is consulted; with one, the caller
   * also asks the login shell or the Windows user environment.
   */
  env: string | undefined
  /** The default home, `~/.dsh`. */
  defaultHome: string
  /** The copies recorded as abandoned by data moves; see {@link isSetAside}. */
  abandoned: readonly AbandonedCopy[]
}

/**
 * Decide which directory this launch uses. Reads the directories it names;
 * writes nothing. A directory a data move set aside is never `ready`.
 * @param input - the pointer, the explicit `DSH_HOME`, and the default home.
 * @returns the decision.
 */
export function resolveDataLocation(input: ResolveInput): Resolution {
  const { read, env, defaultHome, abandoned } = input
  const context: SetAsideContext = { abandoned, reference: dataReference(read, defaultHome) }
  if (read.kind === 'absent') {
    const home = env ?? defaultHome
    const why = setAsideReason(home, context)
    if (why !== undefined) return { kind: 'unavailable', reason: 'set-aside', path: home, escapable: canMakeCurrent(why) }
    return env === undefined ? { kind: 'ready', home: defaultHome, via: 'default' } : { kind: 'ready', home: env, via: 'env' }
  }
  if (read.kind === 'corrupt') {
    return read.backup === undefined
      ? { kind: 'unavailable', reason: 'pointer-unreadable', detail: read.detail }
      : { kind: 'unavailable', reason: 'pointer-unreadable', suggestion: read.backup, detail: read.detail }
  }
  const pointer = read.pointer
  if (env !== undefined && env !== pointer.lastSeenEnv) {
    const seen: DataLocationPointer = { ...pointer, lastSeenEnv: env }
    if (env === pointer.path) return verifyPointer(seen, true, context)
    const kind = pathKind(env)
    if (kind === 'absent') return { kind: 'confirm-env', envPath: env, pointer, reason: 'missing' }
    if (kind === 'other') return { kind: 'confirm-env', envPath: env, pointer, reason: 'not-a-folder' }
    // Before the identity: an abandoned copy carries this data's identity.
    if (isSetAside(env, context)) return { kind: 'confirm-env', envPath: env, pointer, reason: 'set-aside' }
    // The pointer now names another folder: its number is that folder's.
    const followed: DataLocationPointer = withGeneration({ ...seen, path: env, movedAt: new Date().toISOString() }, readGeneration(env))
    const id = readDataId(env)
    if (id.kind === 'ok') return { kind: 'ready', home: env, via: 'followed-env', pointer: { ...followed, dataId: id.id } }
    if (id.kind === 'unreadable') return { kind: 'confirm-env', envPath: env, pointer, reason: 'damaged-data' }
    if (looksLikeHarnessHome(env)) return { kind: 'ready', home: env, via: 'followed-env', pointer: followed, adoptId: true }
    return { kind: 'confirm-env', envPath: env, pointer, reason: 'not-harness-data' }
  }
  return verifyPointer(pointer, false, context)
}

/**
 * Check that the pointer's directory is there, was not set aside by a data
 * move, and carries its identity.
 * @param pointer - the pointer to verify.
 * @param changed - whether the pointer must be written back when it verifies.
 * @param context - the abandoned copies and the reference.
 * @returns `ready` at the pointer's path, or why it is unavailable.
 */
function verifyPointer(pointer: DataLocationPointer, changed: boolean, context: SetAsideContext): Resolution {
  if (!isDirectory(pointer.path)) return { kind: 'unavailable', reason: 'missing', pointer }
  const why = setAsideReason(pointer.path, context)
  if (why !== undefined) return { kind: 'unavailable', reason: 'set-aside', pointer, escapable: canMakeCurrent(why) }
  const id = readDataId(pointer.path)
  if (id.kind !== 'ok' || id.id !== pointer.dataId) return { kind: 'unavailable', reason: 'id-mismatch', pointer }
  return changed ? { kind: 'ready', home: pointer.path, via: 'pointer', pointer } : { kind: 'ready', home: pointer.path, via: 'pointer' }
}

/**
 * Carry out what a `ready` decision asks for: the identity marker first, then
 * the pointer that names it. Without a pointer the default or environment home
 * still gets a marker when it exists, so a later move can recognize it.
 * @param userData - Electron's user-data directory.
 * @param resolution - a `ready` decision.
 * @returns the pointer now on disk, if any.
 * @throws when the marker or the pointer cannot be written.
 */
export function commitReady(
  userData: string,
  resolution: Extract<Resolution, { kind: 'ready' }>,
): DataLocationPointer | undefined {
  if (resolution.pointer === undefined) {
    if (isDirectory(resolution.home)) ensureDataId(resolution.home)
    return undefined
  }
  const pointer = resolution.adoptId === true ? { ...resolution.pointer, dataId: ensureDataId(resolution.home) } : resolution.pointer
  writePointer(userData, pointer)
  return pointer
}

/** Outcome of checking a folder the person picked as their data. */
export type ChosenFolder =
  | { kind: 'accepted'; pointer: DataLocationPointer }
  | { kind: 'rejected'; reason: 'no-data' | 'other-data' | 'set-aside' }

/**
 * Check a folder the person picked while the pointer's directory was
 * unavailable. With a readable pointer the folder must carry the pointer's
 * identity; with an unreadable one any identity marker is accepted, since
 * there is nothing left to compare it with. A folder a data move set aside is
 * refused whatever it carries.
 * @param chosen - the absolute folder path.
 * @param pointer - the pointer that could not be used, or `undefined` when it was unreadable.
 * @param env - the explicit `DSH_HOME` observed this launch, recorded as seen.
 * @param context - the abandoned copies and the reference.
 * @returns the pointer to write, or why the folder is refused.
 */
export function checkChosenFolder(
  chosen: string,
  pointer: DataLocationPointer | undefined,
  env: string | undefined,
  context: SetAsideContext,
): ChosenFolder {
  if (isSetAside(chosen, context)) return { kind: 'rejected', reason: 'set-aside' }
  const id = readDataId(chosen)
  if (id.kind !== 'ok') return { kind: 'rejected', reason: 'no-data' }
  if (pointer !== undefined && id.id !== pointer.dataId) return { kind: 'rejected', reason: 'other-data' }
  const next: DataLocationPointer = {
    version: POINTER_VERSION,
    path: resolve(chosen),
    dataId: id.id,
    movedAt: new Date().toISOString(),
  }
  const lastSeenEnv = env ?? pointer?.lastSeenEnv
  if (lastSeenEnv !== undefined) next.lastSeenEnv = lastSeenEnv
  return { kind: 'accepted', pointer: withGeneration(next, readGeneration(chosen)) }
}

/**
 * The pointer after the person chose to use an explicit `DSH_HOME` that holds
 * no Harness data yet: the directory is created when missing and given a new
 * identity.
 * @param envPath - the `DSH_HOME` directory.
 * @param pointer - the pointer it replaces.
 * @returns the pointer to write.
 * @throws when the directory or its marker cannot be created.
 */
export function adoptEnvLocation(envPath: string, pointer: DataLocationPointer): DataLocationPointer {
  mkdirSync(envPath, { recursive: true, mode: 0o700 })
  return withGeneration({
    ...pointer,
    path: envPath,
    dataId: ensureDataId(envPath),
    lastSeenEnv: envPath,
    movedAt: new Date().toISOString(),
  }, readGeneration(envPath))
}

/**
 * The pointer after the person chose to keep it over an explicit `DSH_HOME`
 * that changed. The declined value is recorded as seen, so the same value does
 * not ask again on the next launch.
 * @param envPath - the declined `DSH_HOME` directory.
 * @param pointer - the pointer being kept.
 * @returns the pointer to write.
 */
export function keepPointerOverEnv(envPath: string, pointer: DataLocationPointer): DataLocationPointer {
  return { ...pointer, lastSeenEnv: envPath }
}
