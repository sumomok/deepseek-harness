/** Root overlay showing one Session export at a time in initiation order. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Button, Modal, fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionLogDownloadState } from './controller.ts'
import css from './Dialog.module.css'
import { NS } from './locales.ts'
import type { SessionExportProgress } from './progress.ts'

/** Download state and actions bound into the root overlay entry. */
export interface SessionLogDownloadDialogInjected {
  hooks: { sessionLogDownload: ObservableSnapshot<SessionLogDownloadState> }
  dismiss: (sessionId: SessionId) => void
  cancel: (sessionId: SessionId) => void
}

/** Root runtime, localized copy, and injected download state and actions. */
export type SessionLogDownloadDialogProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
  & InjectFace<SessionLogDownloadDialogInjected>

/**
 * Bar and received size for one export, determinate once the Host announces
 * the archive's extent and indeterminate until then.
 * @param props.progress - the controller's latest reading.
 * @param props.t - localized copy.
 * @returns the progress region rendered inside the panel.
 */
function SessionExportProgressBar({ progress, t }: {
  progress: SessionExportProgress
  t: TranslateNS<typeof NS>
}) {
  const { fraction, receivedBytes } = progress
  const detail = t('dialog.progress', { size: fileSizeText(receivedBytes) })
  return (
    <div className={css.progress}>
      <div
        className={fraction === null ? `${css.track} ${css.indeterminate}` : css.track}
        role="progressbar"
        aria-label={t('dialog.progressLabel')}
        {...fraction === null ? {} : {
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': Math.round(fraction * 100),
        }}
      >
        <div className={css.fill} style={fraction === null ? undefined : { width: `${String(fraction * 100)}%` }} />
      </div>
      <p className={css.detail}>{detail}</p>
    </div>
  )
}

/**
 * Show the earliest open export independently of the displayed conversation.
 * @param props - root runtime, bound controller state, dismissal, cancellation, and localized copy.
 * @returns one modal, or null when all exports are dismissed.
 */
export function SessionLogDownloadDialog({
  useSessionLogDownload, dismiss, cancel, t,
}: SessionLogDownloadDialogProps) {
  const bySession = useSessionLogDownload(state => state.bySession)
  const pending = Object.entries(bySession)
    .filter((pair): pair is [string, NonNullable<typeof pair[1]>] => pair[1]?.open === true)
    .sort((a, b) => a[1].order - b[1].order)[0]
  if (pending === undefined) return null
  const [id, entry] = pending
  const sessionId = id as SessionId
  const { status } = entry
  const downloading = status === 'downloading'
  const progress = entry.progress
  const title = downloading
    ? t('dialog.preparingTitle')
    : status === 'success' ? t('dialog.successTitle') : t('dialog.errorTitle')
  // Preparing is only true until the Host answers; after that the archive is
  // on its way and the received-byte count is moving.
  const inFlight = progress.receivedBytes > 0
    ? t('dialog.transferringDescription')
    : t('dialog.preparingDescription')
  const description = `${t('dialog.session', { sessionId })} ${downloading
    ? inFlight
    : status === 'success' ? t('dialog.successDescription') : entry.error || t('dialog.commandFailed')}`
  const action = downloading ? t('dialog.cancel') : t('dialog.close')

  return (
    <Modal
      open
      onClose={() => { dismiss(sessionId) }}
      title={title}
      description={description}
      closeLabel={t('dialog.close')}
      footer={(
        <Button variant="primary" onClick={() => { if (downloading) cancel(sessionId); else dismiss(sessionId) }}>
          {action}
        </Button>
      )}
    >
      {status !== 'error' && <SessionExportProgressBar progress={progress} t={t} />}
    </Modal>
  )
}
