/**
 * The 「指一下」 button in the composer's tool row. A click starts a point; the
 * place picked becomes a reference draft in the attachment row. A second click
 * while the point runs cancels it, as Escape does. A place that cannot be
 * pointed at reports why in a toast over the composer and adds nothing.
 * @module @deepseek-ai/dsh-experimental-content-point/client/PointButton
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { IconInspectOutlineMedium, IconWarningOutlineRegular, Toast, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DraftAttachmentId, InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DescribeRefusal } from '@haoran/dsh-point-anchor'
import type { PointOutcome } from './pick.ts'
import css from './PointButton.module.css'

/** What the slot entry injects: running a point, and filing its reference as a draft. */
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
   * The words a refusal is reported in.
   * @param reason - the refusal.
   * @returns the words.
   */
  refusal: (reason: DescribeRefusal) => string
}

/** Props of the 「指一下」 button: the session seat's input actions it adds a draft with, the injected share, and the locale. */
export type PointButtonProps = { readonly inputActions: Pick<InputActions, 'addAttachments'> } & InjectFace<PointButtonInjected> & PropsLocale<'contentPoint'>

/** One toast the button shows. */
interface Shown {
  readonly seq: number
  readonly text: string
}

/**
 * The 「指一下」 button.
 * @param props - the runtime share, the injected share and the locale.
 * @returns the button, with the toast of the last refusal while it shows.
 */
export function PointButton({ inputActions, point, draft, refusal, t }: PointButtonProps) {
  const [running, setRunning] = useState<AbortController | null>(null)
  const [toast, setToast] = useState<Shown | null>(null)
  const button = useRef<HTMLButtonElement | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  // Unmounting the composer ends a point still running.
  useEffect(() => () => running?.abort(), [running])

  const onClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    if (running !== null) {
      running.abort()
      return
    }
    const controller = new AbortController()
    setRunning(controller)
    void point(controller.signal).then((outcome) => {
      if (!alive.current) return
      setRunning(null)
      if (outcome.kind === 'reference') inputActions.addAttachments([draft(outcome.label, outcome.data)])
      else if (outcome.kind === 'refused') setToast(previous => ({ seq: (previous?.seq ?? 0) + 1, text: t('refused.text', { reason: refusal(outcome.reason) }) }))
    }, () => {
      if (alive.current) setRunning(null)
    })
  }, [draft, inputActions, point, refusal, running, t])

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
          data-content-point-button=""
          onClick={onClick}
        >
          <IconInspectOutlineMedium size={14} />
        </button>
      </Tooltip>
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutlineRegular />}
          anchor={button.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => setToast(null)}
        />
      )}
    </>
  )
}
