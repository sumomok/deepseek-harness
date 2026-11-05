/**
 * Safe binary file write with symlink containment and TOCTOU mitigation.
 * `writeBinarySafe` writes binary data only inside an allowed root directory,
 * refuses to follow dangling or escaped symlinks, and mitigates TOCTOU by
 * writing to a temporary file in the same directory and renaming it atomically.
 * Designed for screenshot restore and artifact output where following symlinks
 * could write outside workspace boundaries.
 * @module @deepseek-ai/dsh-safe-binary-write
 */

import { randomBytes } from 'node:crypto'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve as resolvePath, sep } from 'node:path'

/**
 * Error thrown when a path violates symlink containment rules.
 * Either the target itself is a dangling symlink, an existing symlink
 * pointing outside the allowed root, or a parent directory was replaced
 * with a symlink during the write operation.
 */
export class SymlinkContainmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SymlinkContainmentError'
  }
}

/**
 * Normalize and resolve a path to its canonical absolute form.
 * Unlike fs.realpath, this does not follow symlinks.
 */
function normalizeAbsolute(path: string): string {
  return resolvePath(path)
}

/**
 * Check if a path is lexically contained within a root directory.
 * Both paths must be absolute. This is a fast lexical check.
 */
function isLexicallyUnder(path: string, root: string): boolean {
  // Ensure both paths are absolute and normalized
  const normalizedPath = normalizeAbsolute(path)
  const normalizedRoot = normalizeAbsolute(root)

  // Ensure root ends with separator for proper prefix matching
  const rootWithSep = normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep

  // Check if path starts with root, or if path equals root
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(rootWithSep)
}

/**
 * Verify that a path and all its parent directories do not contain symlinks
 * that escape the allowed root. This checks each component up to the root.
 * @param path - The path to check (must be absolute)
 * @param allowedRoot - The root directory path must stay under (must be absolute)
 * @throws {SymlinkContainmentError} if path or any parent symlinks outside root
 */
async function verifyNoEscapingSymlinks(path: string, allowedRoot: string): Promise<void> {
  let current = normalizeAbsolute(path)
  const root = normalizeAbsolute(allowedRoot)

  // Check each component from the target up to the root
  while (isLexicallyUnder(current, root)) {
    try {
      const stats = await lstat(current)

      if (stats.isSymbolicLink()) {
        // On Windows, lstat cannot read symlink targets, so we reject all symlinks
        // On Unix, we could use readlink to verify the target, but for consistency
        // and safety, we reject all symlinks in the path
        throw new SymlinkContainmentError(
          `Path contains symlink at ${current} which could escape the allowed root`,
        )
      }
    } catch (error) {
      // ENOENT is acceptable for the target itself or intermediate directories
      // that will be created. Other errors should propagate.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }

    // Move up to parent directory
    const parent = dirname(current)
    if (parent === current) break // Reached filesystem root
    current = parent
  }

  // If we exited the loop without reaching root containment boundary,
  // the path is outside the allowed root
  if (!isLexicallyUnder(path, root)) {
    throw new SymlinkContainmentError(
      `Path ${path} is outside allowed root ${root}`,
    )
  }
}

/**
 * Options for {@link writeBinarySafe}.
 */
export interface WriteBinarySafeOptions {
  /**
   * Permission bits for the created file (subject to process umask).
   * Defaults to 0o600 (owner read/write only) for security.
   */
  mode?: number

  /**
   * Permission bits for created parent directories (subject to umask).
   * Defaults to 0o700 (owner full access only).
   */
  dirMode?: number
}

/**
 * Write binary data to a file with symlink containment and TOCTOU mitigation.
 *
 * This function ensures that:
 * 1. The target path is lexically and physically under allowedRoot
 * 2. No symlinks exist in the path that could escape allowedRoot
 * 3. The target is not a dangling symlink
 * 4. TOCTOU is mitigated by writing to a temp file in the same directory
 *    and atomically renaming it
 *
 * The write operation:
 * - Creates parent directories as needed (within allowedRoot)
 * - Writes complete data to a random-suffix temporary file
 * - Verifies no symlinks were introduced during the write
 * - Atomically renames the temp file to the target
 * - Cleans up the temp file on any failure
 *
 * @param filename - Target file path (must be under allowedRoot)
 * @param data - Binary data to write
 * @param allowedRoot - Root directory that filename must be under
 * @param options - File permissions and directory permissions
 * @throws {SymlinkContainmentError} if path contains or becomes a symlink
 * @throws {Error} if path is outside allowedRoot or other I/O errors occur
 *
 * @example
 * ```ts
 * await writeBinarySafe(
 *   '/workspace/screenshots/capture.png',
 *   pngBuffer,
 *   '/workspace',
 *   { mode: 0o644 }
 * )
 * ```
 */
export async function writeBinarySafe(
  filename: string,
  data: Uint8Array,
  allowedRoot: string,
  options: WriteBinarySafeOptions = {},
): Promise<void> {
  const mode = options.mode ?? 0o600
  const dirMode = options.dirMode ?? 0o700

  // Normalize paths to absolute form
  const targetPath = normalizeAbsolute(filename)
  const rootPath = normalizeAbsolute(allowedRoot)

  // Verify lexical containment
  if (!isLexicallyUnder(targetPath, rootPath)) {
    throw new Error(`Target path ${targetPath} is outside allowed root ${rootPath}`)
  }

  // Verify no escaping symlinks exist in the path before we start
  await verifyNoEscapingSymlinks(targetPath, rootPath)

  const dir = dirname(targetPath)

  // Verify directory path also has no escaping symlinks
  await verifyNoEscapingSymlinks(dir, rootPath)

  // Create parent directories if needed (within allowed root)
  await mkdir(dir, { recursive: true, mode: dirMode })

  // Verify again after mkdir in case something changed
  await verifyNoEscapingSymlinks(dir, rootPath)

  // Write to a temporary file in the same directory
  // Using same directory ensures rename is atomic (same filesystem)
  const tempSuffix = randomBytes(6).toString('hex')
  const tempPath = join(dir, `.${tempSuffix}.tmp`)

  try {
    // Write complete data to temp file with exclusive create
    // 'wx' flag refuses to follow symlinks and fails if file exists
    await writeFile(tempPath, data, { mode, flag: 'wx' })

    // Final verification before rename: check no symlinks were introduced
    await verifyNoEscapingSymlinks(targetPath, rootPath)
    await verifyNoEscapingSymlinks(tempPath, rootPath)

    // Atomic rename - replaces target even if it's a symlink
    // (renames over the symlink itself, doesn't follow it)
    await rename(tempPath, targetPath)
  } catch (error) {
    // Clean up temp file on any failure
    await rm(tempPath, { force: true })
    throw error
  }
}
