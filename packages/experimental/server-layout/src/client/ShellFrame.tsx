/**
 * The service-line shell frame, registered into the built-in 'root' slot (the
 * web shell renders only 'root'). Four resident grid tracks — session |
 * content | chat | details — solved in px from the frame's own measured width
 * (tracks.ts). The frame owns three render decisions: the session slot renders
 * here with the fold state and the solved px width it must lay itself out
 * against, the content slot carries this shell's own empty-state body as its
 * renderSlot fallback, and the session-aware occupants render at fixed tree
 * positions so a session switch never moves them.
 *
 * Pure component: everything arrives through the framework shares — zero
 * cordis imports, zero self-made hooks.
 */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { ContentPlaceholder } from './ContentPlaceholder.tsx'
import { solveTracks } from './tracks.ts'
import type { createPanelStore } from './stores.ts'
import css from './ShellFrame.module.css'

/** Full composed props: runtime share + child-slot render share + store share + locale seat. */
export type ShellFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'content' | 'conversation' | 'details' | 'shell.overlay'>
  & PropsStore<ReturnType<typeof createPanelStore>>
  & PropsLocale<'serverLayout'>

/**
 * Render the four-track shell (see module doc).
 * @param props - the composed slot props.
 * @returns the frame element.
 */
export function ShellFrame({ useStore, renderSlot, t }: ShellFrameProps) {
  const panels = useStore(s => s)
  const frameRef = useRef<HTMLDivElement | null>(null)
  // The window is the first-paint estimate; the observer below replaces it
  // with the frame's own box on the first delivered entry.
  const [frame, setFrame] = useState(() => window.innerWidth)

  useEffect(() => {
    const element = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (element === null) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]?.contentRect.width
      if (width !== undefined && width > 0) setFrame(width)
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  const tracks = solveTracks(frame, panels.sessionFolded, panels.detailsOpen)

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{ gridTemplateColumns: `${tracks.session}px ${tracks.content}px ${tracks.chat}px ${tracks.details}px` }}
      data-session-folded={panels.sessionFolded || undefined}
      data-details-open={panels.detailsOpen || undefined}
    >
      <div className={css.sessionCol} data-shell-column="session">
        {/* The occupant lays itself out against the solved width, so it
            receives the rendered number rather than the ratio behind it. */}
        {renderSlot('sidebar', { collapsed: panels.sessionFolded, width: tracks.session })}
      </div>
      <div className={css.contentCol} data-shell-column="content">
        {renderSlot('content', {}, {
          fallback: <ContentPlaceholder title={t('content.title')} hint={t('content.hint')} />,
        })}
      </div>
      <div className={css.chatCol} data-shell-column="chat">
        {renderSlot('conversation', {})}
      </div>
      {/* Zero width keeps the details subtree mounted across close/open. */}
      <div className={css.detailsCol} data-shell-column="details">
        {renderSlot('details', {})}
      </div>
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
    </div>
  )
}
