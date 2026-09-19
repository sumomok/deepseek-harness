/**
 * The packed file a delivery hands over: one archive carrying a set of packs
 * and a manifest that says what is in it.
 *
 * The manifest is the authority. It states the format version, the set's own
 * identity, and one SHA-256 digest per file, and the installer verifies all of
 * it before a single byte is staged: an archive that carries an entry the
 * manifest does not declare, lacks one it does, or carries bytes whose digest
 * does not match is refused whole. Nothing installs from a half-verified
 * archive, and nothing about a file's own container metadata decides what is
 * written — every declared file is written as an ordinary file, so an entry
 * another tool marked as a link, a hard link or a device is either undeclared,
 * and refused, or written as a file holding those bytes.
 *
 * The archive is a ZIP, read and written with `fflate`, which this workspace
 * already depends on. {@link buildPackArchive} writes the entries in one fixed
 * order under one fixed modification time, so the same packs produce the same
 * bytes; the digests in the manifest are the identity that survives a change
 * of compressor.
 * @module @deepseek-ai/dsh-experimental-skill-pack/src/archive
 */

import { createHash } from 'node:crypto'
import { unzipSync, zipSync } from 'fflate'
import { z } from 'zod'
import { readSourceDirectory, validatePacks } from './delivery.ts'
import { PackInstallError } from './refusal.ts'
import type {
  DeliveredFile,
  DeliveredPack,
  PackArchiveLimits,
  PackSetIdentity,
  PackSetSource,
} from './types.ts'

/** The manifest format this build writes, and the only one it reads. */
export const PACK_ARCHIVE_FORMAT = 1

/** The archive entry carrying the manifest. */
export const PACK_ARCHIVE_MANIFEST = 'pack-delivery.json'

/** File-name suffix of a delivery archive, which is how one is told from anything else in a directory. */
export const PACK_ARCHIVE_EXTENSION = '.dshpack'

/** Entry-name prefix every pack file sits under, so no pack file can be named like the manifest. */
const PACK_ARCHIVE_PREFIX = 'packs/'

/**
 * DEFLATE level every entry is written at. Fixed rather than configurable: the
 * bytes of an archive are its identity to whoever stores or transfers it, and
 * a level that varied would make two runs over the same packs two files.
 */
const PACK_ARCHIVE_LEVEL = 6

/**
 * Modification time every entry is written under, as a local-time string.
 *
 * A ZIP stores the local Y/M/D/H/M/S of the instant, so an absolute timestamp
 * would encode differently in each timezone and the same packs would produce
 * different bytes on two hosts. A local-time string is the same fields
 * everywhere. The year is the earliest a ZIP can represent.
 */
const PACK_ARCHIVE_MTIME = '1980-01-01T12:00:00'

const manifestSchema = z.strictObject({
  format: z.number(),
  set: z.strictObject({
    id: z.string().min(1),
    version: z.string().min(1),
  }),
  files: z.array(z.strictObject({
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a SHA-256 digest in lowercase hexadecimal'),
  })),
})

/** What one archive delivers: the set it says it is, and the packs it carries. */
export interface PackArchiveContents {
  /** The set's own identity, as its manifest states it. */
  readonly set: PackSetIdentity
  /** Every pack in the archive, in the order its manifest declares them. */
  readonly packs: readonly DeliveredPack[]
}

/**
 * Write a set of packs into one archive.
 *
 * The same packs under the same identity produce the same bytes: entries are
 * written in path order under a fixed modification time at a fixed compression
 * level. Every pack rule is applied here as well as at install time, so an
 * archive this function returns is one the installer accepts.
 * @param source - the packs to write, or the directory holding them.
 * @param set - the identity the manifest carries, which the installing deployment logs and nothing compares.
 * @returns the archive's bytes.
 * @throws {PackInstallError} when a pack name, path or extension is one a pack may not carry, or the
 *   source directory holds a symbolic link or an entry that is not a pack directory.
 */
export async function buildPackArchive(source: PackSetSource, set: PackSetIdentity): Promise<Uint8Array> {
  const packs = validatePacks(source.kind === 'packs' ? source.packs : await readSourceDirectory(source.path))
  const files: { path: string; sha256: string; content: Uint8Array }[] = []
  for (const pack of packs) {
    for (const file of pack.files) {
      const content = bytesOf(file)
      files.push({ path: `${pack.name}/${file.path}`, sha256: digestOf(content), content })
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  const manifest = {
    format: PACK_ARCHIVE_FORMAT,
    set: { id: set.id, version: set.version },
    files: files.map(({ path, sha256 }) => ({ path, sha256 })),
  }
  const entries: Record<string, Uint8Array> = {
    [PACK_ARCHIVE_MANIFEST]: new TextEncoder().encode(`${JSON.stringify(manifest, undefined, 2)}\n`),
  }
  for (const file of files) entries[PACK_ARCHIVE_PREFIX + file.path] = file.content
  return zipSync(entries, { level: PACK_ARCHIVE_LEVEL, mtime: PACK_ARCHIVE_MTIME })
}

/**
 * Read one archive into the packs it delivers, verifying all of it first.
 *
 * Nothing is returned from a partly verified archive: the limits, the
 * manifest, every declared digest and the entry set are checked before the
 * first pack is handed back, so an installer that stages what this returns
 * stages a set that was whole when it was read.
 * @param name - the archive's own name, which every refusal about the archive as a whole is reported against.
 * @param bytes - the archive's bytes.
 * @param limits - the sizes and count this archive is read under.
 * @returns the set's identity and its packs.
 * @throws {PackInstallError} when the archive is over a limit, is not readable, carries no manifest or an
 *   unknown format version, declares a path that names no pack directory, disagrees with its own manifest
 *   about which entries exist, or carries a file whose digest does not match.
 */
export function readPackArchive(name: string, bytes: Uint8Array, limits: PackArchiveLimits): PackArchiveContents {
  if (bytes.length > limits.maxArchiveBytes) {
    throw new PackInstallError('archive-oversize', name, `is ${String(bytes.length)} bytes, over the ${String(limits.maxArchiveBytes)} it is read under`)
  }
  const entries = unzipEntries(name, bytes, limits)
  const manifest = readManifest(name, entries)
  const declared = new Set<string>()
  const packs = new Map<string, DeliveredFile[]>()
  for (const file of manifest.files) {
    const entry = PACK_ARCHIVE_PREFIX + file.path
    if (declared.has(entry)) {
      throw new PackInstallError('duplicate-entry', file.path, 'a manifest declares each path once')
    }
    declared.add(entry)
    const content = entries.get(entry)
    if (content === undefined) {
      throw new PackInstallError('archive-entry', file.path, 'the manifest declares a file the archive does not carry')
    }
    if (digestOf(content) !== file.sha256) {
      throw new PackInstallError('archive-digest', file.path, 'the file\'s bytes are not the ones the manifest states')
    }
    const slash = file.path.indexOf('/')
    if (slash <= 0 || slash === file.path.length - 1) {
      throw new PackInstallError('path-escape', file.path, 'a delivered file sits inside a pack directory')
    }
    const pack = file.path.slice(0, slash)
    const files = packs.get(pack) ?? []
    files.push({ path: file.path.slice(slash + 1), content })
    packs.set(pack, files)
  }
  for (const entry of entries.keys()) {
    if (entry !== PACK_ARCHIVE_MANIFEST && !declared.has(entry)) {
      throw new PackInstallError('archive-entry', entry, 'the archive carries an entry its manifest does not declare')
    }
  }
  return {
    set: manifest.set,
    packs: [...packs].map(([pack, files]) => ({ name: pack, files })),
  }
}

/**
 * Unpack every entry, refusing a file or a count over the limit before it is
 * decompressed: the size the archive states for an entry is read first, so a
 * small archive claiming a huge file is refused rather than expanded. The
 * entry each file is read from decides how large a file can be, so what the
 * bytes actually inflate to is bounded by what was checked.
 *
 * An entry name that appears twice is refused rather than resolved: the reader
 * keeps one of the two, and which one it keeps would decide what a deployment
 * installs.
 */
function unzipEntries(name: string, bytes: Uint8Array, limits: PackArchiveLimits): Map<string, Uint8Array> {
  let count = 0
  let entries: Map<string, Uint8Array>
  try {
    entries = new Map(Object.entries(unzipSync(bytes, {
      filter: (file) => {
        count += 1
        if (count > limits.maxFiles) {
          throw new PackInstallError('archive-oversize', name, `carries more than the ${String(limits.maxFiles)} entries it is read under`)
        }
        if (file.originalSize > limits.maxFileBytes) {
          throw new PackInstallError('archive-oversize', file.name, `states ${String(file.originalSize)} bytes, over the ${String(limits.maxFileBytes)} it is read under`)
        }
        return true
      },
    })))
  } catch (error) {
    if (error instanceof PackInstallError) throw error
    throw new PackInstallError('archive-unreadable', name, `is not an archive this deployment can read: ${String(error)}`)
  }
  if (entries.size !== count) {
    throw new PackInstallError('duplicate-entry', name, 'an archive carries each entry name once')
  }
  return entries
}

/** The manifest an archive carries, refused as a whole where it is absent, unreadable or not a manifest. */
function readManifest(name: string, entries: ReadonlyMap<string, Uint8Array>): z.infer<typeof manifestSchema> {
  const raw = entries.get(PACK_ARCHIVE_MANIFEST)
  if (raw === undefined) {
    throw new PackInstallError('archive-manifest', name, `carries no ${PACK_ARCHIVE_MANIFEST}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw))
  } catch (error) {
    throw new PackInstallError('archive-manifest', PACK_ARCHIVE_MANIFEST, `is not JSON: ${String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PackInstallError('archive-manifest', PACK_ARCHIVE_MANIFEST, 'is not a manifest object')
  }
  const stated = (parsed as Record<string, unknown>).format
  if (stated !== PACK_ARCHIVE_FORMAT) {
    throw new PackInstallError(
      'archive-format',
      PACK_ARCHIVE_MANIFEST,
      `states format ${JSON.stringify(stated) ?? 'undefined'}; this deployment reads format ${String(PACK_ARCHIVE_FORMAT)}`,
    )
  }
  const read = manifestSchema.safeParse(parsed)
  if (!read.success) {
    const issue = read.error.issues[0]
    /* v8 ignore next -- zod reports at least one issue for every failed parse; the fallback keeps a refusal from naming no field. */
    const field = issue === undefined ? PACK_ARCHIVE_MANIFEST : [PACK_ARCHIVE_MANIFEST, ...issue.path.map(String)].join('.')
    /* v8 ignore next -- same fallback, for the sentence that names what the field requires. */
    throw new PackInstallError('archive-manifest', field, issue?.message ?? 'is not a manifest')
  }
  return read.data
}

/** One delivered file's bytes, whichever of the two forms the delivery carries it in. */
function bytesOf(file: DeliveredFile): Uint8Array {
  return typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content
}

/** The SHA-256 of one file's bytes, lowercase hexadecimal, as the manifest states it. */
function digestOf(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}
