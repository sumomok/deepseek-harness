// @vitest-environment jsdom
// Conversation-owned attachment errors and the message-image slot handoff.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import type { AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'
import type { RenderMessageImages } from '../src/client/contract/slots.ts'
import { attachmentErrorText, attachmentSizeText } from '../src/client/attachment-labels.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)
const enT = makeTranslate(en, commonZh)

const attachment = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png' as const,
  bytes: 68,
  width: 640,
  height: 320,
  name: 'history.png',
}

type MessageImagesRenderOwner = Parameters<RenderMessageImages>[0]

const loadFile: AssistantMarkdownProps['loadFile'] = () => Promise.reject(new Error('loadFile not stubbed'))
const openReferent: AssistantMarkdownProps['openReferent'] = () => Promise.resolve()

function imageRenderer(calls: MessageImagesRenderOwner[]): RenderMessageImages {
  return (owner) => {
    calls.push(owner)
    return (
      <div data-testid="message-images" data-align={owner.align} data-count={owner.images.length}>
        {owner.images.map(({ attachment: image }, index) => (
          <span key={`${image.attachmentId}:${String(index)}`}>{image.name}</span>
        ))}
      </div>
    )
  }
}

describe('attachment rejection copy', () => {
  const limits = {
    maxImageBytes: 5 * 1024 * 1024,
    maxImagesPerMessage: 20,
    maxMessageImageBytes: 100 * 1024 * 1024,
    maxImagePixels: 40_000_000,
    maxImageDimension: 2000,
    mediaTypes: ['image/png'] as const,
  }

  it('picks bytes, kilobytes, or megabytes by magnitude, dropping a trailing fraction unless one exists', () => {
    expect(attachmentSizeText(0)).toBe('0 B')
    expect(attachmentSizeText(11)).toBe('11 B')
    expect(attachmentSizeText(1023)).toBe('1023 B')
    expect(attachmentSizeText(1024)).toBe('1 KB')
    expect(attachmentSizeText(512 * 1024)).toBe('512 KB')
    expect(attachmentSizeText(1024 * 1024 - 1)).toBe('1024 KB')
    expect(attachmentSizeText(10 * 1024 * 1024)).toBe('10 MB')
    expect(attachmentSizeText(2.5 * 1024 * 1024)).toBe('2.5 MB')
  })

  it('maps user-solvable reasons to limit-naming copy', () => {
    expect(attachmentErrorText(t, 'MODEL_DOES_NOT_SUPPORT_IMAGES')).toBe('当前模型不支持图片，请切换支持图片的模型')
    expect(attachmentErrorText(t, 'SUBAGENT_IMAGE_UNSUPPORTED')).toBe('子智能体会话暂不支持图片')
    expect(attachmentErrorText(t, 'IMAGE_TOO_MANY_PIXELS')).toBe('图片分辨率过大，请压缩后重试')
    expect(attachmentErrorText(t, 'INVALID_IMAGE')).toBe('仅支持 PNG、JPG、WebP、GIF 格式的图片')
    expect(attachmentErrorText(t, 'IMAGE_TYPE_MISMATCH')).toBe('仅支持 PNG、JPG、WebP、GIF 格式的图片')
    expect(attachmentErrorText(t, 'TOO_MANY_IMAGES', limits)).toBe('一条消息最多添加 20 张图片')
    expect(attachmentErrorText(t, 'IMAGE_TOO_LARGE', limits)).toBe('单张图片不能超过 5 MB')
    expect(attachmentErrorText(t, 'IMAGES_TOO_LARGE', limits)).toBe('图片总大小超过 100 MB，请移除部分图片')
    expect(attachmentErrorText(t, 'IMAGE_DIMENSION_TOO_LARGE', limits)).toBe('图片宽高不能超过 2000px，请缩小后重试')
    expect(attachmentErrorText(enT, 'TOO_MANY_IMAGES', limits)).toBe('A message can include up to 20 images')
  })

  it('folds unknown reasons and limit reasons without projected limits into the send-failed line', () => {
    expect(attachmentErrorText(t, 'INVALID_IMAGE_BASE64')).toBe('图片发送失败（INVALID_IMAGE_BASE64），请重新添加图片后再试')
    expect(attachmentErrorText(t, 'TOO_MANY_IMAGES')).toBe('图片发送失败（TOO_MANY_IMAGES），请重新添加图片后再试')
    expect(attachmentErrorText(t, 'IMAGE_TOO_LARGE')).toBe('图片发送失败（IMAGE_TOO_LARGE），请重新添加图片后再试')
    expect(attachmentErrorText(t, 'IMAGES_TOO_LARGE')).toBe('图片发送失败（IMAGES_TOO_LARGE），请重新添加图片后再试')
    expect(attachmentErrorText(t, 'IMAGE_DIMENSION_TOO_LARGE')).toBe('图片发送失败（IMAGE_DIMENSION_TOO_LARGE），请重新添加图片后再试')
  })

  const fileLimits = {
    maxFilesPerMessage: 10,
    maxMessageFileBytes: 10 * 1024 * 1024,
    maxFileBytes: 1024 * 1024,
  }

  it('maps user-solvable file reasons to limit-naming copy', () => {
    expect(attachmentErrorText(t, 'NOT_TEXT_FILE')).toBe('仅支持文本文件')
    expect(attachmentErrorText(t, 'INVALID_FILE_NAME')).toBe('文件名无效，请重命名后重试')
    expect(attachmentErrorText(t, 'TOO_MANY_FILES', undefined, fileLimits)).toBe('一条消息最多添加 10 个文件')
    expect(attachmentErrorText(t, 'FILE_TOO_LARGE', undefined, fileLimits)).toBe('单个文件不能超过 1 MB')
    expect(attachmentErrorText(t, 'FILES_TOO_LARGE', undefined, fileLimits)).toBe('文件总大小超过 10 MB，请移除部分文件')
    expect(attachmentErrorText(enT, 'TOO_MANY_FILES', undefined, fileLimits)).toBe('A message can include up to 10 files')
    expect(attachmentErrorText(t, 'SUBAGENT_FILE_UNSUPPORTED')).toBe('子智能体会话暂不支持文件')
    expect(attachmentErrorText(enT, 'SUBAGENT_FILE_UNSUPPORTED')).toBe('Subagent sessions do not support files yet')
  })

  it('folds file limit reasons without projected file limits into the send-failed line', () => {
    expect(attachmentErrorText(t, 'TOO_MANY_FILES')).toBe('图片发送失败（TOO_MANY_FILES），请重新添加图片后再试')
    expect(attachmentErrorText(t, 'FILE_TOO_LARGE')).toBe('图片发送失败（FILE_TOO_LARGE），请重新添加图片后再试')
    expect(attachmentErrorText(t, 'FILES_TOO_LARGE')).toBe('图片发送失败（FILES_TOO_LARGE），请重新添加图片后再试')
  })
})

describe('assistant image slot handoff', () => {
  it('passes one image group and its message alignment to the renderer', () => {
    const calls: MessageImagesRenderOwner[] = []
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'image', attachment }]}
        streaming={false}
        renderMessageImages={imageRenderer(calls)}
        loadFile={loadFile}
        openReferent={openReferent}
      />,
    )
    expect(view.getByTestId('message-images').getAttribute('data-align')).toBe('start')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.images).toEqual([{ attachment }])
  })

  it('merges consecutive image blocks into one group and splits groups at text', () => {
    const calls: MessageImagesRenderOwner[] = []
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[
          { kind: 'image', attachment },
          { kind: 'image', attachment },
          { kind: 'text', text: 'between' },
          { kind: 'image', attachment },
        ]}
        streaming={false}
        renderMessageImages={imageRenderer(calls)}
        loadFile={loadFile}
        openReferent={openReferent}
      />,
    )
    const galleries = view.getAllByTestId('message-images')
    expect(galleries).toHaveLength(2)
    expect(galleries.map(gallery => gallery.getAttribute('data-count'))).toEqual(['2', '1'])
    expect(calls.map(call => call.images.length)).toEqual([2, 1])
  })

  it('keeps the renderer output at the image block position between text blocks', () => {
    const calls: MessageImagesRenderOwner[] = []
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[
          { kind: 'text', text: 'before' },
          { kind: 'image', attachment },
          { kind: 'text', text: 'after' },
        ]}
        streaming={false}
        renderMessageImages={imageRenderer(calls)}
        loadFile={loadFile}
        openReferent={openReferent}
      />,
    )
    const image = view.getByTestId('message-images')
    const before = view.getByText('before')
    const after = view.getByText('after')
    expect(before.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(image.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })
})
