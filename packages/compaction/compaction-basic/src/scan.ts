/**
 * One-pass session facts used by automatic compaction: route and pending
 * selection, durable failure seeding, and turn/step boundaries.
 *
 * @module @deepseek-ai/dsh-compaction-basic/scan
 */

import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { eventRoute } from './route.ts'
import type { RoutedTarget } from './route.ts'
import { SUMMARY_REJECTED_MESSAGE } from './region.ts'
import { TargetPressureConfigError } from './config.ts'

/** Failure classes the durable circuit breaker records. */
const CONFIG_FAILURE_PATTERN = new RegExp([
  'no context capacity for',
  'configure contextWindow on that adapter model',
  'leaving no .*budget',
  'fixed prefix .* already at or above',
  'retainTokens .*must be less than threshold',
].join('|'), 'i')

/** Turn and step boundaries a pressure selection may use. */
export interface CompactBoundaries {
  /** First surface user message of every turn. */
  readonly userTurnStarts: readonly SessionSeq[]
  /** First surface assistant message after each step start. */
  readonly stepStarts: readonly SessionSeq[]
}

/** Durable facts one compaction pass derives from a single event scan. */
export interface CompactionScan {
  /** Newest pending model selection, when it is newer than the latest header. */
  readonly pending: RoutedTarget | undefined
  /** Latest durable request-header route. */
  readonly durable: RoutedTarget | undefined
  /** Newest route event (selection or header), used to attribute durable failures. */
  readonly latestRoute: RoutedTarget | undefined
  /** Trailing failures after the latest route/summary/clean end. */
  readonly seededFailure: { readonly count: number; readonly errorClass: string } | undefined
  /** Boundary sequence arrays in one shared scan. */
  readonly boundaries: CompactBoundaries
}

/**
 * Scan one Session log once for every automatic-compaction fact.
 * @param session - session whose durable log is read.
 * @returns route, seeded failure, and boundary facts.
 */
export function scanCompactionSession(session: Session): CompactionScan {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  const events = session.snapshotEvents()
  const surface = new Set(session.surface.nodes)
  let headerSeq = -1
  let selectionSeq = -1
  let durable: RoutedTarget | undefined
  let selection: RoutedTarget | undefined
  let latestRoute: RoutedTarget | undefined
  let count = 0
  let errorClass = 'recorded'
  const userTurnStarts: SessionSeq[] = []
  const stepStarts: SessionSeq[] = []
  let inTurn = false
  let sawUser = false
  let pendingStep = false

  for (const event of events) {
    if (event.type === 'request/header') {
      headerSeq = event.seq
      durable = eventRoute(event)
      latestRoute = durable
      count = 0
      errorClass = 'recorded'
      continue
    }
    const eventType: string = event.type
    if (eventType === 'model/selection') {
      const route = eventRoute(event)
      if (route !== undefined) {
        selectionSeq = event.seq
        selection = route
        latestRoute = route
        count = 0
        errorClass = 'recorded'
      }
      continue
    }
    if (event.type === 'compaction/summary') {
      count = 0
      errorClass = 'recorded'
      continue
    }
    if (event.type === 'compaction/end') {
      if (event.data.error === undefined) {
        count = 0
        errorClass = 'recorded'
        continue
      }
      const failureClass = classifyCompactionError(event.data.error)
      if (failureClass === 'review-rejected' || failureClass === 'config') continue
      count += 1
      errorClass = failureClass
      continue
    }
    if (event.type === 'turn/start') {
      inTurn = true
      sawUser = false
      continue
    }
    if (event.type === 'turn/end') {
      inTurn = false
      sawUser = false
      continue
    }
    if (event.type === 'step/start') {
      pendingStep = true
      continue
    }
    if (event.type === 'user/message') {
      if (inTurn && !sawUser && surface.has(event.seq)) {
        userTurnStarts.push(event.seq)
        sawUser = true
      }
      continue
    }
    if (event.type === 'assistant/message') {
      if (pendingStep && surface.has(event.seq)) {
        stepStarts.push(event.seq)
        pendingStep = false
      }
    }
  }

  return {
    pending: selectionSeq > headerSeq ? selection : undefined,
    durable,
    latestRoute,
    seededFailure: count === 0 ? undefined : { count, errorClass },
    boundaries: { userTurnStarts, stepStarts },
  }
}

/**
 * Classify one durable compaction failure for the circuit breaker.
 * @param error - recorded `compaction/end.error` value.
 * @returns stable failure class.
 */
export function classifyCompactionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/abort/i.test(message)) return 'cancelled'
  if (message === SUMMARY_REJECTED_MESSAGE) return 'review-rejected'
  if (/summary is not smaller/i.test(message)) return 'summary-not-smaller'
  if (/Connection error/i.test(message)) return 'connection'
  if (/^400:|\b400\b.*schema/i.test(message)) return 'provider-400'
  if (error instanceof TargetPressureConfigError) return 'config'
  if (CONFIG_FAILURE_PATTERN.test(message)) return 'config'
  return 'other'
}
