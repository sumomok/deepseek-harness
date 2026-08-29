// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type {
  ComposerAttachment, ComposerAttachmentsOwnerProps, ComposerAttachmentsProps,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ComposerAttachments } from '../src/client/ComposerAttachments.tsx'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const t = ((key: string, params?: Readonly<Record<string, unknown>>): string => {
  const messages: Record<string, string> = {
    'image.pending': '待发送图片',
    'image.original': '原图',
    'image.preview': '原图预览',
    'image.closePreview': '关闭原图预览',
    'image.openOriginal': '查看原图',
    'image.scrollLeft': '向左滚动图片',
    'image.scrollRight': '向右滚动图片',
    'image.dropBlocked': '当前无法添加图片',
    'image.dropTitle': '图片拖动到此处即可添加',
    'file.pending': '待发送文件',
  }
  if (key === 'image.remove') {
    const name = params?.name
    return `移除图片 ${typeof name === 'string' ? name : ''}`
  }
  if (key === 'file.remove') {
    const name = params?.name
    return `移除文件 ${typeof name === 'string' ? name : ''}`
  }
  if (key === 'image.dropDesc') {
    const count = params?.count
    const size = params?.size
    return `最多 ${typeof count === 'number' ? String(count) : ''} 张，每张 ${typeof size === 'string' ? size : ''}`
  }
  return messages[key] ?? key
}) as ComposerAttachmentsProps['t']

// Real PNG magic bytes: the composer's onDrop routes a batch through a
// content sniff (partitionDroppedFiles), and a lone non-NUL byte like
// Uint8Array.of(1) decodes as valid UTF-8 — indistinguishable from text.
// Only genuine binary leading bytes (0x89 is not a valid UTF-8 lead byte)
// keep the sniff routing an "image" fixture to the image path.
const PNG_MAGIC = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function attachment(id: string, name = `${id}.png`): ComposerAttachment {
  return {
    kind: 'image',
    id: id as ComposerAttachment['id'],
    file: new File([PNG_MAGIC], name, { type: 'image/png' }),
    previewUrl: `blob:${id}`,
  }
}

function textAttachment(id: string, name = `${id}.txt`, text = 'hello'): ComposerAttachment {
  return {
    kind: 'file',
    id: id as ComposerAttachment['id'],
    file: new File([text], name, { type: 'text/plain' }),
  }
}

function props(overrides: Partial<ComposerAttachmentsOwnerProps> = {}): ComposerAttachmentsProps {
  return {
    attachments: [],
    canAcceptDrop: true,
    onAddImages: () => {},
    onAddFiles: () => {},
    onRemoveImage: () => {},
    t,
    ...overrides,
  } as unknown as ComposerAttachmentsProps
}

describe('ComposerAttachments', () => {
  it('accepts file drops anywhere on the document and keeps non-file drags native', async () => {
    const onAddImages = vi.fn()
    const view = render(<ComposerAttachments {...props({
      onAddImages,
      dropLimits: { count: 20, size: '5MB' },
    })} />)

    expect(fireEvent.dragEnter(document.body, { dataTransfer: null })).toBe(true)
    const textTransfer = { types: ['text/plain'], files: [], dropEffect: 'none' }
    expect(fireEvent.dragEnter(document.body, { dataTransfer: textTransfer })).toBe(true)
    expect(fireEvent.dragOver(document.body, { dataTransfer: textTransfer })).toBe(true)
    expect(fireEvent.drop(document.body, { dataTransfer: textTransfer })).toBe(true)
    expect(view.queryByRole('status')).toBeNull()

    const image = attachment('dropped').file
    const dataTransfer = { types: ['Files'], files: [image], dropEffect: 'none' }
    expect(fireEvent.dragEnter(document.body, { dataTransfer })).toBe(false)
    expect(view.getByRole('status').textContent).toContain('图片拖动到此处即可添加')
    expect(view.getByRole('status').textContent).toContain('最多 20 张，每张 5MB')
    expect(fireEvent.dragOver(document.body, { dataTransfer })).toBe(false)
    expect(dataTransfer.dropEffect).toBe('copy')
    expect(fireEvent.drop(document.body, { dataTransfer })).toBe(false)
    // The drop's content sniff (partitionDroppedFiles) resolves after a
    // microtask; onAddImages fires once that split completes.
    await waitFor(() => { expect(onAddImages).toHaveBeenCalledWith([image]) })
    expect(view.queryByRole('status')).toBeNull()
  })

  it('routes a text-sniffable dropped file to onAddFiles instead of onAddImages', async () => {
    const onAddImages = vi.fn()
    const onAddFiles = vi.fn()
    render(<ComposerAttachments {...props({ onAddImages, onAddFiles })} />)
    const file = textAttachment('dropped-text').file
    const dataTransfer = { types: ['Files'], files: [file], dropEffect: 'none' }
    fireEvent.dragEnter(document.body, { dataTransfer })
    fireEvent.drop(document.body, { dataTransfer })
    await waitFor(() => { expect(onAddFiles).toHaveBeenCalledWith([file]) })
    expect(onAddImages).not.toHaveBeenCalled()
  })

  it('splits one mixed drop batch between onAddImages and onAddFiles', async () => {
    const onAddImages = vi.fn()
    const onAddFiles = vi.fn()
    render(<ComposerAttachments {...props({ onAddImages, onAddFiles })} />)
    const image = attachment('mixed-image').file
    const file = textAttachment('mixed-text').file
    const dataTransfer = { types: ['Files'], files: [image, file], dropEffect: 'none' }
    fireEvent.dragEnter(document.body, { dataTransfer })
    fireEvent.drop(document.body, { dataTransfer })
    await waitFor(() => {
      expect(onAddImages).toHaveBeenCalledWith([image])
      expect(onAddFiles).toHaveBeenCalledWith([file])
    })
  })

  it('tracks nested file drags and clears an aborted drag', () => {
    const view = render(<ComposerAttachments {...props()} />)
    const dataTransfer = { types: ['Files'], files: [], dropEffect: 'none' }
    fireEvent.dragLeave(document.body, {
      dataTransfer: { types: ['text/plain'], files: [], dropEffect: 'none' },
    })
    fireEvent.dragEnter(document.body, { dataTransfer })
    fireEvent.dragEnter(document.body, { dataTransfer })
    fireEvent.dragLeave(document.body, { dataTransfer, clientX: 5, clientY: 5 })
    expect(view.getByRole('status')).toBeTruthy()
    fireEvent.dragLeave(document.body, { dataTransfer, clientX: 5, clientY: 5 })
    expect(view.queryByRole('status')).toBeNull()
    fireEvent.dragEnter(document.documentElement, { dataTransfer })
    const leftViewport = new Event('dragleave', { bubbles: true, cancelable: true })
    Object.defineProperties(leftViewport, {
      dataTransfer: { value: dataTransfer },
      clientX: { value: -1 },
      clientY: { value: 5 },
    })
    fireEvent(document.documentElement, leftViewport)
    expect(view.queryByRole('status')).toBeNull()
    fireEvent.dragEnter(document.body, { dataTransfer })
    fireEvent.dragEnd(window, { dataTransfer })
    expect(view.queryByRole('status')).toBeNull()
  })

  it('shows a blocked drop without forwarding its files', () => {
    const onAddImages = vi.fn()
    const view = render(<ComposerAttachments {...props({ canAcceptDrop: false, onAddImages })} />)
    const image = attachment('blocked').file
    const dataTransfer = { types: ['Files'], files: [image], dropEffect: 'copy' }
    fireEvent.dragEnter(document.body, { dataTransfer })
    expect(view.getByRole('status').textContent).toBe('当前无法添加图片')
    fireEvent.dragOver(document.body, { dataTransfer })
    expect(dataTransfer.dropEffect).toBe('none')
    fireEvent.drop(document.body, { dataTransfer })
    expect(onAddImages).not.toHaveBeenCalled()
    expect(view.queryByRole('status')).toBeNull()
  })

  it('routes rail removal and closes previews on Escape or attachment removal', () => {
    const onRemoveImage = vi.fn()
    const image = attachment('draft-1', 'pixel.png')
    const initial = props({ attachments: [image], onRemoveImage })
    const view = render(<ComposerAttachments {...initial} />)

    fireEvent.click(view.getByRole('button', { name: '移除图片 pixel.png' }))
    expect(onRemoveImage).toHaveBeenCalledWith(image.id)
    fireEvent.click(view.getByTitle('查看原图'))
    expect(view.getByRole('dialog', { name: '原图预览' })).toBeTruthy()
    view.rerender(<ComposerAttachments {...props({ attachments: [], onRemoveImage })} />)
    expect(view.queryByRole('dialog', { name: '原图预览' })).toBeNull()

    view.rerender(<ComposerAttachments {...initial} />)
    fireEvent.click(view.getByTitle('查看原图'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(view.queryByRole('dialog', { name: '原图预览' })).toBeNull()
  })

  it('labels an unnamed attachment and its original-image preview', () => {
    const image = attachment('unnamed', '')
    const view = render(<ComposerAttachments {...props({ attachments: [image] })} />)
    expect(view.getByAltText('待发送图片')).toBeTruthy()
    fireEvent.click(view.getByTitle('查看原图'))
    expect(view.getByAltText('原图')).toBeTruthy()
  })

  it('renders a file draft as a name+size chip beside the image rail and routes its removal', () => {
    const onRemoveImage = vi.fn()
    const image = attachment('draft-1', 'pixel.png')
    const file = textAttachment('draft-2', 'notes.txt', 'hello world')
    const view = render(<ComposerAttachments {...props({ attachments: [image, file], onRemoveImage })} />)

    expect(view.getByText('notes.txt')).toBeTruthy()
    expect(view.getByText('0.0MB')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '移除文件 notes.txt' }))
    expect(onRemoveImage).toHaveBeenCalledWith(file.id)
    // The image rail is unaffected by the file chip's presence.
    expect(view.getByRole('button', { name: '移除图片 pixel.png' })).toBeTruthy()
  })

  it('labels an unnamed file draft with the pending-files fallback', () => {
    const file = textAttachment('draft-3', '')
    const view = render(<ComposerAttachments {...props({ attachments: [file] })} />)
    expect(view.getByText('待发送文件')).toBeTruthy()
  })

  it('marks a file chip in secretContainerHitIds with the warning visual, and no other chip', () => {
    const hit = textAttachment('draft-4', '.env', 'SECRET=1')
    const plain = textAttachment('draft-5', 'notes.txt', 'hello')
    const view = render(<ComposerAttachments {...props({
      attachments: [hit, plain],
      secretContainerHitIds: new Set([hit.id]),
    })} />)
    const warned = view.container.querySelector('[data-secret-warning]')
    expect(warned?.textContent).toContain('.env')
    expect(view.container.querySelectorAll('[data-secret-warning]')).toHaveLength(1)
  })

  it('omits the warning visual entirely when secretContainerHitIds is absent', () => {
    const file = textAttachment('draft-6', '.env', 'SECRET=1')
    const view = render(<ComposerAttachments {...props({ attachments: [file] })} />)
    expect(view.container.querySelector('[data-secret-warning]')).toBeNull()
  })
})
