import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import AttachmentStore, {
  AttachmentError,
  AttachmentId,
  ImageVariantId,
  isFileAdmissionError,
  isImageAdmissionError,
  type FileAttachmentRef,
  type ImageAttachmentRef,
  type ImageMediaType,
  type ImageRequestPolicy,
  type RequestImageAttachment,
  type SaveFileAttachment,
  type SaveImageAttachment,
  type StoredFileAttachment,
  type StoredImageAttachment,
} from '../src/index.ts'

const LIMITS = {
  maxImageBytes: 4,
  maxImagesPerMessage: 2,
  maxMessageImageBytes: 5,
  maxImagePixels: 4,
  maxImageDimension: 2000,
  mediaTypes: ['image/png'] as const,
}

const FILE_LIMITS = {
  maxFileBytes: 4,
  maxFilesPerMessage: 2,
  maxMessageFileBytes: 5,
}

class RecordingStore extends AttachmentStore {
  readonly imageLimits = LIMITS
  readonly fileLimits = FILE_LIMITS
  readonly calls: string[] = []
  rejectValidationAt: number | undefined
  rejectSaveAt: number | undefined
  fileRejectValidationAt: number | undefined
  fileRejectSaveAt: number | undefined

  async validateImage(input: SaveImageAttachment): Promise<void> {
    const value = input.data[0] ?? 0
    this.calls.push(`validate:${value}`)
    if (value === this.rejectValidationAt) throw new Error(`invalid:${value}`)
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    const value = input.data[0] ?? 0
    this.calls.push(`save:${value}`)
    if (value === this.rejectSaveAt) throw new Error(`write:${value}`)
    return {
      attachmentId: AttachmentId(`sha256:${String(value).padStart(64, '0')}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...input.name === undefined ? {} : { name: input.name },
    }
  }

  readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    throw new Error('not used')
  }

  async validateFile(input: SaveFileAttachment): Promise<void> {
    const value = input.data[0] ?? 0
    this.calls.push(`file-validate:${value}`)
    if (value === this.fileRejectValidationAt) throw new Error(`file-invalid:${value}`)
  }

  async saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> {
    const value = input.data[0] ?? 0
    this.calls.push(`file-save:${value}`)
    if (value === this.fileRejectSaveAt) throw new Error(`file-write:${value}`)
    return { attachmentId: AttachmentId(`sha256:${String(value).padStart(64, '0')}`), name: input.name, bytes: input.data.byteLength }
  }

  readFile(_ref: FileAttachmentRef): Promise<StoredFileAttachment> {
    throw new Error('not used')
  }

  override readImageRequest(
    ref: ImageAttachmentRef,
    _policy: ImageRequestPolicy,
  ): Promise<RequestImageAttachment> {
    this.calls.push(`request:${ref.name}`)
    return Promise.resolve({
      variantId: ImageVariantId(`sha256:${String(ref.bytes).padStart(64, '0')}`),
      attachment: ref,
      data: Uint8Array.of(ref.bytes),
      mediaType: ref.mediaType,
      bytes: 1,
      width: ref.width,
      height: ref.height,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: false,
    })
  }
}

class UnsupportedProjectionStore extends AttachmentStore {
  readonly imageLimits = LIMITS
  readonly fileLimits = FILE_LIMITS

  validateImage(): Promise<void> {
    return Promise.resolve()
  }

  saveImage(): Promise<ImageAttachmentRef> {
    throw new Error('not used')
  }

  readImage(): Promise<StoredImageAttachment> {
    throw new Error('not used')
  }

  validateFile(): Promise<void> {
    throw new Error('not used')
  }

  saveFile(): Promise<FileAttachmentRef> {
    throw new Error('not used')
  }

  readFile(): Promise<StoredFileAttachment> {
    throw new Error('not used')
  }
}

function image(value: number, mediaType: ImageMediaType = 'image/png'): SaveImageAttachment {
  return { data: Uint8Array.of(value), mediaType, name: `${value}.png` }
}

describe('AttachmentStore.saveImages', () => {
  it('validates the complete batch before saving in input order', async () => {
    const store = new RecordingStore(new Context())

    const refs = await store.saveImages([image(1), image(2)])

    expect(store.calls).toEqual(['validate:1', 'validate:2', 'save:1', 'save:2'])
    expect(refs.map(ref => ref.name)).toEqual(['1.png', '2.png'])
  })

  it('rejects count, aggregate bytes, and deployment media types before validation', async () => {
    const store = new RecordingStore(new Context())

    await expect(store.saveImages([image(1), image(2), image(3)]))
      .rejects.toMatchObject({ code: 'TOO_MANY_IMAGES' })
    await expect(store.saveImages([
      { data: Uint8Array.of(1, 2, 3), mediaType: 'image/png' },
      { data: Uint8Array.of(4, 5, 6), mediaType: 'image/png' },
    ])).rejects.toMatchObject({ code: 'IMAGES_TOO_LARGE' })
    await expect(store.saveImages([image(1, 'image/jpeg')]))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE_TYPE' })
    expect(store.calls).toEqual([])
  })

  it('starts no writes when any member fails validation', async () => {
    const store = new RecordingStore(new Context())
    store.rejectValidationAt = 2

    await expect(store.saveImages([image(1), image(2)]))
      .rejects.toThrow('invalid:2')
    expect(store.calls).toEqual(['validate:1', 'validate:2'])
  })

  it('returns no partial references when storage fails after an earlier commit', async () => {
    const store = new RecordingStore(new Context())
    store.rejectSaveAt = 2

    await expect(store.saveImages([image(1), image(2)]))
      .rejects.toThrow('write:2')
    expect(store.calls).toEqual(['validate:1', 'validate:2', 'save:1', 'save:2'])
  })
})

describe('AttachmentStore.readImageRequest', () => {
  it('reports unsupported request projection while preserving cancellation', async () => {
    const store = new UnsupportedProjectionStore(new Context())
    const ref = await new RecordingStore(new Context()).saveImage(image(1))
    await expect(store.readImageRequest(ref, { maxPixels: 1, maxBytes: 1 }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_PROJECTION_UNSUPPORTED' })
    const controller = new AbortController()
    const reason = new Error('cancel unsupported projection')
    controller.abort(reason)
    expect(() => store.readImageRequest(ref, { maxPixels: 1, maxBytes: 1 }, controller.signal)).toThrow(reason)
  })

  it('exposes no provider-owned host path by default', async () => {
    const store = new RecordingStore(new Context())
    const ref = await store.saveImage(image(1))
    expect(store.imageHostPath(ref)).toBeUndefined()
  })
})

describe('isImageAdmissionError', () => {
  it('separates caller-correctable image admission failures from storage faults', () => {
    expect(isImageAdmissionError(new AttachmentError('bad bytes', 'INVALID_IMAGE'))).toBe(true)
    expect(isImageAdmissionError(new AttachmentError('bad base64', 'INVALID_IMAGE_BASE64'))).toBe(true)
    expect(isImageAdmissionError(new AttachmentError('too many', 'TOO_MANY_IMAGES'))).toBe(true)
    expect(isImageAdmissionError(Object.assign(new Error('foreign policy error'), { code: 'IMAGE_TOO_LARGE' }))).toBe(true)
    expect(isImageAdmissionError(new AttachmentError('corrupt object', 'ATTACHMENT_CORRUPT'))).toBe(false)
    expect(isImageAdmissionError(new AttachmentError('disk failed', 'ATTACHMENT_WRITE_FAILED'))).toBe(false)
    expect(isImageAdmissionError(new Error('unknown failure'))).toBe(false)
  })
})

function file(value: number): SaveFileAttachment {
  return { data: Uint8Array.of(value), name: `${value}.txt` }
}

describe('AttachmentStore.saveFiles', () => {
  it('validates the complete batch before saving in input order', async () => {
    const store = new RecordingStore(new Context())

    const refs = await store.saveFiles([file(1), file(2)])

    expect(store.calls).toEqual(['file-validate:1', 'file-validate:2', 'file-save:1', 'file-save:2'])
    expect(refs.map(ref => ref.name)).toEqual(['1.txt', '2.txt'])
  })

  it('rejects count and aggregate bytes before validation', async () => {
    const store = new RecordingStore(new Context())

    await expect(store.saveFiles([file(1), file(2), file(3)]))
      .rejects.toMatchObject({ code: 'TOO_MANY_FILES' })
    await expect(store.saveFiles([
      { data: Uint8Array.of(1, 2, 3), name: 'a.txt' },
      { data: Uint8Array.of(4, 5, 6), name: 'b.txt' },
    ])).rejects.toMatchObject({ code: 'FILES_TOO_LARGE' })
    expect(store.calls).toEqual([])
  })

  it('starts no writes when any member fails validation', async () => {
    const store = new RecordingStore(new Context())
    store.fileRejectValidationAt = 2

    await expect(store.saveFiles([file(1), file(2)])).rejects.toThrow('file-invalid:2')
    expect(store.calls).toEqual(['file-validate:1', 'file-validate:2'])
  })

  it('returns no partial references when storage fails after an earlier commit', async () => {
    const store = new RecordingStore(new Context())
    store.fileRejectSaveAt = 2

    await expect(store.saveFiles([file(1), file(2)])).rejects.toThrow('file-write:2')
    expect(store.calls).toEqual(['file-validate:1', 'file-validate:2', 'file-save:1', 'file-save:2'])
  })
})

describe('isFileAdmissionError', () => {
  it('separates caller-correctable file admission failures from storage faults', () => {
    expect(isFileAdmissionError(new AttachmentError('not text', 'NOT_TEXT_FILE'))).toBe(true)
    expect(isFileAdmissionError(new AttachmentError('too many', 'TOO_MANY_FILES'))).toBe(true)
    expect(isFileAdmissionError(Object.assign(new Error('foreign policy error'), { code: 'FILE_TOO_LARGE' }))).toBe(true)
    expect(isFileAdmissionError(new AttachmentError('corrupt object', 'ATTACHMENT_CORRUPT'))).toBe(false)
    expect(isFileAdmissionError(new AttachmentError('disk failed', 'ATTACHMENT_WRITE_FAILED'))).toBe(false)
    expect(isFileAdmissionError(new Error('unknown failure'))).toBe(false)
  })
})
