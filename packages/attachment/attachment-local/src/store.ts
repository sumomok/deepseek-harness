/** Content-addressed, owner-private local attachment storage. */

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import {
  AttachmentError,
  AttachmentId,
} from '@deepseek-ai/dsh-attachment'
import type {
  AttachmentIdType,
  FileAttachmentLimits,
  FileAttachmentRef,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveFileAttachment,
  SaveImageAttachment,
  StoredFileAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { normalizeImage } from './normalization.ts'
import type { NormalizationPolicy } from './normalization.ts'
import { detectImage, probeImage } from './image.ts'
import type { DetectedImage } from './image.ts'
import { detectText } from './text.ts'

const ID_PATTERN = /^sha256:([a-f0-9]{64})$/
const durableHomes = new Set<string>()

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function displayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  // Strip both separator styles by hand: a POSIX host treats `\` as an
  // ordinary character, so path.basename would keep a Windows client's full
  // local path and leak it into the reference and the session log.
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255)
  return clean === '' ? undefined : clean
}

function objectPath(root: string, sha256: string): string {
  return join(root, 'objects', sha256.slice(0, 2), sha256)
}

/** Content-addressed digest an attachment reference of any kind carries. */
function ensureReference(ref: { attachmentId: AttachmentIdType }): string {
  const match = ID_PATTERN.exec(String(ref.attachmentId))
  if (match?.[1] === undefined) throw new AttachmentError('Attachment reference is invalid.', 'INVALID_ATTACHMENT_REF')
  return match[1]
}

async function inspectMetadata(
  data: Uint8Array,
  declaredMediaType: ImageAttachmentRef['mediaType'],
  limits: ImageAttachmentLimits,
): Promise<DetectedImage> {
  if (data.byteLength === 0) throw new AttachmentError('Image is empty.', 'INVALID_IMAGE')
  const detected = await detectImage(data, { maxPixels: limits.maxImagePixels, maxDimension: limits.maxImageDimension })
  if (detected.mediaType !== declaredMediaType) throw new AttachmentError('Declared image type does not match its bytes.', 'IMAGE_TYPE_MISMATCH')
  return detected
}

/**
 * Run the full admission policy for one image without touching storage,
 * including normalization: a batch whose members all validate cannot later
 * be refused by the normalized image byte cap during publication.
 * @param input - encoded bytes and declared metadata.
 * @param limits - resolved source admission policy.
 * @param policy - resolved normalization policy.
 * @returns completion after the raster has been decoded and its normalized version proven to fit.
 */
export async function validateImageFile(
  input: SaveImageAttachment,
  limits: ImageAttachmentLimits,
  policy: NormalizationPolicy,
): Promise<void> {
  await prepareImageFile(input, limits, policy)
}

/** Fully prepared normalized object, verified before any batch member is persisted. */
export interface PreparedImageFile {
  /** Deterministic normalized bytes whose digest is {@link ref.attachmentId}. */
  data: Uint8Array
  /** Durable reference describing {@link data}. */
  ref: ImageAttachmentRef
}

/**
 * Decode, normalize, and verify one submitted image without touching storage.
 * @param input - submitted encoded bytes and declared media type.
 * @param limits - source admission policy.
 * @param policy - independent normalization policy.
 * @returns immutable reference facts beside bytes ready for atomic publication.
 */
export async function prepareImageFile(
  input: SaveImageAttachment,
  limits: ImageAttachmentLimits,
  policy: NormalizationPolicy,
): Promise<PreparedImageFile> {
  if (input.data.byteLength > limits.maxImageBytes) {
    throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE')
  }
  const detected = await inspectMetadata(input.data, input.mediaType, limits)
  const normalized = await normalizeImage(input.data, detected, policy)
  const sha256 = digest(normalized.data)
  const name = displayName(input.name)
  const downscaled = detected.width !== normalized.width || detected.height !== normalized.height
  return {
    data: normalized.data,
    ref: {
      attachmentId: AttachmentId(`sha256:${sha256}`),
      mediaType: normalized.mediaType,
      width: normalized.width,
      height: normalized.height,
      bytes: normalized.data.byteLength,
      ...(name !== undefined ? { name } : {}),
      ...downscaled ? { originalDimensions: { width: detected.width, height: detected.height } } : {},
    },
  }
}

/**
 * Make a directory's entries durable (fsync on a read-only directory handle).
 * A synced file alone does not survive a crash when its directory entry never
 * reached storage, so the publication directory is synced before a durable
 * reference is reported.
 */
async function syncDirectory(path: string): Promise<void> {
  /* v8 ignore next -- Windows cannot open directory handles; NTFS metadata journaling owns entry durability there. */
  if (process.platform === 'win32') return
  /* v8 ignore start -- Windows cannot exercise directory fsync; POSIX behavior tests enforce this peer. */
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  /* v8 ignore stop */
}

/**
 * Create one private directory tree and persist every ancestor entry up to a
 * caller-vouched durable boundary. The walk deliberately ignores what mkdir
 * reports as newly created: a concurrent first save can create a level this
 * process then merely observes, so "already existed" is not "already durable"
 * — the entry may still be unsynced in the creator, and a crash would drop a
 * directory the session checkpoint already references. Re-syncing a durable
 * entry is harmless; skipping an unsynced one is not.
 * @param path - absolute directory to create.
 * @param boundary - absolute ancestor the caller vouches is already durable.
 */
async function ensureDurableDirectory(path: string, boundary: string): Promise<void> {
  const target = resolve(path)
  const stop = resolve(boundary)
  await mkdir(target, { recursive: true, mode: 0o700 })
  await chmod(target, 0o700)
  let level = target
  while (level !== stop) {
    const parent = dirname(level)
    await syncDirectory(parent)
    /* v8 ignore next -- filesystem-root guard: callers pass a boundary that is an ancestor of path, so the walk reaches it first. */
    if (parent === level) return
    level = parent
  }
}

/**
 * Establish this process's proof that one DSH_HOME entry and every ancestor
 * below the filesystem root are durable. Mere existence is insufficient: a
 * concurrent process may have created the directory but not synced its parent.
 */
async function ensureDurableHome(path: string): Promise<string> {
  const home = resolve(path)
  if (!durableHomes.has(home)) {
    await ensureDurableDirectory(home, parse(home).root)
    durableHomes.add(home)
  }
  return home
}

/**
 * Publish one already digest-verified object below one bucketed directory.
 * Shared durable-write core for every attachment kind, byte-agnostic: create
 * temp in staging, fsync, hardlink into place, fsync the affected
 * directories, unlink staging. A concurrent duplicate publish is resolved by
 * re-verifying the existing object's digest rather than failing.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param sha256 - lowercase hex digest of `data`, already verified by the caller.
 * @param data - the exact bytes `sha256` was computed over.
 */
async function commitDurableObject(root: string, sha256: string, data: Uint8Array): Promise<void> {
  const bucket = join(root, 'objects', sha256.slice(0, 2))
  const staging = join(root, 'tmp')
  // Establish DSH_HOME itself against the filesystem root once per process.
  // Every process performs that proof independently, so observing a directory
  // another process created can never be mistaken for durable publication.
  const boundary = await ensureDurableHome(dirname(dirname(resolve(root))))
  await ensureDurableDirectory(bucket, boundary)
  await ensureDurableDirectory(staging, boundary)
  const temporary = join(staging, randomUUID())
  const target = objectPath(root, sha256)
  let handle
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    try {
      await link(temporary, target)
    } catch (error) {
      /* v8 ignore next -- Private same-filesystem directories make EEXIST the only recoverable link race. */
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      const existing = new Uint8Array(await readFile(target))
      if (digest(existing) !== sha256) throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
    }
    // Persist the target entry and close a concurrent bucket-creation window
    // before the reference can reach a session checkpoint. The dedup path
    // repeats both syncs because it may observe another writer's link before
    // that writer reaches its own durability boundary.
    await syncDirectory(bucket)
    await syncDirectory(join(root, 'objects'))
    await unlink(temporary)
  } catch (error) {
    /* v8 ignore next -- A descriptor can remain open only when the underlying write/sync/close operation fails. */
    if (handle !== undefined) await handle.close().catch(
      /* v8 ignore next -- Close failure is superseded by the storage operation that entered cleanup. */
      () => {},
    )
    await unlink(temporary).catch(
      /* v8 ignore next -- The callback requires a second independent staging-unlink failure. */
      (cleanupError: unknown) => {
        /* v8 ignore next -- Cleanup is best-effort only for a staging file already removed by a failed operation. */
        if (!(cleanupError instanceof Error && 'code' in cleanupError && cleanupError.code === 'ENOENT')) throw cleanupError
      },
    )
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unable to persist attachment.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
  }
}

/** Bytes verified against the digest their own reference declares, for any attachment kind. */
interface VerifiedPrepared<TRef extends { attachmentId: AttachmentIdType; bytes: number }> {
  data: Uint8Array
  ref: TRef
}

/**
 * Verify one prepared object's bytes against its own content-addressed
 * reference, then publish it. Shared by every attachment kind's
 * `commitPrepared*File` — only the reference type differs.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param prepared - bytes and the reference {@link ensureReference} addresses them by.
 * @returns `prepared.ref`, after its bytes are durably published.
 */
async function verifyAndCommitPrepared<TRef extends { attachmentId: AttachmentIdType; bytes: number }>(
  root: string,
  prepared: VerifiedPrepared<TRef>,
): Promise<TRef> {
  const sha256 = ensureReference(prepared.ref)
  if (digest(prepared.data) !== sha256 || prepared.data.byteLength !== prepared.ref.bytes) {
    throw new AttachmentError('Prepared attachment bytes do not match their reference.', 'ATTACHMENT_CORRUPT')
  }
  await commitDurableObject(root, sha256, prepared.data)
  return prepared.ref
}

/**
 * Publish one already verified normalized image below a versioned attachment root.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param prepared - deterministic normalized bytes and reference.
 * @returns durable content-addressed normalized image reference.
 */
export async function commitPreparedImageFile(
  root: string,
  prepared: PreparedImageFile,
): Promise<ImageAttachmentRef> {
  return verifyAndCommitPrepared(root, prepared)
}

/**
 * Decode and normalize one image once, then publish the prepared object.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param input - submitted encoded bytes and declared media type.
 * @param limits - resolved source admission policy.
 * @param policy - resolved normalization policy.
 * @returns durable content-addressed normalized image reference.
 */
export async function saveImageFile(
  root: string,
  input: SaveImageAttachment,
  limits: ImageAttachmentLimits,
  policy: NormalizationPolicy,
): Promise<ImageAttachmentRef> {
  return commitPreparedImageFile(root, await prepareImageFile(input, limits, policy))
}

/**
 * Read one content-addressed object's bytes and verify them against `sha256`.
 * Shared by every attachment kind's `read*File` — only the reference-field
 * re-verification after this point differs by kind.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param sha256 - lowercase hex digest the object is addressed by.
 * @param signal - optional cancellation for the filesystem read.
 * @returns the digest-verified bytes.
 * @throws the signal reason when aborted, `ATTACHMENT_NOT_FOUND` when missing,
 * `ATTACHMENT_READ_FAILED` on another filesystem failure, or
 * `ATTACHMENT_CORRUPT` on a digest mismatch.
 */
async function readVerifiedObject(root: string, sha256: string, signal: AbortSignal | undefined): Promise<Uint8Array> {
  signal?.throwIfAborted()
  let data: Uint8Array
  try {
    data = new Uint8Array(await readFile(objectPath(root, sha256), { signal }))
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    throw new AttachmentError('Unable to read attachment.', 'ATTACHMENT_READ_FAILED', { cause: error })
  }
  signal?.throwIfAborted()
  if (digest(data) !== sha256) throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
  return data
}

/**
 * Read and verify one content-addressed image.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param ref - reference recorded in the session log.
 * @param signal - optional cancellation for filesystem and verification work.
 * @returns verified bytes and reference.
 * @throws the signal reason when aborted, or an AttachmentError when verification fails.
 */
export async function readImageFile(
  root: string,
  ref: ImageAttachmentRef,
  signal?: AbortSignal,
): Promise<StoredImageAttachment> {
  const sha256 = ensureReference(ref)
  const data = await readVerifiedObject(root, sha256, signal)
  // The digest proves these are the exact bytes admission fully decoded, so
  // the read path only re-derives the header fields (no raster decode, no
  // per-request pixel amplification on history replay).
  const metadata = await probeImage(data)
  signal?.throwIfAborted()
  if (metadata.mediaType !== ref.mediaType || data.byteLength !== ref.bytes
    || metadata.width !== ref.width || metadata.height !== ref.height) {
    throw new AttachmentError('Stored attachment metadata does not match its reference.', 'ATTACHMENT_CORRUPT')
  }
  return { ref, data }
}

/**
 * Run the full admission policy for one text file without touching storage.
 * @param input - submitted bytes and display name.
 * @param limits - resolved source admission policy.
 * @returns completion after the bytes have been proven valid UTF-8 text.
 */
export async function validateTextFile(input: SaveFileAttachment, limits: FileAttachmentLimits): Promise<void> {
  await prepareTextFile(input, limits)
}

/** Fully verified object, checked before any batch member is persisted. */
export interface PreparedTextFile {
  /** Submitted bytes, unchanged; {@link ref.attachmentId} is their digest. */
  data: Uint8Array
  /** Durable reference describing {@link data}. */
  ref: FileAttachmentRef
}

/**
 * Verify one submitted text file without touching storage.
 * @param input - submitted bytes and display name.
 * @param limits - source admission policy.
 * @returns immutable reference facts beside bytes ready for atomic publication.
 */
// oxlint-disable-next-line typescript/require-await -- Preserve promise rejection semantics at the async provider contract.
export async function prepareTextFile(
  input: SaveFileAttachment,
  limits: FileAttachmentLimits,
): Promise<PreparedTextFile> {
  if (input.data.byteLength > limits.maxFileBytes) {
    throw new AttachmentError('File exceeds the configured byte limit.', 'FILE_TOO_LARGE')
  }
  // The decoded text itself is not needed at storage time — request-time
  // lowering re-reads and re-decodes the stored bytes, exactly like images
  // store raw normalized bytes rather than decoded pixels — so only the
  // validation outcome of detectText is used here.
  detectText(input.data)
  const name = displayName(input.name)
  if (name === undefined) throw new AttachmentError('File name is required.', 'INVALID_FILE_NAME')
  const sha256 = digest(input.data)
  return {
    data: input.data,
    ref: {
      attachmentId: AttachmentId(`sha256:${sha256}`),
      name,
      bytes: input.data.byteLength,
    },
  }
}

/**
 * Publish one already verified text file below a versioned attachment root.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param prepared - verified bytes and reference.
 * @returns durable content-addressed file reference.
 */
export async function commitPreparedTextFile(
  root: string,
  prepared: PreparedTextFile,
): Promise<FileAttachmentRef> {
  return verifyAndCommitPrepared(root, prepared)
}

/**
 * Verify one text file once, then publish the prepared object.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param input - submitted bytes and display name.
 * @param limits - resolved source admission policy.
 * @returns durable content-addressed file reference.
 */
export async function saveTextFile(
  root: string,
  input: SaveFileAttachment,
  limits: FileAttachmentLimits,
): Promise<FileAttachmentRef> {
  return commitPreparedTextFile(root, await prepareTextFile(input, limits))
}

/**
 * Read and verify one content-addressed text file.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param ref - reference recorded in the session log.
 * @param signal - optional cancellation for filesystem and verification work.
 * @returns verified bytes and reference.
 * @throws the signal reason when aborted, or an AttachmentError when verification fails.
 */
export async function readTextFile(
  root: string,
  ref: FileAttachmentRef,
  signal?: AbortSignal,
): Promise<StoredFileAttachment> {
  const sha256 = ensureReference(ref)
  const data = await readVerifiedObject(root, sha256, signal)
  if (data.byteLength !== ref.bytes) {
    throw new AttachmentError('Stored attachment metadata does not match its reference.', 'ATTACHMENT_CORRUPT')
  }
  return { ref, data }
}
