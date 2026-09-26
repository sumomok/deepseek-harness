/**
 * Replacing a small file so that a crash leaves either the old content or the
 * new, never a mix: the content goes to a flushed temporary sibling, which is
 * renamed over the destination, and the directory holding both is flushed so
 * the rename itself reaches the disk.
 *
 * A crash before the rename leaves the temporary sibling,
 * `<file>.<pid>.tmp`, beside the destination; nothing removes it later.
 * @module @deepseek-ai/dsh-desktop-shell/durable-file
 */

import { closeSync, copyFileSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Replace `file` with `content` through a flushed temporary sibling.
 * @param file - the destination.
 * @param content - the full new content.
 * @param mode - permission bits of a newly created file; the process default when absent.
 * @throws when the temporary file cannot be written or renamed.
 */
export function writeDurably(file: string, content: Buffer, mode?: number): void {
  const temporary = temporaryFor(file)
  const fd = openSync(temporary, 'w', mode)
  try {
    writeSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameOver(temporary, file)
}

/**
 * Copy `source` to `file` byte for byte, permission bits included, through a
 * flushed temporary sibling.
 * @param source - the file to copy.
 * @param file - the destination.
 * @throws when the copy or the rename fails.
 */
export function copyDurably(source: string, file: string): void {
  const temporary = temporaryFor(file)
  copyFileSync(source, temporary)
  const fd = openSync(temporary, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameOver(temporary, file)
}

/**
 * The temporary sibling a write to `file` goes through.
 * @param file - the destination.
 * @returns `<file>.<pid>.tmp`.
 */
function temporaryFor(file: string): string {
  return `${file}.${String(process.pid)}.tmp`
}

/**
 * Rename a temporary file over its destination and flush the directory,
 * removing the temporary file when the rename fails.
 * @param temporary - the temporary file.
 * @param file - the destination.
 */
function renameOver(temporary: string, file: string): void {
  try {
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  fsyncDirectory(dirname(file))
}

/** Codes a file system returns when it does not flush directories; the rename then stands as the system left it. */
const DIRECTORY_FSYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EBADF'])

/**
 * Flush a directory's entries to disk. Windows cannot open a directory for
 * `fsync`, and NTFS commits a rename through its journal, so it is skipped
 * there.
 * @param dir - the directory.
 * @throws when the directory cannot be opened, or the flush fails for a reason other than being unsupported.
 */
function fsyncDirectory(dir: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } catch (error) {
    // A file system without directory fsync (some network and FUSE mounts)
    // answers with one of these; the rename has already succeeded.
    if (!DIRECTORY_FSYNC_UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? '')) throw error
  } finally {
    closeSync(fd)
  }
}
