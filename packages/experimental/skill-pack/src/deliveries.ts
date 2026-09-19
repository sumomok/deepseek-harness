/**
 * The delivery directory: which archive it names, and what installing that
 * archive did.
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
 * changed writes nothing and reports nothing.
 * @module @deepseek-ai/dsh-experimental-skill-pack/src/deliveries
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { PACK_ARCHIVE_EXTENSION } from './archive.ts'
import { syncPackRoot } from './install.ts'
import type { PackArchiveLimits } from './types.ts'

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
 * @param root - absolute path of the pack root this deployment offers from.
 * @param delivery - the directory to read, and the limits one archive there is read under.
 * @param report - told what was installed and what was refused; nothing is reported when the
 *   directory names no delivery, or names one this root already holds.
 * @returns whether the pack root changed, which is when a reader of it has to be told.
 */
export async function installDelivery(
  root: string,
  delivery: DeliveryDirectory,
  report: DeliveryReport,
): Promise<boolean> {
  const names = await listArchives(delivery.directory)
  const [name] = names
  if (name === undefined) return false
  if (names.length > 1) {
    report('error', `skill-pack: the delivery directory holds ${String(names.length)} archives `
      + `(${names.join(', ')}); it names one delivery at a time`)
    return false
  }
  const path = join(delivery.directory, name)
  try {
    // The size is read before the file is, so an archive over the limit is
    // refused without this deployment holding its bytes.
    const { size } = await stat(path)
    if (size > delivery.limits.maxArchiveBytes) {
      report('error', `skill-pack: refused ${name} — is ${String(size)} bytes, `
        + `over the ${String(delivery.limits.maxArchiveBytes)} it is read under`)
      return false
    }
    const result = await syncPackRoot(root, {
      kind: 'archive',
      name,
      bytes: await readFile(path),
      limits: delivery.limits,
    })
    if (!result.changed) return false
    report('info', `skill-pack: installed ${result.set.id} ${result.set.version} from ${name}: `
      + `packs [${result.packs.join(', ')}], retired [${result.retired.join(', ')}]`)
    return true
  } catch (error) {
    report('error', `skill-pack: ${name} was not installed: ${String(error)}`)
    return false
  }
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
