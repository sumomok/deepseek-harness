import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { byteSizeText } from './byte-size.ts'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionLogDownloadState } from './controller.ts'
import css from './Dialog.module.css'
import { NS } from './locales.ts'
import { SESSION_EXPORT_PROGRESS_START, type SessionExportProgress } from './progress.ts'

/** Browser operations and state injected into the Session Header contribution. */
export interface SessionLogDownloadDialogInjected {
  hooks: { sessionLogDownload: ObservableSnapshot<SessionLogDownloadState> }
  request: (sessionId: SessionId) => Promise<void>
  dismiss: (sessionId: SessionId) => void
  cancel: (sessionId: SessionId) => void
}

export type SessionLogDownloadDialogProps =
  PropsRuntime<'conversation.session.header.utilities'>
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
  const detail = t('dialog.progress', { size: byteSizeText(receivedBytes) })
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
 * Panel shared by the Session Header button and this browser's `/export` command.
 * @param props - Session runtime, bound controller state, actions, and localized copy.
 * @returns the modal portal contribution.
 */
export function SessionLogDownloadDialog({
  sessionId, useSessionLogDownload, dismiss, cancel, t,
}: SessionLogDownloadDialogProps) {
  const entry = useSessionLogDownload(state => state.bySession[String(sessionId)])

  const status = entry?.status
  const open = entry?.open === true
  const downloading = status === 'downloading'
  const error = status === 'error' ? entry?.error || t('dialog.commandFailed') : null
  const title = downloading
    ? t('dialog.preparingTitle')
    : status === 'success' ? t('dialog.successTitle') : t('dialog.errorTitle')
  const description = downloading
    ? t('dialog.preparingDescription')
    : status === 'success' ? t('dialog.successDescription') : error ?? t('dialog.commandFailed')
  const action = downloading ? t('dialog.cancel') : t('dialog.close')

  return (
    <Modal
      open={open}
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
      {status !== 'error' && (
        <SessionExportProgressBar progress={entry?.progress ?? SESSION_EXPORT_PROGRESS_START} t={t} />
      )}
    </Modal>
  )
}
