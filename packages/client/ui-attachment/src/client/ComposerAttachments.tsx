import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ComposerAttachment, ComposerAttachmentsProps, ComposerImageAttachment,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { attachmentSizeText, partitionDroppedFiles } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AttachmentRail } from '../AttachmentRail.tsx'
import type { AttachmentRailItem } from '../AttachmentRail.tsx'
import { DropOverlay } from '../DropOverlay.tsx'
import { FileChipRow } from '../FileChip.tsx'
import type { FileChipItem } from '../FileChip.tsx'
import { ImageLightbox } from '../ImageLightbox.tsx'
import {
  attachmentRailLabels, dropOverlayLabels, fileChipGroupLabel, lightboxLabels,
} from './labels.ts'
import css from './ComposerAttachments.module.css'

/** Rail item retaining its browser-owned image attachment for callbacks. */
interface ComposerRailItem extends AttachmentRailItem {
  attachment: ComposerImageAttachment
}

/** Chip item retaining its browser-owned file attachment for callbacks. */
interface ComposerChipItem extends FileChipItem {
  attachment: ComposerAttachment
}

/**
 * Draft-image rail, draft-file chip row, document drop target, and
 * original-image preview slot entry.
 */
export function ComposerAttachments({
  attachments, canAcceptDrop, onAddImages, onAddFiles, onRemoveImage, dropLimits, t,
}: ComposerAttachmentsProps) {
  const [preview, setPreview] = useState<ComposerImageAttachment | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const closePreview = useCallback(() => { setPreview(null) }, [])

  useEffect(() => {
    if (preview !== null && !attachments.some(attachment => attachment.id === preview.id)) setPreview(null)
  }, [attachments, preview])

  useEffect(() => {
    const fileTransfer = (event: globalThis.DragEvent): DataTransfer | null => {
      const dataTransfer = event.dataTransfer
      if (dataTransfer === null || !dataTransfer.types.includes('Files')) return null
      return dataTransfer
    }
    const reset = (): void => {
      dragDepth.current = 0
      setDragActive(false)
    }
    const onDragEnter = (event: globalThis.DragEvent): void => {
      if (fileTransfer(event) === null) return
      event.preventDefault()
      dragDepth.current += 1
      setDragActive(true)
    }
    const onDragOver = (event: globalThis.DragEvent): void => {
      const dataTransfer = fileTransfer(event)
      if (dataTransfer === null) return
      event.preventDefault()
      dataTransfer.dropEffect = canAcceptDrop ? 'copy' : 'none'
    }
    const onDragLeave = (event: globalThis.DragEvent): void => {
      if (fileTransfer(event) === null) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragActive(false)
      const leftViewport = event.clientX <= 0 || event.clientY <= 0
        || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight
      if ((event.target === document.documentElement || event.target === document.body) && leftViewport) reset()
    }
    // A document-level drop batch may mix images and text files: split by
    // content sniff (partitionDroppedFiles, the same client-side pre-check
    // the paste path uses) and route each side to its own kind-scoped
    // intake — a mixed batch no longer rejects everything through the image
    // path's whole-batch format check.
    const onDrop = (event: globalThis.DragEvent): void => {
      const dataTransfer = fileTransfer(event)
      if (dataTransfer === null) return
      event.preventDefault()
      reset()
      if (!canAcceptDrop) return
      const files = [...dataTransfer.files]
      void partitionDroppedFiles(files).then(({ texts, other }) => {
        if (other.length > 0) onAddImages(other)
        if (texts.length > 0) onAddFiles(texts)
      })
    }
    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    window.addEventListener('dragend', reset)
    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', reset)
    }
  }, [canAcceptDrop, onAddImages, onAddFiles])

  const railItems = useMemo<ComposerRailItem[]>(
    () => attachments.filter((a): a is ComposerImageAttachment => a.kind === 'image').map(attachment => ({
      id: attachment.id,
      previewUrl: attachment.previewUrl,
      alt: attachment.file.name || t('image.pending'),
      removeLabel: t('image.remove', { name: attachment.file.name }),
      attachment,
    })),
    [attachments, t],
  )

  const chipItems = useMemo<ComposerChipItem[]>(
    () => attachments.filter(a => a.kind === 'file').map(attachment => ({
      id: attachment.id,
      name: attachment.file.name || t('file.pending'),
      size: attachmentSizeText(attachment.file.size),
      removeLabel: t('file.remove', { name: attachment.file.name }),
      attachment,
    })),
    [attachments, t],
  )

  return (
    <>
      {dragActive && (
        <DropOverlay
          disabled={!canAcceptDrop}
          labels={dropOverlayLabels(t, canAcceptDrop, dropLimits)}
        />
      )}
      {railItems.length > 0 && (
        <div className={css.rail}>
          <AttachmentRail
            items={railItems}
            labels={attachmentRailLabels(t)}
            onOpen={(item) => { setPreview(item.attachment) }}
            onRemove={(item) => { onRemoveImage(item.attachment.id) }}
          />
        </div>
      )}
      {chipItems.length > 0 && (
        <FileChipRow
          items={chipItems}
          groupLabel={fileChipGroupLabel(t)}
          onRemove={(item) => { onRemoveImage(item.attachment.id) }}
        />
      )}
      {preview !== null && (
        <ImageLightbox
          src={preview.previewUrl}
          alt={preview.file.name || t('image.original')}
          labels={lightboxLabels(t)}
          onClose={closePreview}
        />
      )}
    </>
  )
}
