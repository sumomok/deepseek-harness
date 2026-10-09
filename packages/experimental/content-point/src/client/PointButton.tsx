/**
 * The 「指一下」 button in the composer's tool row. A click starts a point; the
 * place picked becomes a reference draft in the attachment row. A second click
 * while the point runs cancels it, as Escape does. A place that cannot be
 * pointed at reports why in a toast over the composer and adds nothing.
 *
 * Pressing the button keeps the focus where it was, as the row's 「+」 does, so
 * the composer still holds it after a point and Enter sends. The button is
 * disabled while the composer refuses attachments, during a submission. With
 * `REFERENCE_LIMIT` of this plugin's references already in the row, a
 * click reports that in a toast instead of starting a point: the host refuses
 * a prompt carrying more. A draft the composer refuses after all is released
 * and reported.
 * @module @deepseek-ai/dsh-experimental-content-point/client/PointButton
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { IconGoalOutlineMedium, IconWarningOutlineRegular, Toast, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DraftAttachmentId, InputActions, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DescribeRefusal } from '@haoran/dsh-point-anchor'
import { REFERENCE_LIMIT } from './limit.ts'
import type { PointOutcome } from './pick.ts'
import css from './PointButton.module.css'

/** What the slot entry injects: running a point, and filing, counting and releasing its drafts. */
export interface PointButtonInjected {
  /**
   * Run one point over the console document.
   * @param signal - ends the point as cancelled when aborted.
   * @returns how the point ended.
   */
  point: (signal: AbortSignal) => Promise<PointOutcome>
  /**
   * File a reference as a draft.
   * @param label - the chip label.
   * @param data - the payload recorded on send.
   * @returns the draft's attachment id.
   */
  draft: (label: string, data: Extract<PointOutcome, { kind: 'reference' }>['data']) => DraftAttachmentId
  /**
   * How many of some attachment ids are this plugin's drafts.
   * @param ids - the attachment row's ids.
   * @returns the count.
   */
  drafted: (ids: readonly DraftAttachmentId[]) => number
  /**
   * Release a draft the composer did not take.
   * @param id - the draft's attachment id.
   */
  release: (id: DraftAttachmentId) => void
  /**
   * The words a refusal is reported in.
   * @param reason - the refusal.
   * @returns the words.
   */
  refusal: (reason: DescribeRefusal) => string
}

/** Props of the 「指一下」 button: the session seat's input actions and state, the injected share, and the locale. */
export type PointButtonProps = {
  readonly inputActions: Pick<InputActions, 'addAttachments'>
  readonly useInput: <T>(selector: (state: InputState) => T) => T
} & InjectFace<PointButtonInjected> & PropsLocale<'contentPoint'>

/** One toast the button shows. */
interface Shown {
  readonly seq: number
  readonly text: string
}

/**
 * Keep the focus where it is when the button is pressed.
 * @param event - the press.
 */
function keepFocus(event: MouseEvent<HTMLButtonElement>): void {
  event.preventDefault()
}

/**
 * The 「指一下」 button.
 * @param props - the runtime share, the injected share and the locale.
 * @returns the button, with the toast of the last notice while it shows.
 */
export function PointButton({ inputActions, useInput, point, draft, drafted, release, refusal, t }: PointButtonProps) {
  const [running, setRunning] = useState<AbortController | null>(null)
  const [toast, setToast] = useState<Shown | null>(null)
  const attachmentIds = useInput(state => state.attachmentIds)
  const busy = useInput(state => state.phase !== 'plain')
  const latest = useRef(attachmentIds)
  latest.current = attachmentIds
  const button = useRef<HTMLButtonElement | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  // Unmounting the composer ends a point still running.
  useEffect(() => () => running?.abort(), [running])

  const notify = useCallback((text: string) => {
    setToast(previous => ({ seq: (previous?.seq ?? 0) + 1, text }))
  }, [])
  const full = useCallback(() => drafted(latest.current) >= REFERENCE_LIMIT, [drafted])

  const file = useCallback((outcome: Extract<PointOutcome, { kind: 'reference' }>) => {
    if (full()) {
      notify(t('full.text', { limit: REFERENCE_LIMIT }))
      return
    }
    const id = draft(outcome.label, outcome.data)
    if (inputActions.addAttachments([id])) return
    release(id)
    notify(t('busy.text'))
  }, [draft, full, inputActions, notify, release, t])

  const onClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    if (running !== null) {
      running.abort()
      return
    }
    if (full()) {
      notify(t('full.text', { limit: REFERENCE_LIMIT }))
      return
    }
    const controller = new AbortController()
    setRunning(controller)
    void point(controller.signal).then((outcome) => {
      if (!alive.current) return
      setRunning(null)
      if (outcome.kind === 'reference') file(outcome)
      else if (outcome.kind === 'refused') notify(t('refused.text', { reason: refusal(outcome.reason) }))
    }, () => {
      if (alive.current) setRunning(null)
    })
  }, [file, full, notify, point, refusal, running, t])

  const label = running === null ? t('button.label') : t('button.picking')
  return (
    <>
      <Tooltip label={label} side="top" delayMs={500}>
        <button
          ref={button}
          type="button"
          className={css.point}
          aria-label={t('button.label')}
          aria-pressed={running !== null}
          disabled={busy && running === null}
          data-content-point-button=""
          onMouseDown={keepFocus}
          onClick={onClick}
        >
          <IconGoalOutlineMedium size={14} />
        </button>
      </Tooltip>
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutlineRegular />}
          anchor={button.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </>
  )
}
