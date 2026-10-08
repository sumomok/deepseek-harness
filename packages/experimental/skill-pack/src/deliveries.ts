/**
 * The delivery directory: which archive it names, what installing that
 * archive did, and which of those reads the status route reports.
 *
 * The directory is the delivery. Exactly one archive in it is the set this
 * deployment holds; none is a deployment nobody has delivered to; more than
 * one is refused rather than resolved, because which archive a deployment held
 * would otherwise depend on the order a directory happens to list. A name that
 * does not end in the archive suffix is not a delivery at all, so a copy
 * tool's temporary file and an operator's note can sit beside one.
 *
 * Nothing here writes into the delivery directory. The directory belongs to
 * whoever copies into it, and a deployment that consumed or renamed the file
 * it was handed would be answering a question only that operator can.
 *
 * Installing is idempotent, so reading the same directory again after nothing
 * changed writes nothing and logs nothing; the read answers `unchanged`.
 * @module @deepseek-ai/dsh-experimental-skill-pack/src/deliveries
 */

import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { PACK_ARCHIVE_EXTENSION, readPackArchive } from './archive.ts'
import { syncPackRoot, type VerifyStagedPacks } from './install.ts'
import type { DeliveryRecord, PackArchiveLimits, PackSetIdentity } from './types.ts'

/** Where a deployment's delivery archives are dropped, and the limits one is read under. */
export interface DeliveryDirectory {
  /** Absolute path of the directory a delivery archive is copied into. */
  readonly directory: string
  /** The sizes and count one archive there is read under. */
  readonly limits: PackArchiveLimits
}

/**
 * How a delivery read tells a deployment what it found.
 * @param level - `info` for what was installed, `error` for what was refused.
 * @param text - the whole line, naming the archive it is about.
 */
export type DeliveryReport = (level: 'info' | 'error', text: string) => void

/**
 * Make the pack root equal to the one archive the delivery directory names.
 *
 * The archive is read and verified against its own manifest before the pack
 * root is compared with it, so a refusal after that point still names the set
 * the archive states.
 * @param root - absolute path of the pack root this deployment offers from.
 * @param delivery - the directory to read, and the limits one archive there is read under.
 * @param report - told what was installed and what was refused, with each line as it is; nothing is
 *   reported when the directory names no delivery, or names one this root already holds.
 * @param verify - how the delivered views are judged against a composed surface; absent where the caller composes none.
 * @returns what this read did with the archive it found, or `undefined` when the directory names no
 *   delivery; the pack root changed exactly when the result is `installed`.
 */
export async function installDelivery(
  root: string,
  delivery: DeliveryDirectory,
  report: DeliveryReport,
  verify?: VerifyStagedPacks,
): Promise<DeliveryRecord | undefined> {
  const names = await listArchives(delivery.directory)
  const [name] = names
  if (name === undefined) return undefined
  const refused = (set: PackSetIdentity | undefined, line: string): Promise<DeliveryRecord> =>
    recordRefusal(report, { root, directory: delivery.directory }, names, set, line)
  if (names.length > 1) {
    return refused(undefined, `skill-pack: the delivery directory holds ${String(names.length)} archives `
      + `(${names.join(', ')}); it names one delivery at a time`)
  }
  const path = join(delivery.directory, name)
  let set: PackSetIdentity | undefined
  try {
    // The size is read before the file is, so an archive over the limit is
    // refused without this deployment holding its bytes.
    const { size } = await stat(path)
    if (size > delivery.limits.maxArchiveBytes) {
      return await refused(undefined, `skill-pack: refused ${name} — is ${String(size)} bytes, `
        + `over the ${String(delivery.limits.maxArchiveBytes)} it is read under`)
    }
    const archive = readPackArchive(name, await readFile(path), delivery.limits)
    set = archive.set
    const result = await syncPackRoot(root, { kind: 'packs', packs: archive.packs }, verify)
    if (!result.changed) return { result: 'unchanged', archives: [name], set, at: new Date().toISOString() }
    report('info', `skill-pack: installed ${set.id} ${set.version} from ${name}: `
      + `packs [${result.packs.join(', ')}], retired [${result.retired.join(', ')}]`)
    return { result: 'installed', archives: [name], set, at: new Date().toISOString() }
  } catch (error) {
    return refused(set, `skill-pack: ${name} was not installed: ${String(error)}`)
  }
}

/** The two directories a refusal record names by placeholder instead of by path. */
interface HiddenDirectories {
  /** Absolute path of the pack root, written `<pack root>`. */
  readonly root: string
  /** Absolute path of the delivery directory, written `<delivery directory>`. */
  readonly directory: string
}

/** One way a file-system error can spell a hidden directory, and what the record writes in its place. */
interface Spelling {
  /** The directory's absolute path, as configured or as its real path. */
  readonly path: string
  /** What the record writes where a path begins with this one. */
  readonly placeholder: string
}

/**
 * A letter, a digit, one of `_.~-`, or a path separator: a character a path
 * continues through, so a spelling right after one is the tail of a longer
 * name rather than the start of a path.
 */
const PATH_CHARACTER = /[\p{L}\p{N}_.~/\\-]/u

/**
 * Report one refusal's line as it is, and record it with the pack root and
 * the delivery directory hidden.
 * @param report - where the line is reported, at error level.
 * @param hidden - the directories the record names by placeholder.
 * @param archives - every archive the directory held.
 * @param set - the set the archive states, once it verified against its manifest.
 * @param line - the whole line.
 * @returns the refusal record.
 */
async function recordRefusal(
  report: DeliveryReport,
  hidden: HiddenDirectories,
  archives: readonly string[],
  set: PackSetIdentity | undefined,
  line: string,
): Promise<DeliveryRecord> {
  report('error', line)
  const reason = await hideDirectories(line, hidden)
  return { result: 'refused', archives, ...set === undefined ? {} : { set }, reason, at: new Date().toISOString() }
}

/**
 * One line with every path that begins with the pack root, a directory above
 * it, or the delivery directory written from its placeholder on.
 *
 * Installing creates whichever directories above the pack root are missing,
 * so a failure there names one of them; nothing creates or reads a directory
 * above the delivery directory, so those are left as they are.
 * @param line - the line as the process log carries it.
 * @param hidden - the directories to replace.
 * @returns the line with each path that begins with one of those directories written from its placeholder on.
 */
async function hideDirectories(line: string, hidden: HiddenDirectories): Promise<string> {
  const spellings = (await Promise.all([
    spellingsOf(hidden.root, '<pack root>'),
    ...ancestorsOf(hidden.root).map(({ path, placeholder }) => spellingsOf(path, placeholder)),
    spellingsOf(hidden.directory, '<delivery directory>'),
  ])).flat()
  return writePlaceholders(line, spellings.sort((left, right) => right.path.length - left.path.length))
}

/**
 * Every directory above the pack root short of the file-system root, which
 * every absolute path begins with and no install creates.
 * @param root - the pack root's absolute path as configured.
 * @returns its parent as `<pack root>/..`, that directory's parent as `<pack root>/../..`, and so on,
 *   with the host's path separator.
 */
function ancestorsOf(root: string): Spelling[] {
  const ancestors: Spelling[] = []
  let placeholder = '<pack root>'
  for (let path = dirname(root); dirname(path) !== path; path = dirname(path)) {
    placeholder += `${sep}..`
    ancestors.push({ path, placeholder })
  }
  return ancestors
}

/**
 * The paths one directory can be named by in a file-system error.
 * @param path - the directory's absolute path as configured.
 * @param placeholder - what the record writes in its place.
 * @returns the configured path, and its real path where it resolves.
 */
async function spellingsOf(path: string, placeholder: string): Promise<Spelling[]> {
  let real: string
  try {
    real = await realpath(path)
  } catch (_unresolved) {
    // A pack root not yet installed, a directory above it not yet created,
    // or a directory removed since it was listed has no real path, so no
    // error names one.
    return [{ path, placeholder }]
  }
  return [{ path, placeholder }, { path: real, placeholder }]
}

/**
 * Write each spelling's placeholder in one pass over the line, wherever a
 * path begins with that spelling.
 *
 * Where several spellings begin at one place the first, which is the longest,
 * is written, so a path that begins with another one's spelling is named by
 * its own. A place right after a character a path continues through is inside
 * a longer name, such as a pack-relative path naming a directory the way a
 * directory above the pack root is named, and keeps its text.
 * @param line - the line as the process log carries it.
 * @param spellings - every spelling to hide, longest first.
 * @returns the line with each of those paths written from its placeholder on.
 */
function writePlaceholders(line: string, spellings: readonly Spelling[]): string {
  let written = ''
  let from = 0
  let at = 0
  while (at < line.length) {
    const spelling = PATH_CHARACTER.test(line.charAt(at - 1)) ? undefined : spellings.find(({ path }) => line.startsWith(path, at))
    if (spelling === undefined) {
      at += 1
    } else {
      written += line.slice(from, at) + spelling.placeholder
      at += spelling.path.length
      from = at
    }
  }
  return written + line.slice(from)
}

/**
 * The record the status route keeps once one more read has finished.
 *
 * Every event in the delivery directory reads it again, a note or a hidden
 * file written beside the archive among them. A read that finds no archive
 * keeps the record. An `unchanged` read of the archive the kept record
 * installed or found unchanged, under the same name and the same set, is that
 * delivery read again and keeps the record too, so the read that follows an
 * install does not report the install as unchanged. Every other read replaces
 * it.
 * @param kept - the record kept so far, absent before the first read that found an archive.
 * @param read - what the read that just finished did, absent when it found no archive.
 * @returns the record to keep.
 */
export function keepDelivery(kept: DeliveryRecord | undefined, read: DeliveryRecord | undefined): DeliveryRecord | undefined {
  if (read === undefined) return kept
  if (read.result !== 'unchanged' || kept === undefined || kept.result === 'refused') return read
  const same = kept.archives[0] === read.archives[0] && kept.set.id === read.set.id && kept.set.version === read.set.version
  return same ? kept : read
}

/** Every archive the delivery directory holds, in name order. */
async function listArchives(directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    // Swallowed here and nowhere else: a delivery directory that does not
    // exist yet is a deployment nobody has delivered to, which is a state.
    return []
  }
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith(PACK_ARCHIVE_EXTENSION) && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort()
}
