/**
 * The host half of the picture read: what happens to one seat's exported pixels
 * between the route that received them and the call waiting for them.
 *
 * It is where the wire's asymmetry is resolved. A seat posts bytes and never a
 * reference, because it has no attachment store; a settled call carries a
 * reference and never bytes, because a tool result is written to a log that
 * outlives the request. This module is the one place that turns the first into
 * the second, and it commits the pixels before the call settles — the log's
 * reference must name an object that is already on disk when the `tool/result`
 * event is appended.
 *
 * Committed only for a call that is waiting, and only once for it. The store
 * keeps what it is given and collects nothing, so storing first for every post
 * would let anything that can reach the route write bytes nothing will ever
 * read or remove; the call's one settlement is therefore taken from the table
 * before the bytes are decoded, and both a post for a call nobody is waiting on
 * and a second post for a call whose save is already running leave the store as
 * it found it. What is left over is one object per call rather than one per
 * post: a call whose own deadline runs out while its one reserved save is
 * writing still leaves those bytes behind.
 * @module @deepseek-ai/dsh-experimental-content-frame/access/image-report
 */

import { Buffer } from 'node:buffer'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { PendingCalls } from './pending.ts'
import { imageStoreRefusal } from './text.ts'
import type { ImageCapture, ImageReportRequest, ReadOutcome, ReportAck } from './wire.ts'

/** What the stored picture is called, after the page and the element it came from. */
const NAME_PREFIX = 'content'

/**
 * Commit one seat's exported pixels and describe them as a settled read.
 *
 * The store's own failures settle the call rather than propagating: a route
 * that threw would leave the call waiting out its whole report deadline for a
 * failure this side already knows, and the model would be told the console went
 * quiet.
 * @param attachments - the deployment's attachment store.
 * @param capture - the posted pixels, already checked against the wire.
 * @returns the settled read, or the failure the store earned.
 */
export async function storeCapture(attachments: AttachmentStore, capture: ImageCapture): Promise<ReadOutcome> {
  try {
    const ref = await attachments.saveImage({
      data: new Uint8Array(Buffer.from(capture.data, 'base64')),
      mediaType: capture.mediaType,
      name: `${NAME_PREFIX}-${capture.page.id}-${capture.ref}.${capture.mediaType.slice('image/'.length)}`,
    })
    return {
      status: 'image',
      page: capture.page,
      url: capture.url,
      ref: capture.ref,
      tag: capture.tag,
      natural: capture.natural,
      settled: capture.settled,
      image: {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...ref.name === undefined ? {} : { name: ref.name },
      },
    }
  } catch (refusal) {
    /* v8 ignore next -- the store throws AttachmentError and nothing else; String() keeps a thrown non-Error readable. */
    const reason = refusal instanceof Error ? refusal.message : String(refusal)
    return { status: 'error', code: 'engine', message: imageStoreRefusal(reason) }
  }
}

/**
 * Deliver one posted image report to the call waiting for it.
 *
 * A failed export is delivered as posted; a capture's pixels are stored first,
 * and only for the one post that took the call's settlement — the same
 * acceptance `report` applies, taken before rather than read after the bytes
 * are committed, because a store that collects nothing takes back neither what
 * a post for an unknown call nor what a second post for this one would have
 * written. A reservation always reaches `report`: the store's own refusals are
 * settlements here rather than throws, so the call ends on this post either
 * way. Both arms go to the same call and the same table, so one call id is
 * never raced by two routes: an image read's failures travel this route too
 * rather than the listing routes'.
 * @param attachments - the deployment's attachment store.
 * @param pending - the table calls wait on.
 * @param report - the posted report, already checked against the wire.
 * @returns whether this post took the waiting call, which at most one post for
 * a call does.
 */
export async function settleImageReport(
  attachments: AttachmentStore,
  pending: PendingCalls,
  report: ImageReportRequest,
): Promise<ReportAck> {
  if (!pending.reserveReport(report.callId, report.tabId)) return { accepted: false }
  const outcome = report.capture.status === 'error'
    ? report.capture
    : await storeCapture(attachments, report.capture)
  return pending.report({ callId: report.callId, tabId: report.tabId, outcome })
}
