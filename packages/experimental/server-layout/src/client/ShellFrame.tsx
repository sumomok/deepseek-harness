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
 * The content column additionally collapses to zero width while the current
 * session's content surface has shown nothing — read defensively off the
 * standard `useSessions` list feed's per-entry `projectionValues`
 * (`@deepseek-ai/dsh-experimental-content-surface`'s `contentSurface` key)
 * rather than importing that package: this shell has zero dependency on it,
 * and a deployment that never composes it simply always reads an empty
 * entry list, which is the same collapsed state (see the package README's
 * Known Limitations for the coupling this soft read carries).
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
 * Read whether the current session's content surface has anything to show,
 * off the standard session-list feed rather than a content-surface import
 * (see the module doc). Defensive `unknown` narrowing throughout: neither
 * `projectionValues` nor its `contentSurface` member is typed in this
 * package's own compilation.
 * @param state - the `useSessions` snapshot.
 * @returns `false` once the current session's content surface carries at
 * least one entry; `true` otherwise, including no current session at all.
 */
function currentContentEmpty(state: { byId: Record<string, { projectionValues?: unknown }>; current: string | undefined }): boolean {
  if (state.current === undefined) return true
  const projectionValues = state.byId[state.current]?.projectionValues as Record<string, unknown> | undefined
  const contentSurface = projectionValues?.contentSurface as { entries?: readonly unknown[] } | undefined
  return (contentSurface?.entries?.length ?? 0) === 0
}

/**
 * Render the four-track shell (see module doc).
 * @param props - the composed slot props.
 * @returns the frame element.
 */
export function ShellFrame({ useStore, useSessions, renderSlot, t }: ShellFrameProps) {
  const panels = useStore(s => s)
  const contentEmpty = useSessions(currentContentEmpty)
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

  const tracks = solveTracks(frame, panels.sessionFolded, panels.detailsOpen, contentEmpty)

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{ gridTemplateColumns: `${tracks.session}px ${tracks.content}px ${tracks.chat}px ${tracks.details}px` }}
      data-session-folded={panels.sessionFolded || undefined}
      data-details-open={panels.detailsOpen || undefined}
      data-content-empty={contentEmpty || undefined}
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
