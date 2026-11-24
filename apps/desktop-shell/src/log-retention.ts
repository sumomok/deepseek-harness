/**
 * How much of the desktop diagnostic directories each launch keeps:
 * `dsh-server.log` rolls over to one `dsh-server.log.1` once it passes
 * [[LOG_ROTATE_BYTES]], only the newest [[KEPT_REPORTS]] Node diagnostic
 * reports stay in the log directory, and only the newest [[KEPT_CRASH_DUMPS]]
 * Electron Crashpad minidumps stay in the crash-dumps directory. Each runs
 * once per launch, before the shell opens the log file or starts Crashpad, so
 * nothing is writing to them while they run.
 *
 * These numbers are this product's retention policy rather than a deployment
 * choice: the log and crash-dump directories belong to the shell, and the one
 * reader is the developer a user sends diagnostics to. 10 MiB holds many
 * launches of ordinary output — the log now also carries every plugin's
 * logger records — and two generations cap the file at about 20 MiB. Each
 * diagnostic report or minidump is one fatal error, and the newest five cover
 * a crash loop's pattern without letting a loop fill the disk.
 * @module @deepseek-ai/dsh-desktop-shell/log-retention
 */

import { readdirSync, renameSync, rmSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

/** Size past which a launch rolls `dsh-server.log` over to `dsh-server.log.1`. */
export const LOG_ROTATE_BYTES = 10 * 1024 * 1024

/** How many Node diagnostic reports a launch leaves in the log directory. */
export const KEPT_REPORTS = 5

/** How many Electron Crashpad minidumps (`.dmp`) a launch leaves in the crash-dumps directory. */
export const KEPT_CRASH_DUMPS = 5

/** The name Node gives a diagnostic report: `report.<date>.<time>.<pid>.<thread>.<sequence>.json`. */
const REPORT_NAME = /^report\.[\d.]+\.json$/

/** Crashpad minidump file extension. */
const CRASH_DUMP_NAME = /\.dmp$/i

/**
 * Roll the log file over to `<file>.1`, replacing an older one, when it is
 * larger than `maxBytes`.
 * @param file - the log file.
 * @param maxBytes - the size past which it rolls over.
 * @returns one line for the log saying what happened, or undefined when the file was left as it was.
 */
export function rotateLog(file: string, maxBytes: number): string | undefined {
  let size: number
  try {
    size = statSync(file).size
  } catch {
    // ENOENT: the first launch, or a log a user deleted; there is nothing to roll over.
    return undefined
  }
  if (size <= maxBytes) return undefined
  try {
    renameSync(file, `${file}.1`)
  } catch (error) {
    return `[desktop] could not roll ${file} over (${String(size)} bytes): ${String(error)}\n`
  }
  return `[desktop] rolled the previous log over to ${file}.1 (${String(size)} bytes)\n`
}

/**
 * Delete every diagnostic report in `dir` except the newest `keep`, newest
 * by modification time and then by name.
 * @param dir - the log directory the reports are written to.
 * @param keep - how many to leave.
 * @returns one line for the log naming what was removed or could not be, or undefined when nothing was.
 */
export function pruneReports(dir: string, keep: number): string | undefined {
  let names: string[]
  try {
    names = readdirSync(dir).filter(name => REPORT_NAME.test(name))
  } catch {
    // ENOENT: the log directory does not exist yet, so it holds no report.
    return undefined
  }
  const dated = names.map((name) => {
    try {
      return { name, mtimeMs: statSync(join(dir, name)).mtimeMs }
    } catch {
      // ENOENT: removed since the listing; it sorts oldest and is removed again harmlessly.
      return { name, mtimeMs: 0 }
    }
  })
  dated.sort((left, right) => right.mtimeMs - left.mtimeMs || (left.name < right.name ? 1 : -1))
  const removed: string[] = []
  const failed: string[] = []
  for (const { name } of dated.slice(keep)) {
    try {
      rmSync(join(dir, name), { force: true })
    } catch {
      // EPERM/EBUSY: another process holds the report open. It is named in
      // the returned line and removed by a later launch.
      failed.push(name)
      continue
    }
    removed.push(name)
  }
  if (removed.length === 0 && failed.length === 0) return undefined
  const kept = failed.length === 0 ? '' : `; could not remove ${failed.join(', ')}`
  return `[desktop] removed ${String(removed.length)} old diagnostic report(s), keeping the newest ${String(keep)}${kept}\n`
}

/**
 * Delete every regular `.dmp` crash dump in `dir` and its immediate
 * non-symlink subdirectories except the newest `keep`, ordered globally by
 * modification time descending and then relative path descending.
 *
 * Symlinks, deeper trees (such as Crashpad's `attachments/<uuid>/`), and
 * Crashpad metadata files (`settings.dat`, `metadata`, etc.) are left untouched.
 * @param dir - the Electron `crashDumps` directory.
 * @param keep - how many newest `.dmp` files to keep.
 * @returns one line for the log naming what was removed or could not be, or undefined when nothing was.
 */
export function pruneCrashDumps(dir: string, keep: number): string | undefined {
  let top: Dirent[]
  try {
    top = readdirSync(dir, { withFileTypes: true })
  } catch {
    // ENOENT: the crash dumps directory does not exist yet, so it holds no dump.
    return undefined
  }
  const candidates: { rel: string; path: string }[] = []
  for (const entry of top) {
    if (entry.isSymbolicLink()) continue
    const entryPath = join(dir, entry.name)
    if (entry.isFile()) {
      if (CRASH_DUMP_NAME.test(entry.name)) candidates.push({ rel: entry.name, path: entryPath })
    } else if (entry.isDirectory()) {
      let children: Dirent[]
      try {
        children = readdirSync(entryPath, { withFileTypes: true })
      } catch {
        // Subdirectory disappeared or cannot be read; leave it alone and keep scanning siblings.
        continue
      }
      for (const child of children) {
        if (child.isSymbolicLink() || !child.isFile()) continue
        if (CRASH_DUMP_NAME.test(child.name)) {
          candidates.push({ rel: `${entry.name}/${child.name}`, path: join(entryPath, child.name) })
        }
      }
    }
  }
  const dated = candidates.map((entry) => {
    try {
      return { ...entry, mtimeMs: statSync(entry.path).mtimeMs }
    } catch {
      // ENOENT: removed since the listing; it sorts oldest and is removed again harmlessly.
      return { ...entry, mtimeMs: 0 }
    }
  })
  dated.sort((left, right) => right.mtimeMs - left.mtimeMs || (left.rel < right.rel ? 1 : left.rel > right.rel ? -1 : 0))
  const removed: string[] = []
  const failed: string[] = []
  for (const entry of dated.slice(keep)) {
    try {
      rmSync(entry.path, { force: true })
    } catch {
      // EPERM/EBUSY: another process holds the dump open. It is named in the
      // returned line and removed by a later launch.
      failed.push(entry.rel)
      continue
    }
    removed.push(entry.rel)
  }
  if (removed.length === 0 && failed.length === 0) return undefined
  const kept = failed.length === 0 ? '' : `; could not remove ${failed.join(', ')}`
  return `[desktop] removed ${String(removed.length)} old crash dump(s), keeping the newest ${String(keep)}${kept}\n`
}
