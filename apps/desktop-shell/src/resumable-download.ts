/**
 * A transfer that survives being interrupted: the shell's own HTTP `Range`
 * downloader, used when electron-updater's has run out of attempts.
 *
 * electron-updater keeps nothing of a failed transfer — the full download sends
 * no `Range` header, and any error out of `AppUpdater.executeDownload` unlinks
 * the partial file and empties the pending directory
 * (`out/AppUpdater.js:609-616`, `:633`). On a connection that drops every few
 * minutes, a few hundred megabytes therefore never complete, however many times
 * they are attempted. This module keeps the bytes: it appends to a `.part`
 * file, asks for the rest from the offset it already holds, and hashes as it
 * writes, so the artifact is verified against the manifest's own base64 sha512
 * by the time the last byte lands.
 *
 * Two conditions restart the transfer from zero rather than continuing it: a
 * `200` answer to a `Range` request, which is a server sending the whole file,
 * and a `416`, which is a part at least as long as the artifact. Both truncate
 * the `.part` file, so the file on disk never mixes two answers. A third is
 * written nowhere at all: a `206` whose `Content-Range` begins somewhere other
 * than the offset that was asked for, or that names no range, carries bytes
 * that belong neither after what is on disk nor at the start of the file, so
 * not one of them is written and the attempt reports what the server answered.
 * The `.part` file is kept for the next attempt, which asks for the same range:
 * nothing of the refused answer reached the disk, and an artifact that changed
 * underneath is still caught by the three that catch it anyway — a `200`
 * truncates the part, a `416` discards it, and the final digest discards it.
 * A server that replaced the artifact under a resumed transfer is
 * caught twice — by the `If-Range` validator when one was recorded, and by the
 * final digest either way, which discards the `.part` file rather than leaving
 * corrupt bytes to be resumed forever.
 *
 * Nothing here touches electron, so `tests/resumable-download.spec.ts`
 * exercises it against a local server that honours `Range` and can cut a
 * response in half.
 * @module @deepseek-ai/dsh-desktop-shell/resumable-download
 */

import { createHash } from 'node:crypto'
import {
  createReadStream, createWriteStream, existsSync, readFileSync, rmSync, statSync, writeFileSync,
  type WriteStream,
} from 'node:fs'
import { finished } from 'node:stream/promises'
import type { TransferSample } from './update-state.ts'

/**
 * How long a transfer may deliver nothing before it is abandoned.
 *
 * A socket that is open but silent delivers no error of its own, and this
 * transfer runs unattended in the background: without a bound, one stalled
 * connection would hold the update channel for the rest of the session. The
 * value matches the socket timeout builder-util-runtime sets on
 * electron-updater's own requests (`out/httpExecutor.js:141-147`), so a stall
 * costs the same wherever the bytes were coming from.
 */
export const IDLE_TIMEOUT_MS = 60_000

/** Suffix of the file recording what the bytes already on disk came from. */
const VALIDATOR_SUFFIX = '.origin.json'

/** `Content-Range: bytes <first>-<last>/<total>`, which is the only form a 206 to this request can carry. */
const CONTENT_RANGE = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i

/** The artifact to transfer and where its bytes are kept between attempts. */
export interface ResumableTarget {
  /** Absolute URL of the artifact. */
  url: string
  /** Where the partial file lives; the finished bytes are left at this path. */
  partFile: string
  /** The manifest's base64 sha512 for this artifact. */
  sha512: string
}

/** What a transfer needs from its caller beyond the target. */
export interface ResumeOptions {
  /**
   * Report one sample as bytes arrive.
   * @param sample - completion, bytes so far, and the artifact's total size.
   */
  onProgress?: (sample: TransferSample) => void
  /** The fetch to use; the global one unless a test supplies another. */
  fetch?: typeof globalThis.fetch
  /** How long the transfer may deliver nothing before it is abandoned. */
  idleTimeoutMs?: number
}

/** What one `.part` file's bytes came from, so a later attempt can prove the artifact did not change. */
interface PartOrigin {
  /** The `ETag` or `Last-Modified` the answer carried, sent back as `If-Range`. */
  validator?: string
}

/**
 * Bytes already on disk for this transfer.
 * @param file - the `.part` file.
 * @returns its size, or 0 when it does not exist.
 */
function bytesOnDisk(file: string): number {
  return existsSync(file) ? statSync(file).size : 0
}

/**
 * Read what a `.part` file's bytes came from.
 * @param file - the `.part` file.
 * @returns the recorded origin, or undefined when there is none to read.
 */
function readOrigin(file: string): PartOrigin | undefined {
  try {
    return JSON.parse(readFileSync(`${file}${VALIDATOR_SUFFIX}`, 'utf8')) as PartOrigin
  } catch {
    // Absent, unreadable, or not JSON: the transfer proceeds without an
    // `If-Range` validator and the final digest is what catches a changed
    // artifact.
    return undefined
  }
}

/**
 * Drop a partial transfer and everything recorded about it.
 * @param file - the `.part` file.
 */
export function discardPart(file: string): void {
  rmSync(file, { force: true })
  rmSync(`${file}${VALIDATOR_SUFFIX}`, { force: true })
}

/**
 * Feed the bytes already on disk into the running digest, so the digest covers
 * the whole artifact rather than only what this attempt transferred.
 * @param file - the `.part` file.
 * @param bytes - how many of its bytes count; the ones the server was told about.
 * @param hash - the digest to update.
 */
async function hashPrefix(file: string, bytes: number, hash: ReturnType<typeof createHash>): Promise<void> {
  const stream = createReadStream(file, { start: 0, end: bytes - 1 })
  for await (const chunk of stream) hash.update(chunk as Buffer)
}

/**
 * Wait until a write stream can take more bytes, or until it fails.
 *
 * A stream that failed emits no `drain`, so a wait on that event alone never
 * ends: the transfer stops where it is, holding the update channel for the
 * rest of the run. Both events end this wait, and whichever fires removes the
 * other's listener; the caller reads the failure off the stream's own `error`
 * listener rather than off this call.
 *
 * A stream that already failed or was destroyed emits neither event, so it is
 * answered without waiting at all.
 * @param out - the stream whose `write` reported backpressure.
 * @returns when the stream drained or failed.
 */
async function drainedOrFailed(out: WriteStream): Promise<void> {
  if (out.errored !== null || out.destroyed) return
  await new Promise<void>((resolve) => {
    const settle = (): void => {
      out.off('drain', settle)
      out.off('error', settle)
      resolve()
    }
    out.once('drain', settle)
    out.once('error', settle)
  })
}

/**
 * The artifact's total size, from whichever header the answer carries it in.
 * @param status - the response status.
 * @param headers - the response headers.
 * @param have - bytes already on disk that this answer continues.
 * @returns the total, or undefined when the answer names none.
 */
function totalBytesOf(status: number, headers: Headers, have: number): number | undefined {
  const range = CONTENT_RANGE.exec(headers.get('content-range') ?? '')
  if (range !== null) return Number(range[3])
  const length = headers.get('content-length')
  if (length === null) return undefined
  return status === 206 ? have + Number(length) : Number(length)
}

/**
 * Transfer one artifact, continuing a `.part` file left by an earlier attempt.
 *
 * The `.part` file survives every failure except a digest that does not match
 * the manifest, so a call that throws is worth making again from the same
 * state. Two answers discard it and start the transfer over from zero inside
 * the same call: a `200` to a `Range` request, and a `416`. A call that returns
 * leaves the whole verified artifact at [[ResumableTarget.partFile]].
 * @param target - what to transfer, where to keep it, and what it must hash to.
 * @param options - progress reporting, the fetch to use, and the stall bound.
 * @returns the artifact's size in bytes.
 * @throws when the answer is neither `200` nor `206`, when a `206` begins
 * somewhere the request did not ask for, when the transfer stalls or is cut
 * short, when the `.part` file cannot be written, or when the completed file's
 * sha512 is not the manifest's.
 */
export async function resumeDownload(target: ResumableTarget, options: ResumeOptions = {}): Promise<number> {
  const call = options.fetch ?? globalThis.fetch
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
  const origin = readOrigin(target.partFile)
  let have = bytesOnDisk(target.partFile)
  // Two passes at most: the first may answer 416, which discards the part and
  // makes the second a transfer from zero.
  for (let pass = 0; pass < 2; pass++) {
    const headers: Record<string, string> = {}
    if (have > 0) {
      headers.range = `bytes=${String(have)}-`
      if (origin?.validator !== undefined) headers['if-range'] = origin.validator
    }
    const controller = new AbortController()
    let idle = setTimeout(() => { controller.abort() }, idleTimeoutMs)
    try {
      const response = await call(target.url, { headers, redirect: 'follow', signal: controller.signal })
      if (response.status === 416) {
        await response.body?.cancel()
        discardPart(target.partFile)
        have = 0
        continue
      }
      if (response.status !== 200 && response.status !== 206) {
        await response.body?.cancel()
        throw new Error(`更新源返回 ${String(response.status)} ${response.statusText}(${target.url})`)
      }
      const range = CONTENT_RANGE.exec(response.headers.get('content-range') ?? '')
      // Where in the artifact this answer's body begins: a 200 is the whole
      // file, and a 206 is trusted for nothing its `Content-Range` does not
      // say.
      const start = response.status === 200 ? 0 : range === null ? undefined : Number(range[1])
      // Two starts can be used: the offset this transfer stopped at, which
      // continues the `.part` file, and zero, which replaces it. A body from
      // anywhere else is a fragment of the artifact. Writing it from zero would
      // leave a `.part` file whose prefix is wrong and whose length the next
      // attempt would resume from, so the whole artifact would transfer again
      // before the final digest caught it — the bytes are taken nowhere
      // instead. What is already on disk is left where it is: no byte of this
      // answer reached it, the next attempt asks for the same range, and
      // dropping it would spend the whole artifact again over one bad answer.
      if (start === undefined || (start !== 0 && start !== have)) {
        await response.body?.cancel()
        throw new Error(`更新源答复的区间与请求不符:${response.headers.get('content-range') ?? '缺少 Content-Range'}(${target.url})`)
      }
      const append = start > 0
      if (!append) have = 0
      const total = totalBytesOf(response.status, response.headers, have)
      const validator = response.headers.get('etag') ?? response.headers.get('last-modified') ?? undefined
      if (!append) {
        discardPart(target.partFile)
        if (validator !== undefined) {
          writeFileSync(`${target.partFile}${VALIDATOR_SUFFIX}`, `${JSON.stringify({ validator } satisfies PartOrigin)}\n`)
        }
      }
      const hash = createHash('sha512')
      if (append) await hashPrefix(target.partFile, have, hash)
      const out = createWriteStream(target.partFile, { flags: append ? 'a' : 'w' })
      // A write that fails — a full disk, a directory a security product
      // holds, a cache directory removed under the transfer — raises `error`
      // on this stream. A stream with no `error` listener turns that into an
      // uncaughtException, which this process answers with a modal error box
      // for a download nobody was watching; listening keeps it a failure of
      // this attempt. The abort is what ends a read waiting for bytes that now
      // have nowhere to go.
      out.on('error', () => { controller.abort() })
      let written = 0
      try {
        if (response.body === null) throw new Error(`更新源没有返回内容(${target.url})`)
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          clearTimeout(idle)
          idle = setTimeout(() => { controller.abort() }, idleTimeoutMs)
          hash.update(value)
          if (!out.write(value)) await drainedOrFailed(out)
          if (out.errored !== null) break
          written += value.byteLength
          options.onProgress?.({
            percent: total === undefined ? 0 : ((have + written) / total) * 100,
            transferred: have + written,
            total: total ?? 0,
          })
        }
      } finally {
        out.end()
        try {
          // The bytes that did arrive are the resume point, so they are
          // flushed whether the transfer finished or was cut.
          await finished(out)
        } catch {
          // The stream's own failure, reported below off `errored`; nothing
          // else settles this call, because every other way the attempt can
          // end throws out of the loop above instead.
        }
        // A write that failed names why this attempt ended; the read its abort
        // cut short only says that it did.
        if (out.errored !== null) throw out.errored
      }
      const size = have + written
      if (total !== undefined && size !== total) {
        throw new Error(`下载被中断:已取得 ${String(size)}/${String(total)} 字节(${target.url})`)
      }
      const digest = hash.digest('base64')
      if (digest !== target.sha512) {
        discardPart(target.partFile)
        throw new Error(`下载完成但校验不符:期望 ${target.sha512},实得 ${digest}(${target.url})`)
      }
      return size
    } finally {
      clearTimeout(idle)
    }
  }
  throw new Error(`更新源对 ${target.url} 反复回答 416`)
}
