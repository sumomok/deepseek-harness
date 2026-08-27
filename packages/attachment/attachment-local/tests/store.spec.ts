import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import type { FileAttachmentLimits, ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { NormalizationPolicy } from '../src/normalization.ts'
import {
  commitPreparedImageFile,
  commitPreparedTextFile,
  prepareImageFile,
  prepareTextFile,
  readImageFile,
  readTextFile,
  saveImageFile,
  saveTextFile,
} from '../src/store.ts'

const fsControl = vi.hoisted(() => ({
  readSignals: [] as AbortSignal[],
  syncedDirectories: [] as string[],
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile(...args: Parameters<typeof actual.readFile>): ReturnType<typeof actual.readFile> {
      const options = args[1]
      if (typeof options === 'object' && options !== null) {
        const signal = (options as { signal?: AbortSignal }).signal
        if (signal !== undefined) fsControl.readSignals.push(signal)
      }
      return actual.readFile(...args)
    },
    async open(...args: Parameters<typeof actual.open>): ReturnType<typeof actual.open> {
      if (args[1] === constants.O_RDONLY) fsControl.syncedDirectories.push(String(args[0]))
      return actual.open(...args)
    },
  }
})

const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
  'base64',
))

const POLICY: NormalizationPolicy = { maxDimension: 2048, maxBytes: 1024 * 1024 }

const LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 1024,
  maxImagesPerMessage: 2,
  maxMessageImageBytes: 2048,
  maxImagePixels: 16,
  maxImageDimension: 2000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

const roots: string[] = []

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-attachment-'))
  roots.push(value)
  return join(value, 'attachments', 'v1')
}

function parentChainToRoot(path: string): string[] {
  const parents: string[] = []
  let level = resolve(path)
  const root = parse(level).root
  while (level !== root) {
    level = dirname(level)
    parents.push(level)
  }
  return parents
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('local attachment store', () => {
  it.skipIf(process.platform === 'win32')('syncs every object ancestor up to the durable boundary before returning', async () => {
    const storageRoot = await root()
    const base = join(storageRoot, '..', '..')
    const sha256 = createHash('sha256').update(PNG).digest('hex')
    const objects = join(storageRoot, 'objects')
    const bucket = join(objects, sha256.slice(0, 2))
    fsControl.syncedDirectories.length = 0

    await saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS, POLICY)

    // Each process first proves DSH_HOME durable all the way to the filesystem
    // root; existence alone cannot vouch for a concurrent creator's fsync.
    // Later directory creation can then stop at that process-proven boundary.
    expect(fsControl.syncedDirectories).toEqual([
      ...parentChainToRoot(base),
      // bucket chain: every parent entry between the bucket and the boundary.
      objects,
      storageRoot,
      join(storageRoot, '..'),
      base,
      // staging chain re-walks the shared ancestors after creating tmp.
      storageRoot,
      join(storageRoot, '..'),
      base,
      // publication: the settled object's bucket and its parent for the rename.
      bucket,
      objects,
    ])
  })

  it('creates and persists a missing nested home directory against the filesystem root', async () => {
    const storageRoot = join(await root(), 'home', 'attachments', 'v1')

    const ref = await saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS, POLICY)

    await expect(readImageFile(storageRoot, ref)).resolves.toEqual({ ref, data: PNG })
  })

  it('publishes one private content-addressed object and deduplicates equal bytes', async () => {
    const storageRoot = await root()
    const first = await saveImageFile(storageRoot, {
      data: PNG, mediaType: 'image/png', name: '/private/tmp/pixel.png',
    }, LIMITS, POLICY)
    const second = await saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS, POLICY)
    const sha256 = createHash('sha256').update(PNG).digest('hex')
    const object = join(storageRoot, 'objects', sha256.slice(0, 2), sha256)

    expect(first).toEqual({
      attachmentId: `sha256:${sha256}`,
      mediaType: 'image/png',
      bytes: PNG.byteLength,
      width: 1,
      height: 1,
      name: 'pixel.png',
    })
    expect(second.attachmentId).toBe(first.attachmentId)
    expect(new Uint8Array(await readFile(object))).toEqual(PNG)
    if (process.platform !== 'win32') {
      expect((await stat(object)).mode & 0o777).toBe(0o600)
      expect((await stat(join(storageRoot, 'objects', sha256.slice(0, 2)))).mode & 0o777).toBe(0o700)
    }
    await expect(readImageFile(storageRoot, first)).resolves.toEqual({ ref: first, data: PNG })
  })

  it('stores the normalized image of an oversized source and reads it back verified', async () => {
    const storageRoot = await root()
    const oversized = new Uint8Array(await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 9, g: 9, b: 9 } },
    }).png().toBuffer())

    const saved = await saveImageFile(storageRoot, {
      data: oversized, mediaType: 'image/png', name: 'big.png',
    }, { ...LIMITS, maxImagePixels: 64 }, { maxDimension: 2, maxBytes: 1024 * 1024 })

    expect(saved).toMatchObject({
      mediaType: 'image/png',
      width: 2,
      height: 2,
      name: 'big.png',
      originalDimensions: { width: 4, height: 4 },
    })
    expect(saved.bytes).not.toBe(oversized.byteLength)
    const read = await readImageFile(storageRoot, saved)
    expect(read.data.byteLength).toBe(saved.bytes)
    expect(String(saved.attachmentId)).toBe(`sha256:${createHash('sha256').update(read.data).digest('hex')}`)
  })

  it('keeps admitted history readable after deployment limits become stricter', async () => {
    const storageRoot = await root()
    const ref = await saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS, POLICY)

    await expect(readImageFile(storageRoot, ref)).resolves.toEqual({ ref, data: PNG })
  })

  it('forwards read cancellation to the filesystem and preserves its reason', async () => {
    const storageRoot = await root()
    const ref = await saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS, POLICY)
    const controller = new AbortController()
    fsControl.readSignals.length = 0

    await expect(readImageFile(storageRoot, ref, controller.signal)).resolves.toEqual({ ref, data: PNG })
    expect(fsControl.readSignals).toEqual([controller.signal])

    const cancellation = new Error('attachment read cancelled')
    controller.abort(cancellation)
    await expect(readImageFile(storageRoot, ref, controller.signal)).rejects.toBe(cancellation)
  })

  it('rejects malformed bytes, mismatched declarations, byte limits, and decoded-pixel limits', async () => {
    const storageRoot = await root()
    await expect(saveImageFile(storageRoot, {
      data: new Uint8Array(0), mediaType: 'image/png',
    }, LIMITS, POLICY)).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    await expect(saveImageFile(storageRoot, {
      data: Uint8Array.of(1, 2, 3), mediaType: 'image/png',
    }, LIMITS, POLICY)).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    await expect(saveImageFile(storageRoot, {
      data: PNG, mediaType: 'image/jpeg',
    }, LIMITS, POLICY)).rejects.toMatchObject({ code: 'IMAGE_TYPE_MISMATCH' })
    await expect(saveImageFile(storageRoot, {
      data: PNG, mediaType: 'image/png',
    }, { ...LIMITS, maxImageBytes: 1 }, POLICY)).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })

    const wide = new Uint8Array(await sharp({
      create: { width: 5, height: 5, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer())
    await expect(saveImageFile(storageRoot, {
      data: wide, mediaType: 'image/png',
    }, LIMITS, POLICY)).rejects.toMatchObject({ code: 'IMAGE_TOO_MANY_PIXELS' })
    await expect(saveImageFile(storageRoot, {
      data: wide, mediaType: 'image/png',
    }, { ...LIMITS, maxImagePixels: 25, maxImageDimension: 4 }, POLICY)).rejects.toMatchObject({ code: 'IMAGE_DIMENSION_TOO_LARGE' })
    const unnamed = await saveImageFile(storageRoot, {
      data: PNG, mediaType: 'image/png', name: '\u0000',
    }, LIMITS, POLICY)
    expect(unnamed).not.toHaveProperty('name')
  })

  it('fails closed when an object is missing, corrupted, or addressed by an invalid reference', async () => {
    const storageRoot = await root()
    const ref = await saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS, POLICY)
    const sha256 = String(ref.attachmentId).slice('sha256:'.length)
    const object = join(storageRoot, 'objects', sha256.slice(0, 2), sha256)
    await chmod(object, 0o600)
    await writeFile(object, Uint8Array.of(1, 2, 3))
    await expect(readImageFile(storageRoot, ref))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
    await expect(readImageFile(storageRoot, { ...ref, attachmentId: 'bad' as never }))
      .rejects.toMatchObject({ code: 'INVALID_ATTACHMENT_REF' })

    const missingRoot = await root()
    await mkdir(missingRoot, { recursive: true })
    await expect(readImageFile(missingRoot, ref))
      .rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })

    const unreadableRoot = await root()
    const target = join(unreadableRoot, 'objects', sha256.slice(0, 2), sha256)
    await mkdir(target, { recursive: true })
    await expect(readImageFile(unreadableRoot, ref))
      .rejects.toMatchObject({ code: 'ATTACHMENT_READ_FAILED' })
  })

  it('rejects conflicting existing objects and reference metadata mismatches', async () => {
    const storageRoot = await root()
    const sha256 = createHash('sha256').update(PNG).digest('hex')
    const target = join(storageRoot, 'objects', sha256.slice(0, 2), sha256)
    await mkdir(join(storageRoot, 'objects', sha256.slice(0, 2)), { recursive: true })
    await writeFile(target, Uint8Array.of(1, 2, 3))
    await expect(saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS, POLICY))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })

    await writeFile(target, PNG)
    const ref = await saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS, POLICY)
    await expect(readImageFile(storageRoot, { ...ref, width: ref.width + 1 }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
  })

  it('maps unexpected publication failures to a stable storage error', async () => {
    const storageRoot = await root()
    const sha256 = createHash('sha256').update(PNG).digest('hex')
    const target = join(storageRoot, 'objects', sha256.slice(0, 2), sha256)
    await mkdir(target, { recursive: true })

    await expect(saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS, POLICY))
      .rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
  })

  it('rejects prepared bytes that no longer match their content-addressed reference', async () => {
    const storageRoot = await root()
    const prepared = await prepareImageFile({ data: PNG, mediaType: 'image/png' }, LIMITS, POLICY)

    await expect(commitPreparedImageFile(storageRoot, {
      ...prepared,
      data: Uint8Array.of(...prepared.data, 0),
    })).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
  })
})

const FILE_LIMITS: FileAttachmentLimits = {
  maxFileBytes: 1024,
  maxFilesPerMessage: 2,
  maxMessageFileBytes: 2048,
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

describe('local attachment store: text files', () => {
  it('publishes one private content-addressed object and deduplicates equal bytes', async () => {
    const storageRoot = await root()
    const data = utf8('hello world')
    const first = await saveTextFile(storageRoot, { data, name: '/private/tmp/notes.txt' }, FILE_LIMITS)
    const second = await saveTextFile(storageRoot, { data, name: 'renamed.txt' }, FILE_LIMITS)
    const sha256 = createHash('sha256').update(data).digest('hex')
    const object = join(storageRoot, 'objects', sha256.slice(0, 2), sha256)

    expect(first).toEqual({
      attachmentId: `sha256:${sha256}`,
      name: 'notes.txt',
      bytes: data.byteLength,
    })
    expect(second.attachmentId).toBe(first.attachmentId)
    expect(second.name).toBe('renamed.txt')
    expect(new Uint8Array(await readFile(object))).toEqual(data)
    await expect(readTextFile(storageRoot, first)).resolves.toEqual({ ref: first, data })
  })

  it('shares the same content-addressed object space as images', async () => {
    // Both kinds are digest-keyed blobs in one `objects/` tree; only the
    // reference (image metadata vs display name) differs by kind.
    const storageRoot = await root()
    const data = utf8('shared object space')
    const ref = await saveTextFile(storageRoot, { data, name: 'shared.txt' }, FILE_LIMITS)
    const sha256 = createHash('sha256').update(data).digest('hex')
    expect(String(ref.attachmentId)).toBe(`sha256:${sha256}`)
    expect(join(storageRoot, 'objects', sha256.slice(0, 2), sha256))
      .toBe(join(storageRoot, 'objects', String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 2), sha256))
  })

  it('rejects oversized files, non-text bytes, and unusable names', async () => {
    const storageRoot = await root()
    await expect(saveTextFile(storageRoot, { data: utf8('x'.repeat(2000)), name: 'big.txt' }, FILE_LIMITS))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    await expect(saveTextFile(storageRoot, { data: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x00), name: 'x.png' }, FILE_LIMITS))
      .rejects.toMatchObject({ code: 'NOT_TEXT_FILE' })
    await expect(saveTextFile(storageRoot, { data: utf8('hi'), name: ' ' }, FILE_LIMITS))
      .rejects.toMatchObject({ code: 'INVALID_FILE_NAME' })
  })

  it('fails closed when a file object is missing, corrupted, or addressed by an invalid reference', async () => {
    const storageRoot = await root()
    const ref = await saveTextFile(storageRoot, { data: utf8('verify me'), name: 'notes.txt' }, FILE_LIMITS)
    const sha256 = String(ref.attachmentId).slice('sha256:'.length)
    const object = join(storageRoot, 'objects', sha256.slice(0, 2), sha256)
    await chmod(object, 0o600)
    await writeFile(object, utf8('tampered'))
    await expect(readTextFile(storageRoot, ref)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
    await expect(readTextFile(storageRoot, { ...ref, attachmentId: 'bad' as never }))
      .rejects.toMatchObject({ code: 'INVALID_ATTACHMENT_REF' })

    const missingRoot = await root()
    await mkdir(missingRoot, { recursive: true })
    await expect(readTextFile(missingRoot, ref)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })

    const unreadableRoot = await root()
    const otherSha256 = createHash('sha256').update(utf8('unreadable')).digest('hex')
    const target = join(unreadableRoot, 'objects', otherSha256.slice(0, 2), otherSha256)
    await mkdir(target, { recursive: true })
    await expect(readTextFile(unreadableRoot, { ...ref, attachmentId: `sha256:${otherSha256}` as never }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_READ_FAILED' })
  })

  it('rejects prepared bytes that no longer match their content-addressed reference', async () => {
    const storageRoot = await root()
    const prepared = await prepareTextFile({ data: utf8('hello'), name: 'notes.txt' }, FILE_LIMITS)

    await expect(commitPreparedTextFile(storageRoot, {
      ...prepared,
      data: Uint8Array.of(...prepared.data, 0x21),
    })).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
  })

  it('rejects a reference whose declared byte count no longer matches the digest-verified object', async () => {
    const storageRoot = await root()
    const ref = await saveTextFile(storageRoot, { data: utf8('hello'), name: 'notes.txt' }, FILE_LIMITS)

    await expect(readTextFile(storageRoot, { ...ref, bytes: ref.bytes + 1 }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
  })
})
