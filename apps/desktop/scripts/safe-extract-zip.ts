/**
 * Safe ZIP extraction with path traversal and symlink protection.
 * Replaces extract-zip to address GHSA-jmr9-qjv8-65gv.
 */

import { createWriteStream } from 'node:fs'
import { mkdir, realpath, stat, symlink, unlink } from 'node:fs/promises'
import { dirname, join, normalize, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'

interface ExtractOptions {
  dir: string
}

/**
 * Safely validate that a resolved path is within the target directory.
 * Prevents path traversal attacks (e.g., '../../../etc/passwd').
 */
function validatePathContainment(targetDir: string, entryPath: string): void {
  const normalizedTarget = resolve(targetDir)
  const normalizedEntry = resolve(entryPath)
  const rel = relative(normalizedTarget, normalizedEntry)

  if (rel.startsWith(`..${sep}`) || rel === '..' || resolve(normalizedTarget, rel) !== normalizedEntry) {
    throw new Error(`Path traversal detected: entry "${entryPath}" escapes target directory "${targetDir}"`)
  }
}

/**
 * Validate symlink target to ensure it stays within the extraction directory.
 * Prevents symlink attacks where a link points outside the target.
 */
function validateSymlinkTarget(targetDir: string, symlinkPath: string, linkTarget: string): void {
  const symlinkDir = dirname(symlinkPath)
  const absoluteTarget = resolve(symlinkDir, linkTarget)

  validatePathContainment(targetDir, absoluteTarget)
}

/**
 * Check if a path already exists and whether it's a symlink.
 * Returns null if path doesn't exist, 'symlink' if it's a symlink, 'file' or 'directory' otherwise.
 */
async function checkExistingPath(filePath: string): Promise<'symlink' | 'file' | 'directory' | null> {
  try {
    const stats = await stat(filePath)
    if (stats.isSymbolicLink()) return 'symlink'
    if (stats.isDirectory()) return 'directory'
    return 'file'
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Safely extract a ZIP file using yauzl with strict security checks.
 *
 * Security measures:
 * - All extracted paths are validated to stay within the target directory
 * - Symlink targets are validated to point within the extraction directory
 * - Existing symlinks are removed before extraction to prevent TOCTOU attacks
 * - Directories are created with proper permissions
 *
 * Extraction runs in two phases: regular files and directories land first,
 * then symlinks are created. A ZIP entry order that places a symlink before
 * its target (e.g. Electron's `Versions/Current` → `Versions/A`) would
 * otherwise fail the `realpath` check with ENOENT.
 *
 * @param zipPath - Path to the ZIP file
 * @param options - Extraction options including target directory
 * @throws Error if path traversal, invalid symlink, or extraction error is detected
 */
export async function safeExtractZip(zipPath: string, options: ExtractOptions): Promise<void> {
  const targetDir = resolve(options.dir)

  await mkdir(targetDir, { recursive: true })

  const targetDirReal = await realpath(targetDir)

  /** Symlinks collected in phase 1, created in phase 2 after all targets exist. */
  const pendingSymlinks: { entryPath: string; linkTarget: string }[] = []

  await new Promise<void>((resolvePromise, rejectPromise) => {
    yauzl.open(zipPath, { lazyEntries: true, strictFileNames: true }, (err, zipfile) => {
      if (err !== null || zipfile === undefined) {
        rejectPromise(err ?? new Error('Failed to open ZIP file'))
        return
      }

      zipfile.readEntry()

      zipfile.on('entry', (entry: yauzl.Entry) => {
        const entryPath = join(targetDir, normalize(entry.fileName))

        try {
          validatePathContainment(targetDir, entryPath)
        } catch (error) {
          zipfile.close()
          rejectPromise(error)
          return
        }

        if (/\/$/.test(entry.fileName)) {
          mkdir(entryPath, { recursive: true })
            .then(() => { zipfile.readEntry() })
            .catch((error: unknown) => {
              zipfile.close()
              rejectPromise(error)
            })
        } else {
          zipfile.openReadStream(entry, (streamErr, readStream) => {
            if (streamErr !== null || readStream === undefined) {
              zipfile.close()
              rejectPromise(streamErr ?? new Error('Failed to open entry read stream'))
              return
            }

            readStream.on('error', (error: unknown) => {
              zipfile.close()
              rejectPromise(error)
            })

            const isSymlink = (entry.externalFileAttributes >>> 28) === 0xa

            const processEntry = async (): Promise<void> => {
              const existing = await checkExistingPath(entryPath)
              if (existing === 'symlink') {
                await unlink(entryPath)
              }

              await mkdir(dirname(entryPath), { recursive: true })

              if (isSymlink) {
                const chunks: Buffer[] = []
                readStream.on('data', (chunk: Buffer) => { chunks.push(chunk) })
                await new Promise<void>((resolve, reject) => {
                  readStream.on('end', () => { resolve() })
                  readStream.on('error', reject)
                })

                const linkTarget = Buffer.concat(chunks).toString('utf8')

                validateSymlinkTarget(targetDir, entryPath, linkTarget)

                // Defer symlink creation to phase 2: the target may not have
                // been extracted yet when this entry is read.
                pendingSymlinks.push({ entryPath, linkTarget })
              } else {
                const writeStream = createWriteStream(entryPath, { mode: entry.externalFileAttributes >>> 16 })
                await pipeline(readStream, writeStream)
              }
            }

            processEntry()
              .then(() => { zipfile.readEntry() })
              .catch((error: unknown) => {
                zipfile.close()
                rejectPromise(error)
              })
          })
        }
      })

      zipfile.on('end', () => {
        zipfile.close()
        resolvePromise()
      })

      zipfile.on('error', (error: unknown) => {
        zipfile.close()
        rejectPromise(error)
      })
    })
  })

  // Phase 2: create ALL symlinks first, then validate. Some links form chains
  // (e.g. `Electron Framework` → `Versions/Current/Electron Framework` →
  // `Versions/A/Electron Framework`), so realpath() on an early link would
  // fail if a later link in its chain has not been created yet.
  for (const { entryPath, linkTarget } of pendingSymlinks) {
    await symlink(linkTarget, entryPath)
  }

  for (const { entryPath, linkTarget } of pendingSymlinks) {
    const linkTargetAbsolute = resolve(dirname(entryPath), linkTarget)
    const linkTargetReal = await realpath(linkTargetAbsolute)

    validatePathContainment(targetDirReal, linkTargetReal)
  }
}
