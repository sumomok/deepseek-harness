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
  /** Resolve a durable message position against the live Chat snapshot. */
  readonly locateReveal: (seq: SessionSeq) => ChatRevealTarget | undefined
  /** Resolve a position the loaded window cannot place to the nearest visible row. */
  readonly locateNearest: (seq: SessionSeq) => ChatRevealTarget | undefined
  /** Consume one handled reveal request. */
  readonly settleReveal: (id: number) => void
  /** Report a reveal the loaded window could not place, with the reason. */
  readonly notifyRevealFailure: (failure: ChatRevealFailureReport) => void
  /** Open the Turn-process disclosure that folds the landed row. */
  readonly setTurnProcessOpen: ChatViewSlotProps['actions']['setTurnProcessOpen']
}

/** Animation frames a landing retries while the fold it opened commits. */
const REVEAL_LANDING_FRAMES = 4

interface ChatScrollState extends ChatReadingState {
  readonly listRef: RefObject<HTMLDivElement>
  readonly columnRef: RefObject<HTMLDivElement>
  readonly busyTurn: number | null
  readonly navigateToTurn: ChatNavigation['navigateToTurn']
  readonly loadEarlier: ChatNavigation['loadEarlier']
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
    deferCompletedTurns, loadedTurns, chatScroll, hasMore, loadingOlder, loadOlder, loadThrough, transcriptView,
    reveal, locateReveal, locateNearest, settleReveal, notifyRevealFailure, setTurnProcessOpen,
  } = input
  const { viewport, listRef, columnRef } = useChatViewport()
  const { reading, state } = useChatReading(viewport, chatScroll, loadedTurns.at(-1)?.turn ?? null)
  const navigationInput = useMemo(() => ({
    firstSeq, loadingOlder, hasMore, loadOlder, loadThrough,
  }), [firstSeq, loadingOlder, hasMore, loadOlder, loadThrough])
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
      reveal, locateReveal, locateNearest, settleReveal, notifyRevealFailure, setTurnProcessOpen,
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
    const land = (key: string, remaining: number): void => {
      if (cancelled) return
      const landing = viewport.revealNode(key)
      if (landing !== null) {
        reading.acceptNavigation(landing)
        settle(true)
        return
      }
      // The row is not mounted yet: a fold this request opened hides it until React commits.
      if (remaining <= 0 || typeof requestAnimationFrame !== 'function') {
        settle(false, 'unmounted')
        return
      }
      frame = requestAnimationFrame(() => {
        frame = null
        land(key, remaining - 1)
      })
    }
    const arrive = (): void => {
      if (cancelled) return
      // An exact resolution can only refuse when the Turn holding the position
      // is absent from the window; landing at the closest row still opens the
      // Session where the reader asked, instead of reporting nothing.
      const target = locateReveal(reveal.seq) ?? locateNearest(reveal.seq)
      if (target === undefined) {
        settle(false)
        return
      }
      if (target.process !== null) setTurnProcessOpen(target.process.turn, target.process.answerStep, true)
      land(target.key, REVEAL_LANDING_FRAMES)
    }
    navigation.cancel()
    viewport.beginPreserving()
    reading.pauseFollowing()
    // The jump loader settles rather than rejects; a refusal still ends this landing.
    void loadThrough(reveal.seq).then(arrive, () => { if (!cancelled) settle(false, 'history') })
    return () => {
      cancelled = true
      if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
    }
  }, [
    ready, reveal, loadThrough, locateReveal, locateNearest, settleReveal, notifyRevealFailure,
    setTurnProcessOpen,
    viewport, reading, navigation,
  ])

  const returnToBottom = useCallback(() => {
    cancelPendingFollow()
    navigation.cancel()
    reading.followTail()
  }, [navigation, reading, cancelPendingFollow])

  return {
    listRef, columnRef, ...state, busyTurn, motion: viewport.motion,
    navigateToTurn: navigation.navigateToTurn,
    loadEarlier: navigation.loadEarlier,
    returnToBottom,
  }
}
