/**
 * The host half of the picture read: what happens to a seat's exported pixels
 * between the route that received them and the call waiting for them.
 *
 * It is where the wire's asymmetry is resolved, so what these cases hold is
 * that the bytes reach the store before the call settles, that the settled call
 * carries a reference and no bytes, and that a store which refuses ends the
 * call rather than leaving it to time out.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { settleImageReport, storeCapture } from '../src/access/image-report.ts'
import { PendingCalls, type CallTimeouts } from '../src/access/pending.ts'
import { imageStoreRefusal } from '../src/access/text.ts'
import type { ImageCapture, ReadOutcome } from '../src/access/wire.ts'

/** Deadlines long enough for a case to claim and answer inside them. */
const SLOW: CallTimeouts = { claimTimeoutMs: 5000, answerTimeoutMs: 5000, pinMs: 5000 }

/** The tab every case here answers from. */
const TAB = 'tab_1'

/** The id a store hands back for the pixels it kept. */
const STORED_ID = 'sha256:b1ff9c8ea3a780bad09b346c423d2d0e46815926879b18e841d928376a946640'

/** Three bytes, base64, which is what a capture carries. */
const PIXELS = 'AQID'

/** One capture as the seat posts it. */
const CAPTURE: ImageCapture = {
  status: 'captured',
  page: { id: 'home', title: 'Home' },
  url: 'http://127.0.0.1:5173/content-app/',
  ref: 'e12',
  tag: 'img',
  natural: { width: 240, height: 240 },
  settled: true,
  mediaType: 'image/png',
  data: PIXELS,
}

/** What one stub store was asked to keep, and what it answered. */
interface Store {
  /** The store, as the host half takes it. */
  attachments: AttachmentStore
  /** Every save it was asked for, in order. */
  saved: SaveImageAttachment[]
}

/**
 * A store that keeps what it is given, or refuses.
 * @param refusal - what the store throws instead of keeping anything.
 * @returns the stub and its record.
 */
function store(refusal?: Error): Store {
  const saved: SaveImageAttachment[] = []
  const attachments = {
    saveImage: (input: SaveImageAttachment): Promise<ImageAttachmentRef> => {
      saved.push(input)
      if (refusal !== undefined) return Promise.reject(refusal)
      return Promise.resolve({
        attachmentId: STORED_ID,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 240,
        height: 240,
        ...input.name === undefined ? {} : { name: input.name },
      } as ImageAttachmentRef)
    },
  } as unknown as AttachmentStore
  return { attachments, saved }
}

describe('the pixels a seat posted', () => {
  it('reaches the store as the exact bytes the payload decodes to', async () => {
    const { attachments, saved } = store()
    await storeCapture(attachments, CAPTURE)
    expect(saved).toHaveLength(1)
    expect([...(saved[0]?.data ?? [])]).toEqual([...Buffer.from(PIXELS, 'base64')])
    expect(saved[0]?.mediaType).toBe('image/png')
  })

  it('is named after the page and the element it came from', async () => {
    const { attachments, saved } = store()
    await storeCapture(attachments, CAPTURE)
    expect(saved[0]?.name).toBe('content-home-e12.png')
  })

  it('takes its stored name from what the browser encoded, not from what was asked for', async () => {
    const { attachments, saved } = store()
    await storeCapture(attachments, { ...CAPTURE, mediaType: 'image/webp' })
    expect(saved[0]?.name).toBe('content-home-e12.webp')
  })

  it('settles the call with the reference the store gave and none of the bytes', async () => {
    const { attachments } = store()
    const outcome = await storeCapture(attachments, CAPTURE)
    expect(outcome).toEqual({
      status: 'image',
      page: { id: 'home', title: 'Home' },
      url: 'http://127.0.0.1:5173/content-app/',
      ref: 'e12',
      tag: 'img',
      natural: { width: 240, height: 240 },
      settled: true,
      image: {
        attachmentId: STORED_ID,
        mediaType: 'image/png',
        bytes: 3,
        width: 240,
        height: 240,
        name: 'content-home-e12.png',
      },
    })
  })

  it('carries no display name where the store gave none', async () => {
    const attachments = {
      saveImage: (): Promise<ImageAttachmentRef> => Promise.resolve({
        attachmentId: STORED_ID,
        mediaType: 'image/png',
        bytes: 3,
        width: 240,
        height: 240,
      } as ImageAttachmentRef),
    } as unknown as AttachmentStore
    const outcome = await storeCapture(attachments, CAPTURE)
    expect(outcome).toMatchObject({ status: 'image' })
    expect(outcome).not.toHaveProperty('image.name')
  })

  it('settles the call with the store\'s own reason where the store refused', async () => {
    const refusal = new AttachmentError('Image batch exceeds the configured image-count limit.', 'TOO_MANY_IMAGES')
    const outcome = await storeCapture(store(refusal).attachments, CAPTURE)
    expect(outcome).toEqual({
      status: 'error',
      code: 'engine',
      message: imageStoreRefusal('Image batch exceeds the configured image-count limit.'),
    })
  })
})

describe('delivering one picture report to the call waiting for it', () => {
  /**
   * Open one wait and deliver one report to it.
   * @param report - the posted capture or failure.
   * @param attachments - the store to keep the pixels in.
   * @returns what the waiting call settled as and whether the report was taken.
   */
  async function deliver(
    report: ImageCapture | Extract<ReadOutcome, { status: 'error' }>,
    attachments: AttachmentStore,
  ): Promise<{ accepted: boolean; settled: unknown }> {
    const pending = new PendingCalls()
    const waiting = pending.open('call_1', 'session_1', new AbortController().signal, SLOW)
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await pending.claim({ callId: 'call_1', tabId: TAB })).claimed) break
      await new Promise<void>((resolve) => { setTimeout(resolve, 2) })
    }
    const ack = await settleImageReport(attachments, pending, { callId: 'call_1', tabId: TAB, capture: report })
    return { accepted: ack.accepted, settled: await waiting }
  }

  it('stores the pixels first and hands the call the reference', async () => {
    const { attachments, saved } = store()
    const { accepted, settled } = await deliver(CAPTURE, attachments)
    expect(accepted).toBe(true)
    expect(saved).toHaveLength(1)
    expect(settled).toMatchObject({ kind: 'reported', outcome: { status: 'image', image: { attachmentId: STORED_ID } } })
  })

  it('delivers a failed export as posted, storing nothing', async () => {
    const { attachments, saved } = store()
    const failure = { status: 'error', code: 'engine', message: 'e12 is drawn at zero pixels.' } as const
    const { accepted, settled } = await deliver(failure, attachments)
    expect(accepted).toBe(true)
    expect(saved).toEqual([])
    expect(settled).toEqual({ kind: 'reported', outcome: failure })
  })

  it('takes nothing for a call nobody is waiting on', async () => {
    const { attachments, saved } = store()
    const pending = new PendingCalls()
    const ack = await settleImageReport(attachments, pending, { callId: 'call_gone', tabId: TAB, capture: CAPTURE })
    expect(ack).toEqual({ accepted: false })
    // The pixels were kept before the table was asked, which is the order the
    // log needs: a reference must name an object that is already on disk.
    expect(saved).toHaveLength(1)
  })
})
