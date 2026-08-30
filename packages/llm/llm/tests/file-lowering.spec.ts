import { describe, expect, it } from 'vitest'
import AttachmentStore, { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  FileAttachmentLimits, FileAttachmentRef, ImageAttachmentLimits, ImageAttachmentRef,
  StoredFileAttachment, StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  contentHasFile,
  createUserMessage,
  DEFAULT_MAX_LOWERED_FILE_CHARS,
  lowerFileBlocks,
  lowerFileBlocksFromStore,
  lowerFileBlockText,
  lowerSpilledFileBlockText,
} from '../src/index.ts'
import type { ContentBlock, FileSpillOptions, LoweredFileSpillRef } from '../src/index.ts'

const source = { kind: 'plugin' as const, plugin: 'test' }

function fileRef(name: string, bytes: number): FileAttachmentRef {
  return { attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`), name, bytes }
}

function fileBlock(name: string, bytes: number): ContentBlock {
  return { type: 'file', attachment: fileRef(name, bytes) }
}

describe('lowerFileBlockText', () => {
  it('tags the fence with the lowercased extension', () => {
    expect(lowerFileBlockText('app.py', 'print(1)', 8)).toBe(
      'File app.py (8 B):\n```py\nprint(1)\n```',
    )
    expect(lowerFileBlockText('Component.TSX', 'x', 1)).toBe(
      'File Component.TSX (1 B):\n```tsx\nx\n```',
    )
  })

  it('fences bare for a listed prose/log extension', () => {
    expect(lowerFileBlockText('notes.txt', 'hello', 5)).toBe(
      'File notes.txt (5 B):\n```\nhello\n```',
    )
    expect(lowerFileBlockText('server.log', 'boot', 4)).toBe(
      'File server.log (4 B):\n```\nboot\n```',
    )
  })

  it('fences bare with no extension at all', () => {
    expect(lowerFileBlockText('Makefile', 'all:', 4)).toBe(
      'File Makefile (4 B):\n```\nall:\n```',
    )
  })

  it('fences bare on a trailing dot with nothing after it', () => {
    expect(lowerFileBlockText('weird.', 'x', 1)).toBe(
      'File weird. (1 B):\n```\nx\n```',
    )
  })

  it('lengthens the fence past a triple-backtick run already in the content', () => {
    const text = 'see:\n```\ncode\n```'
    const block = lowerFileBlockText('notes.md', text, 17)
    expect(block).toContain('````md')
    expect(block.endsWith('````')).toBe(true)
  })

  it('lengthens past whichever backtick run is longest, not just the first', () => {
    const text = '```\n`````\n```'
    const block = lowerFileBlockText('mixed.txt', text, 14)
    expect(block.split('\n')[1]).toBe('``````')
  })

  it('shows whole bytes under 1 KB', () => {
    expect(lowerFileBlockText('a.txt', 'x', 0)).toContain('(0 B):')
    expect(lowerFileBlockText('a.txt', 'x', 1023)).toContain('(1023 B):')
  })

  it('shows one decimal of KB under 1 MB', () => {
    expect(lowerFileBlockText('a.txt', 'x', 1024)).toContain('(1.0 KB):')
    expect(lowerFileBlockText('a.txt', 'x', 2150)).toContain('(2.1 KB):')
  })

  it('shows one decimal of MB at and above 1 MB', () => {
    expect(lowerFileBlockText('a.txt', 'x', 1024 * 1024)).toContain('(1.0 MB):')
    expect(lowerFileBlockText('a.txt', 'x', 5 * 1024 * 1024)).toContain('(5.0 MB):')
  })

  it('keeps a text at or below the cap unchanged with no truncation note', () => {
    const block = lowerFileBlockText('a.txt', 'short', 5, 5)
    expect(block).toBe('File a.txt (5 B):\n```\nshort\n```')
  })

  it('caps a longer text and appends the truncation note outside the fenced content', () => {
    const block = lowerFileBlockText('a.txt', 'abcdef', 6, 4)
    expect(block).toBe('File a.txt (6 B):\n```\nabcd\n```\n…(truncated, 6 chars total)')
  })

  it('counts code points, not UTF-16 units, so a cap never splits an emoji', () => {
    const block = lowerFileBlockText('a.txt', '🙂🙂🙂', 12, 2)
    expect(block).toBe('File a.txt (12 B):\n```\n🙂🙂\n```\n…(truncated, 3 chars total)')
  })

  it('defaults the cap to DEFAULT_MAX_LOWERED_FILE_CHARS when unspecified', () => {
    const text = 'x'.repeat(DEFAULT_MAX_LOWERED_FILE_CHARS + 1)
    const block = lowerFileBlockText('big.log', text, text.length)
    expect(block).toContain(`…(truncated, ${String(DEFAULT_MAX_LOWERED_FILE_CHARS + 1)} chars total)`)
  })
})

describe('lowerSpilledFileBlockText', () => {
  const ref: LoweredFileSpillRef = { locator: '/spill/session-abc/xyz-notes.md', retrievalHint: 'Use read with offset/limit, or grep this path to search within it.' }

  it('renders the locator line, a fenced preview, and a preview-size note', () => {
    const block = lowerSpilledFileBlockText('notes.md', 'abcdefghij', 10, 4, ref)
    expect(block).toBe(
      'File notes.md (10 B, 10 chars) stored at: /spill/session-abc/xyz-notes.md. '
      + 'Use read with offset/limit, or grep this path to search within it.\n'
      + '```md\nabcd\n```\n(preview: first 4 of 10 chars)',
    )
  })

  it('shows the whole text as the preview when previewChars exceeds the total', () => {
    const block = lowerSpilledFileBlockText('a.txt', 'short', 5, 100, ref)
    expect(block).toContain('(preview: first 5 of 5 chars)')
    expect(block).toContain('```\nshort\n```')
  })

  it('counts code points, not UTF-16 units, for the preview cut and note', () => {
    const block = lowerSpilledFileBlockText('a.txt', '🙂🙂🙂', 12, 2, ref)
    expect(block).toContain('```\n🙂🙂\n```')
    expect(block).toContain('(preview: first 2 of 3 chars)')
  })

  it('lengthens the fence past a backtick run in the preview text', () => {
    const block = lowerSpilledFileBlockText('notes.md', '```\ncode\n```', 12, 100, ref)
    expect(block).toContain('````md')
  })
})

describe('lowerFileBlocks', () => {
  it('returns the original messages array unchanged when no message carries a file block', async () => {
    const messages = [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source })]
    const resolve = () => Promise.reject(new Error('must not be called'))
    expect(await lowerFileBlocks(messages, resolve)).toBe(messages)
  })

  it('replaces a top-level file block with its resolved text, leaving sibling blocks untouched', async () => {
    const messages = [createUserMessage({
      content: [{ type: 'text', text: 'see attached' }, fileBlock('a.txt', 3)],
      source,
    })]
    const resolved = await lowerFileBlocks(messages, ref => Promise.resolve(`lowered:${ref.name}`))
    expect(resolved[0]?.content).toEqual([
      { type: 'text', text: 'see attached' },
      { type: 'text', text: 'lowered:a.txt' },
    ])
  })

  it('replaces a file block nested inside a tool-result, preserving the tool-result envelope', async () => {
    const messages = [createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: CallId('call-1'),
        content: [fileBlock('nested.txt', 4)],
      }],
      source,
    })]
    const resolved = await lowerFileBlocks(messages, ref => Promise.resolve(`lowered:${ref.name}`))
    expect(resolved[0]?.content).toEqual([{
      type: 'tool-result',
      toolCallId: CallId('call-1'),
      content: [{ type: 'text', text: 'lowered:nested.txt' }],
    }])
  })

  it('leaves a tool-result with no nested file block unchanged', async () => {
    const untouched = {
      type: 'tool-result' as const,
      toolCallId: CallId('call-2'),
      content: [{ type: 'text' as const, text: 'kept' }],
    }
    const messages = [createUserMessage({ content: [untouched, fileBlock('a.txt', 1)], source })]
    const resolve = (ref: FileAttachmentRef) => Promise.resolve(`lowered:${ref.name}`)
    const resolved = await lowerFileBlocks(messages, resolve)
    expect(resolved[0]?.content).toEqual([untouched, { type: 'text', text: 'lowered:a.txt' }])
  })

  it('leaves a message with no file block untouched while lowering a sibling message that has one', async () => {
    const plain = createUserMessage({ content: [{ type: 'text', text: 'no attachment here' }], source })
    const withFile = createUserMessage({ content: [fileBlock('a.txt', 1)], source })
    const resolved = await lowerFileBlocks([plain, withFile], ref => Promise.resolve(`lowered:${ref.name}`))
    expect(resolved[0]).toBe(plain)
    expect(resolved[1]?.content).toEqual([{ type: 'text', text: 'lowered:a.txt' }])
  })
})

describe('contentHasFile', () => {
  it('is false for content with no file block, including a plain tool-result', () => {
    expect(contentHasFile([{ type: 'text', text: 'hi' }])).toBe(false)
    expect(contentHasFile([{
      type: 'tool-result', toolCallId: CallId('c'), content: [{ type: 'text', text: 'hi' }],
    }])).toBe(false)
  })

  it('is true for a top-level file block', () => {
    expect(contentHasFile([fileBlock('a.txt', 1)])).toBe(true)
  })

  it('is true for a file block nested inside a tool-result', () => {
    expect(contentHasFile([{
      type: 'tool-result', toolCallId: CallId('c'), content: [fileBlock('a.txt', 1)],
    }])).toBe(true)
  })
})

const IMAGE_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 1024,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 2048,
  maxImagePixels: 1024,
  maxImageDimension: 2000,
  mediaTypes: ['image/png'],
}

const FILE_LIMITS: FileAttachmentLimits = {
  maxFileBytes: 1024,
  maxFilesPerMessage: 4,
  maxMessageFileBytes: 2048,
}

/** In-memory attachment store: only `readFile` is exercised by this suite. */
class FakeAttachmentStore extends AttachmentStore {
  readonly imageLimits = IMAGE_LIMITS
  readonly fileLimits = FILE_LIMITS
  readonly objects = new Map<string, StoredFileAttachment>()

  put(name: string, text: string): FileAttachmentRef {
    const data = new TextEncoder().encode(text)
    const ref: FileAttachmentRef = { attachmentId: AttachmentId(`sha256:${name}`), name, bytes: data.byteLength }
    this.objects.set(ref.attachmentId, { ref, data })
    return ref
  }

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
    return Promise.resolve()
  }

  saveFile(): Promise<FileAttachmentRef> {
    throw new Error('not used')
  }

  readFile(ref: FileAttachmentRef): Promise<StoredFileAttachment> {
    const stored = this.objects.get(ref.attachmentId)
    if (stored === undefined) throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    return Promise.resolve(stored)
  }
}

describe('lowerFileBlocksFromStore', () => {
  it('returns the original messages array unchanged when no message carries a file block', async () => {
    const store = new FakeAttachmentStore(new Context())
    const messages = [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source })]
    expect(await lowerFileBlocksFromStore(messages, store)).toBe(messages)
  })

  it('reads the store and formats the result exactly like lowerFileBlockText', async () => {
    const store = new FakeAttachmentStore(new Context())
    const ref = store.put('notes.txt', 'line one')
    const messages = [createUserMessage({ content: [{ type: 'file', attachment: ref }], source })]
    const resolved = await lowerFileBlocksFromStore(messages, store)
    expect(resolved[0]?.content).toEqual([
      { type: 'text', text: lowerFileBlockText('notes.txt', 'line one', ref.bytes) },
    ])
  })

  it('rejects when the store cannot find the referenced object', async () => {
    const store = new FakeAttachmentStore(new Context())
    const ref = fileRef('missing.txt', 1)
    const messages = [createUserMessage({ content: [{ type: 'file', attachment: ref }], source })]
    await expect(lowerFileBlocksFromStore(messages, store)).rejects.toThrow(AttachmentError)
  })

  describe('with spill options', () => {
    const SPILL_REF: LoweredFileSpillRef = { locator: '/spill/session-abc/xyz-big.md', retrievalHint: 'Use read with offset/limit, or grep this path to search within it.' }

    it('keeps a file at or under inlineWholeUnderChars fully inline, never calling resolveSpill', async () => {
      const store = new FakeAttachmentStore(new Context())
      const ref = store.put('small.txt', 'hello')
      const messages = [createUserMessage({ content: [{ type: 'file', attachment: ref }], source })]
      const spill: FileSpillOptions = {
        inlineWholeUnderChars: 5,
        previewChars: 2,
        resolveSpill: () => Promise.reject(new Error('must not be called')),
      }
      const resolved = await lowerFileBlocksFromStore(messages, store, undefined, spill)
      expect(resolved[0]?.content).toEqual([
        { type: 'text', text: lowerFileBlockText('small.txt', 'hello', ref.bytes, 5) },
      ])
    })

    it('spills a file over inlineWholeUnderChars and renders the locator format', async () => {
      const store = new FakeAttachmentStore(new Context())
      const text = 'x'.repeat(20)
      const ref = store.put('big.md', text)
      const messages = [createUserMessage({ content: [{ type: 'file', attachment: ref }], source })]
      const spill: FileSpillOptions = {
        inlineWholeUnderChars: 10,
        previewChars: 4,
        resolveSpill: (attachment, content) => {
          expect(attachment).toEqual(ref)
          expect(content).toBe(text)
          return Promise.resolve(SPILL_REF)
        },
      }
      const resolved = await lowerFileBlocksFromStore(messages, store, undefined, spill)
      expect(resolved[0]?.content).toEqual([
        { type: 'text', text: lowerSpilledFileBlockText('big.md', text, ref.bytes, 4, SPILL_REF) },
      ])
    })

    it('falls back to truncated inline text when resolveSpill returns undefined', async () => {
      const store = new FakeAttachmentStore(new Context())
      const text = 'x'.repeat(20)
      const ref = store.put('big.md', text)
      const messages = [createUserMessage({ content: [{ type: 'file', attachment: ref }], source })]
      const spill: FileSpillOptions = {
        inlineWholeUnderChars: 10,
        previewChars: 4,
        resolveSpill: () => Promise.resolve(undefined),
      }
      const resolved = await lowerFileBlocksFromStore(messages, store, undefined, spill)
      expect(resolved[0]?.content).toEqual([
        { type: 'text', text: lowerFileBlockText('big.md', text, ref.bytes, 10) },
      ])
    })
  })
})
