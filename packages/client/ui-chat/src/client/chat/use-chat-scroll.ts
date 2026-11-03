/** Composes viewport operations, reading policy, and history navigation for Chat. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionRevealRequest } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { TranscriptViewMode } from '../../chat-settings.ts'
import type { ChatRevealFailure, ChatRevealFailureReport, ChatRevealTarget } from '../contract/reveal.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { useChatNavigation, type ChatNavigation, type ChatNavigationInput } from './use-chat-navigation.ts'
import { useChatReading, type ChatReadingState } from './use-chat-reading.ts'
import { useChatViewport } from './use-chat-viewport.ts'
import type { FlowMotionRows } from './flow-motion.ts'

/** Committed content and Session operations used to reconcile scroll ownership. */
export interface ChatScrollInput extends ChatNavigationInput {
  readonly chatScroll: ChatViewSlotProps['chatScroll']
  readonly ready: boolean
  readonly order: readonly string[]
  readonly lastKey: string | null
  readonly lastIsUser: boolean
  readonly steeringId: string | null
  readonly submissionId: string | null
  /** The latest visible submission steers the running Turn instead of opening a new one. */
  readonly submissionSteers: boolean
  readonly running: boolean
  /** Enable the browser-local delayed-fold experiment and its input reveal animation. */
  readonly deferCompletedTurns: boolean
  /** A changed work-details preference resets fold reservations after the layout settles. */
  readonly transcriptView: TranscriptViewMode
  readonly loadedTurns: ReturnType<ChatSnapshot['navigation']['items']>
  /** Message the Session's navigation asked the transcript to show; null when none is pending. */
  readonly reveal: SessionRevealRequest | null
  /** Replace the display window with one direct read ending at the position. */
  readonly openAt: (seq: SessionSeq) => Promise<boolean>
  /** Restore the live, tail-following window after a direct history read. */
  readonly openTail: () => Promise<void>
  /** Append the next forward page to a direct history window. */
  readonly loadNewer: () => Promise<boolean>
  /** Resolve a durable message position against the live Chat snapshot. */
  readonly locateReveal: (seq: SessionSeq) => ChatRevealTarget | undefined
  /** Consume one handled reveal request. */
  readonly settleReveal: (id: number) => void
  /** Report a reveal the loaded window could not place, with the reason. */
  readonly notifyRevealFailure: (failure: ChatRevealFailureReport) => void
  /** Open the Turn-process disclosure that folds the landed row. */
  readonly setTurnProcessOpen: ChatViewSlotProps['actions']['setTurnProcessOpen']
}

/**
 * How long a landing retries while the fold it opened commits.
 *
 * Opening a group runs on the fold clock (its close animation is ~110 ms), so
 * the row appears several frames after the request. The wait is wall-clock
 * bounded rather than frame-count bounded so a slow or high-refresh display
 * neither shortens nor stretches how long the mounted row may take to appear.
 */
const REVEAL_MOUNT_TIMEOUT_MS = 500

/**
 * Extra direct reads a reveal makes when another page pull declined the first.
 *
 * The jump itself already reads the target page once; more retries only repeat
 * a request the Session answered with "not now".
 */
const REVEAL_HISTORY_ATTEMPTS = 1

/** Frames a landed row re-aligns for, covering the layout the page commit shifts. */
const REVEAL_ALIGN_FRAMES = 2

interface ChatScrollState extends ChatReadingState {
  readonly listRef: RefObject<HTMLDivElement>
  readonly columnRef: RefObject<HTMLDivElement>
  readonly busyTurn: number | null
  readonly navigateToTurn: ChatNavigation['navigateToTurn']
  readonly loadEarlier: ChatNavigation['loadEarlier']
  /** Append the next forward page to a direct history window. */
  readonly loadNewer: () => Promise<boolean>
  readonly returnToBottom: () => void
  readonly motion: FlowMotionRows
}

/**
 * Coordinate scroll policy after Chat content commits. Initial history must be ready
 * before automatic scroll or resize handling can initialize reading state and fold motion.
 * New submitted input supersedes pending reader sampling.
 * @param input - current Chat content, scroll memory, and history operations.
 * @returns element refs, visible reading state, and navigation callbacks.
 */
export function useChatScroll(input: ChatScrollInput): ChatScrollState {
  const {
    ready, order, firstSeq, lastKey, lastIsUser, steeringId, submissionId, submissionSteers, running,
    deferCompletedTurns, loadedTurns, chatScroll, hasMore, loadingOlder, loadOlder, loadThrough,
    openAt, openTail, loadNewer, transcriptView,
    reveal, locateReveal, settleReveal, notifyRevealFailure, setTurnProcessOpen,
  } = input
  const { viewport, listRef, columnRef } = useChatViewport()
  const { reading, state } = useChatReading(viewport, chatScroll, loadedTurns.at(-1)?.turn ?? null)
  const navigationInput = useMemo(() => ({
    firstSeq, loadingOlder, hasMore, loadOlder, loadThrough, openAt,
  }), [firstSeq, loadingOlder, hasMore, loadOlder, loadThrough, openAt])
  const { navigation, busyTurn } = useChatNavigation(viewport, reading, navigationInput)
  const content = useRef<{ input: ChatScrollInput; applied: ChatScrollInput | null; opened: boolean }>({
    input, applied: null, opened: false,
  })
  // A fold batch owns layout and scrolling until it lands: at the tail for own input or a following
  // reader, otherwise with the reader's content still. Growth consumes any room the landing installed.
  const cancelPendingFollow = useCallback(() => { viewport.motion.cancelInput() }, [viewport])

  const processContent = useCallback(() => {
    const current = content.current.input
    if (!current.ready && !content.current.opened) return
    const previous = content.current.applied
    const steeringInput = current.steeringId !== null && current.steeringId !== previous?.steeringId
      && current.steeringId !== previous?.submissionId
    const submissionInput = current.submissionId !== null && current.submissionId !== previous?.submissionId
      && current.submissionId !== previous?.steeringId
    const ownInput = (current.lastIsUser && current.lastKey !== previous?.lastKey) || steeringInput || submissionInput
    if (reading.pending && !ownInput) return
    content.current.applied = current
    if (current.ready && !content.current.opened) {
      content.current.opened = true
      navigation.reset()
      reading.restore()
      return
    }
    if (ownInput) {
      navigation.cancel()
      if (current.deferCompletedTurns && reading.followInputFold(true)) return
      // Steering lands at once: the running Turn keeps streaming above its echo, and that growth would push
      // the echo down under a native animation.
      const steering = steeringInput || (submissionInput && current.submissionSteers)
      reading.followTail(current.deferCompletedTurns && !steering ? 'smooth' : 'instant')
      return
    }
    if (navigation.contentCommitted()) {
      navigation.reconcile()
      return
    }
    const tipChanged = previous === null || current.ready !== previous.ready
      || current.firstSeq !== previous.firstSeq || current.lastKey !== previous.lastKey
      || current.order.length !== previous.order.length || current.running !== previous.running
      || current.steeringId !== previous.steeringId || current.submissionId !== previous.submissionId
    if (tipChanged && reading.followingTail) {
      navigation.cancel()
      if (current.deferCompletedTurns && reading.followInputFold(false)) return
      reading.followTail()
    } else navigation.reconcile()
  }, [reading, navigation])

  useLayoutEffect(() => {
    const disconnectViewport = viewport.connect({
      scroll: (event) => {
        if (!content.current.opened) return
        if (!event.movedByReader && viewport.motion.foldActive()) return
        reading.onScroll(event)
      },
      scrollEnd: (outer) => {
        reading.onScrollEnd(outer)
        navigation.readerSettled()
      },
      interact: () => { navigation.cancel() },
      intent: () => { cancelPendingFollow(); reading.interruptFollow() },
      resize: () => {
        if (!content.current.opened) return
        if (navigation.contentCommitted()) {
          navigation.reconcile()
          return
        }
        if (!content.current.input.deferCompletedTurns || !viewport.motion.foldActive()) reading.onResize()
        navigation.reconcile()
      },
    })
    const disconnectReading = reading.connect((sample) => {
      navigation.readerSampled(sample)
      processContent()
    })
    return () => {
      disconnectViewport()
      disconnectReading()
      content.current.opened = false
      content.current.applied = null
    }
  }, [viewport, reading, navigation, processContent, cancelPendingFollow])

  useLayoutEffect(() => {
    const previous = content.current.input
    content.current.input = {
      ready, order, lastKey, lastIsUser, steeringId, submissionId, submissionSteers, running, loadedTurns,
      chatScroll, deferCompletedTurns, transcriptView, ...navigationInput,
      reveal, openAt, openTail, loadNewer, locateReveal, settleReveal, notifyRevealFailure, setTurnProcessOpen,
    }
    if (!deferCompletedTurns) {
      cancelPendingFollow()
      reading.interruptFollow()
    }
    viewport.updateTurns(loadedTurns)
    const layoutChanged = previous.order !== order || previous.ready !== ready
    if (layoutChanged) viewport.invalidate()
    viewport.reclaimBelow()
    processContent()
    if (layoutChanged && content.current.opened) reading.refreshActiveTurn()
  }, [
    viewport, reading, processContent, navigationInput, ready, order, lastKey, lastIsUser,
    steeringId, submissionId, submissionSteers, running, loadedTurns, chatScroll, deferCompletedTurns, transcriptView,
    cancelPendingFollow, reveal, locateReveal, settleReveal, notifyRevealFailure, setTurnProcessOpen,
  ])

  const previousView = useRef(transcriptView)
  useLayoutEffect(() => {
    if (previousView.current === transcriptView) return
    previousView.current = transcriptView
    cancelPendingFollow()
    reading.interruptFollow()
    return viewport.motion.onFoldIdle(() => {
      viewport.resetBelow()
      if (content.current.opened) reading.onResize()
    })
  }, [transcriptView, viewport, reading, cancelPendingFollow])

  // A reveal is a reading gesture from another surface, so it takes reading ownership the
  // way a turn jump does: history paging keeps the current content still, and the landing
  // releases tail follow so the next streaming growth cannot take the reader back to it.
  // Nothing marks the request handled locally: settling it upstream is what stops this
  // run, so a re-mounted view (StrictMode, HMR) lands a still-pending request again.
  useEffect(() => {
    if (!ready || reveal === null) return
    let cancelled = false
    let frame: number | null = null
    const settle = (landed: boolean, reason: ChatRevealFailure = 'unlocated'): void => {
      viewport.stopPreserving()
      if (!landed) notifyRevealFailure({ reason, seq: reveal.seq })
      settleReveal(reveal.id)
    }
    const land = (target: ChatRevealTarget, deadline: number): void => {
      if (cancelled) return
      if (target.process !== null) setTurnProcessOpen(target.process.turn, target.process.answerStep, true)
      const landing = viewport.revealNode(target.key)
      if (landing !== null) {
        reading.acceptNavigation(landing)
        settle(true)
        // The page a reveal just asked for can lay out on the frame after this
        // one; aligning again on the next frames keeps the row where the reader
        // was sent instead of one screen off after the shift.
        let corrections = REVEAL_ALIGN_FRAMES
        const correct = (): void => {
          if (cancelled || corrections <= 0) return
          corrections -= 1
          viewport.realignNode(target.key)
          frame = requestAnimationFrame(correct)
        }
        if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(correct)
        return
      }
      // The row is not mounted yet: a fold this request opened hides it until React commits.
      if (Date.now() >= deadline || typeof requestAnimationFrame !== 'function') {
        settle(false, 'unmounted')
        return
      }
      frame = requestAnimationFrame(() => {
        frame = null
        land(target, deadline)
      })
    }
    const nextFrame = (): Promise<void> => new Promise((resolve) => {
      frame = requestAnimationFrame(() => {
        frame = null
        resolve()
      })
    })
    const arrive = async (attempts: number): Promise<void> => {
      if (cancelled) return
      const exact = locateReveal(reveal.seq)
      if (exact !== undefined) {
        land(exact, Date.now() + REVEAL_MOUNT_TIMEOUT_MS)
        return
      }
      // The window does not hold the Turn. The jump loader can decline to page
      // — another page pull owns the flag, or it was asked before the Session
      // opened — so ask again rather than land somewhere the reader did not ask for.
      if (attempts > 0 && (firstSeq === null || reveal.seq < firstSeq)) {
        // One direct read at the position replaces the window; paging from the
        // tail would load every message between here and the live end.
        await openAt(reveal.seq)
        await nextFrame()
        return arrive(attempts - 1)
      }
      // No row presents this position: report it instead of landing on a
      // neighbour the reader did not ask for.
      settle(false)
    }
    navigation.cancel()
    viewport.beginPreserving()
    reading.pauseFollowing()
    // A direct history read settles rather than rejects; a refusal still ends this landing.
    void openAt(reveal.seq)
      .then(() => arrive(REVEAL_HISTORY_ATTEMPTS))
      .catch(() => { if (!cancelled) settle(false, 'history') })
    return () => {
      cancelled = true
      if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
    }
  }, [
    ready, reveal, loadThrough, openAt, locateReveal, settleReveal, notifyRevealFailure,
    setTurnProcessOpen, hasMore, firstSeq,
    viewport, reading, navigation,
  ])

  const returnToBottom = useCallback(() => {
    cancelPendingFollow()
    navigation.cancel()
    // A direct history window is not the tail; followTail would scroll to the
    // bottom of the old page instead of the live end.
    void openTail().then(() => { reading.followTail() }, () => undefined)
  }, [navigation, reading, cancelPendingFollow, openTail])

  return {
    listRef, columnRef, ...state, busyTurn, motion: viewport.motion,
    navigateToTurn: navigation.navigateToTurn,
    loadEarlier: navigation.loadEarlier,
    loadNewer,
    returnToBottom,
  }
}
