/**
 * How much of the desktop log directory each launch keeps: `dsh-server.log`
 * rolls over to one `dsh-server.log.1` once it passes [[LOG_ROTATE_BYTES]],
 * and only the newest [[KEPT_REPORTS]] Node diagnostic reports stay. Both run
 * once per launch, before the shell opens the log file, so nothing is writing
 * to either while it runs.
 *
 * The two numbers are this product's retention policy rather than a
 * deployment choice: the log directory is the shell's own, and the one
 * reader is the developer a user sends the file to. 10 MiB holds many
 * launches of ordinary output — the log now also carries every plugin's
 * logger records — and two generations cap the file at about 20 MiB. Each
 * report is one fatal error, and the newest five cover a crash loop's
 * pattern without letting a loop fill the disk.
 * @module @deepseek-ai/dsh-desktop-shell/log-retention
 */

import { readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Size past which a launch rolls `dsh-server.log` over to `dsh-server.log.1`. */
export const LOG_ROTATE_BYTES = 10 * 1024 * 1024

/** How many Node diagnostic reports a launch leaves in the log directory. */
export const KEPT_REPORTS = 5

/** The name Node gives a diagnostic report: `report.<date>.<time>.<pid>.<thread>.<sequence>.json`. */
const REPORT_NAME = /^report\.[\d.]+\.json$/

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
