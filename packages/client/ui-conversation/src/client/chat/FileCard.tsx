/**
 * Compact file-part card: name + size, click dispatches `referent/open`
 * first (see `dispatchReferentOpen`) and — while no listener claims it —
 * falls through to this card's own default: toggle an inline expand/collapse
 * viewer that lazily fetches the file's text through `loadFile` on first
 * expand and caches it locally per mount.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { attachmentSizeText } from '../attachment-labels.ts'
import type { ChatViewSlotProps, OpenReferent } from '../contract/slots.ts'
import css from './FileCard.module.css'

export interface FileCardProps {
  /** Durable reference to the sent file (a session log content-part carries this, never inline text). */
  attachment: FileAttachmentRef
  /** Resolve this file's text through the durable attachment seam. */
  loadFile: (attachment: FileAttachmentRef) => Promise<string>
  /** Dispatch `referent/open` ahead of this card's default expand/collapse. */
  openReferent: OpenReferent
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}

/**
 * One sent-file card: name + size head, lazily-fetched expand/collapse body.
 * @param props - the durable reference, loader, dispatch, and locale seat.
 * @returns the card.
 */
export function FileCard({ attachment, loadFile, openReferent, t }: FileCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const requestRef = useRef(0)

  useEffect(() => {
    if (!expanded || text !== null || loading) return
    const id = requestRef.current += 1
    setLoading(true)
    setError(null)
    void loadFile(attachment).then(
      (result) => {
        if (id !== requestRef.current) return
        setText(result)
        setLoading(false)
      },
      (err: unknown) => {
        if (id !== requestRef.current) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      },
    )
  }, [attachment, expanded, loadFile, loading, text])

  const onClick = useCallback((): void => {
    void openReferent(
      {
        kind: 'file',
        target: attachment.name,
        raw: attachment.name,
        attachment,
        source: 'message-file-card',
        provenance: 'structured',
      },
      () => { setExpanded(prev => !prev) },
    )
  }, [attachment, openReferent])

  return (
    <div className={css.card} data-expanded={expanded || undefined}>
      <button type="button" className={css.head} onClick={onClick} aria-expanded={expanded} title={t('file.open')}>
        <span className={css.name} title={attachment.name}>{attachment.name}</span>
        <span className={css.size}>{attachmentSizeText(attachment.bytes)}</span>
      </button>
      {expanded && (
        <div className={css.body}>
          {loading && <span className={css.status} role="status">{t('file.loading')}</span>}
          {error !== null && <span className={css.status} role="alert">{t('file.loadFailed')}</span>}
          {text !== null && <pre className={css.text}>{text}</pre>}
        </div>
      )}
    </div>
  )
}
