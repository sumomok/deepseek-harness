// @vitest-environment jsdom
// Conversation-owned attachment errors (the message-image slot handoff and
// AssistantMarkdown moved to ui-chat with the component in the upstream
// package reorganization; this file keeps only the copy this package still
// owns: attachmentErrorText).

import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { attachmentErrorText } from '../src/client/attachment-labels.ts'
import { en, zh } from '../src/client/locales.ts'

const t = makeTranslate(zh, commonZh)
const enT = makeTranslate(en, commonZh)

describe('attachment rejection copy', () => {
  const limits = {
    maxImageBytes: 5 * 1024 * 1024,
    maxImagesPerMessage: 20,
    maxMessageImageBytes: 100 * 1024 * 1024,
    maxImagePixels: 40_000_000,
    maxImageDimension: 2000,
    mediaTypes: ['image/png'] as const,
  }

  it('maps user-solvable reasons to limit-naming copy', () => {
    expect(attachmentErrorText(t, 'MODEL_DOES_NOT_SUPPORT_IMAGES')).toBe('当前模型不支持图片，请切换支持图片的模型')
    expect(attachmentErrorText(t, 'IMAGE_TOO_MANY_PIXELS')).toBe('图片分辨率过大，请压缩后重试')
    expect(attachmentErrorText(t, 'INVALID_IMAGE')).toBe('仅支持 PNG、JPG、WebP、GIF 格式的图片')
    expect(attachmentErrorText(t, 'IMAGE_TYPE_MISMATCH')).toBe('仅支持 PNG、JPG、WebP、GIF 格式的图片')
    expect(attachmentErrorText(t, 'TOO_MANY_IMAGES', limits)).toBe('一条消息最多添加 20 张图片')
    expect(attachmentErrorText(t, 'IMAGE_TOO_LARGE', limits)).toBe('单张图片不能超过 5MB')
    expect(attachmentErrorText(t, 'IMAGES_TOO_LARGE', limits)).toBe('图片总大小超过 100MB，请移除部分图片')
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
    expect(attachmentErrorText(t, 'FILE_TOO_LARGE', undefined, fileLimits)).toBe('单个文件不能超过 1MB')
    expect(attachmentErrorText(t, 'FILES_TOO_LARGE', undefined, fileLimits)).toBe('文件总大小超过 10MB，请移除部分文件')
    expect(attachmentErrorText(enT, 'TOO_MANY_FILES', undefined, fileLimits)).toBe('A message can include up to 10 files')
  })

  it('folds file limit reasons without projected file limits into the send-failed line', () => {
    expect(attachmentErrorText(t, 'TOO_MANY_FILES')).toBe('图片发送失败（TOO_MANY_FILES），请重新添加图片后再试')
    expect(attachmentErrorText(t, 'FILE_TOO_LARGE')).toBe('图片发送失败（FILE_TOO_LARGE），请重新添加图片后再试')
    expect(attachmentErrorText(t, 'FILES_TOO_LARGE')).toBe('图片发送失败（FILES_TOO_LARGE），请重新添加图片后再试')
  })
})
