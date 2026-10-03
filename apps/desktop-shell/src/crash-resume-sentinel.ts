/**
 * The intentional-stop sentinel of the crash-resume server plugin
 * (`@haoran/dsh-crash-resume`), written by the shell before it stops the
 * server on purpose.
 *
 * The plugin continues a turn that a server crash cut short, and holds one that
 * a stop request cut short. The session log alone cannot tell the two apart,
 * so the plugin looks for `<Harness home>/crash-resume/intentional-stop.json`
 * when the next server starts, and reads and deletes it there. On Windows the
 * shell stops the server with `taskkill /T /F`, so no code in the server runs
 * and only the shell can write the file. On macOS and Linux the server
 * receives SIGTERM and the plugin writes the same file itself; both writers
 * produce one line of JSON with the same fields, each through its own
 * temporary file and an atomic rename, so the file holds one complete copy
 * whichever of them renames last.
 *
 * The shell writes it before a quit's stop, before an update install's stop,
 * before a data move's stops (the one before a move asked for in Settings
 * takes the data, and the one after a moved location fails its health
 * check), before the stop that a mandatory update forces at launch, and when
 * the system announces a shutdown, restart, or log-off, which ends the server
 * without a quit on Windows. It writes it only while the server's child is
 * running. It does not write it for a server that exited on its own, for a
 * later quit of that crashed server, for a relaunch after repeated crashes,
 * for a start that timed out, or for the orphan sweep: those leave turns the
 * plugin is meant to continue, or no turn at all.
 * @module @deepseek-ai/dsh-desktop-shell/crash-resume-sentinel
 */

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'

/** The plugin's state directory under the Harness home, when its `stateDir` is not configured. */
export const SENTINEL_DIRECTORY = 'crash-resume'

/** The sentinel's file name inside {@link SENTINEL_DIRECTORY}. */
export const SENTINEL_FILE = 'intentional-stop.json'

/**
 * Why the shell stopped the server; recorded for diagnosis only, the plugin
 * never reads it. `quit` covers an ordinary quit, the stop before an update
 * installs, and a data move's stops, `update` the stop a mandatory update
 * forces at launch, and `shutdown` a system shutdown, restart, or log-off.
 */
export type IntentionalStopReason = 'quit' | 'update' | 'shutdown'

/**
 * The sentinel's text: one JSON object and a newline, with the fields in the
 * order the plugin's `formatSentinel` writes them.
 * @param reason - why the server is being stopped.
 * @param at - epoch milliseconds of the write.
 * @returns the file content.
 */
export function formatIntentionalStop(reason: IntentionalStopReason, at: number): string {
  return `${JSON.stringify({ version: 1, at, by: 'shell', reason })}\n`
}

/**
 * Write the sentinel into `home` synchronously, so it is on disk before the
 * caller starts stopping the server: write a temporary file in the same
 * directory, fsync it, rename it over the sentinel, then fsync the directory
 * where the platform allows it. A failure is logged and swallowed, because a
 * quit must never wait on it; the only cost is that the next start may
 * continue a turn once.
 * @param home - the Harness home the server runs against.
 * @param reason - why the server is being stopped.
 * @param log - receives one line when the write fails.
 */
export function writeIntentionalStop(home: string, reason: IntentionalStopReason, log: (line: string) => void): void {
  try {
    const directory = join(home, SENTINEL_DIRECTORY)
    const target = join(directory, SENTINEL_FILE)
    const at = Date.now()
    mkdirSync(directory, { recursive: true })
    const temporary = `${target}.${String(process.pid)}.${String(at)}.tmp`
    const fd = openSync(temporary, 'w')
    try {
      writeSync(fd, formatIntentionalStop(reason, at))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      renameSync(temporary, target)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
    fsyncDirectory(directory)
  } catch (error) {
    log(`[desktop] crash-resume sentinel: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

/**
 * Flush a directory entry change to disk. Windows cannot open a directory for
 * fsync, and NTFS journals the rename itself.
 * @param directory - the directory that received the rename.
 */
function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(directory, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
