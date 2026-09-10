/**
 * The multipart branch of electron-updater's differential download, loaded
 * from `node_modules` so what is checked is the code the packaged app runs.
 *
 * A differential download that asks for more than one byte range issues a
 * single multipart request, and the response stream of that request carried no
 * `error` listener: an interrupted connection raised an unhandled `error`
 * event, which in the Electron main process is an uncaught exception. The
 * single-range branch beside it and `DifferentialDownloader` both attach one.
 * `patches/electron-updater@6.8.9.patch` adds the upstream line. This suite is
 * the safety net rather than the retirement signal — it stays green whether
 * the line comes from the patch or from a later release. What raises the
 * question is pnpm: neither `allowUnusedPatches` nor `ignorePatchFailures` is
 * set, so a bump that leaves the exact-version patch unused or unapplicable
 * fails the install.
 * @module
 */

import { PassThrough, Writable } from 'node:stream'
import { OperationKind } from 'electron-updater/out/differentialDownloader/downloadPlanBuilder.js'
import { executeTasksUsingMultipleRangeRequests } from 'electron-updater/out/differentialDownloader/multipleRangeDownloader.js'
import { describe, expect, it } from 'vitest'

/** The differential downloader the exported function drives. */
type Downloader = Parameters<typeof executeTasksUsingMultipleRangeRequests>[0]

/** The request object `createRequest` returns to the branch under test. */
interface FakeRequest {
  /** Sends the request; here it delivers the prepared response instead. */
  end: () => void
  /** Called by the branch's own end-without-handlers timeout, never here. */
  abort: () => void
}

/**
 * A multipart range response: the status and headers the branch requires
 * before it builds its splitter, over a stream the test can fail on demand.
 * @returns the response to hand the request callback.
 */
function multipartResponse(): PassThrough {
  return Object.assign(new PassThrough(), {
    statusCode: 206,
    headers: { 'content-type': 'multipart/byteranges; boundary=SEPARATOR' },
  })
}

/**
 * A downloader whose HTTP executor answers the one multipart request with the
 * given response, delivered when the branch sends the request.
 * @param response - the response to deliver.
 * @returns the downloader to pass, typed as the real one.
 */
function downloaderReturning(response: PassThrough): Downloader {
  return {
    createRequestOptions: () => ({ headers: {} }),
    fileMetadataBuffer: null,
    options: {},
    httpExecutor: {
      createRequest: (_options: unknown, callback: (response: PassThrough) => void): FakeRequest => ({
        // The branch reads the request into a closure the callback uses, so the
        // response may not arrive before `createRequest` has returned it.
        end: () => { callback(response) },
        abort: () => {},
      }),
      addErrorAndTimeoutHandlers: () => {},
    },
  } as unknown as Downloader
}

describe('executeTasksUsingMultipleRangeRequests', () => {
  it('rejects on a response error instead of raising it unhandled', () => {
    const response = multipartResponse()
    // Two DOWNLOAD tasks: one range would take the single-range branch, which
    // has always attached the listener.
    const tasks = [
      { kind: OperationKind.DOWNLOAD, start: 0, end: 16 },
      { kind: OperationKind.DOWNLOAD, start: 32, end: 48 },
    ]
    const out = new Writable({ write: (_chunk, _encoding, done) => { done() } })
    const rejected: Error[] = []
    executeTasksUsingMultipleRangeRequests(
      downloaderReturning(response), tasks, out, -1, (error) => { rejected.push(error) },
    )(0)

    const interrupted = Object.assign(new Error('net::ERR_CONNECTION_RESET'), { code: 'ECONNRESET' })
    // An 'error' event with no listener is thrown by the emitter itself, which
    // is exactly how this reached the main process as an uncaught exception.
    expect(() => response.emit('error', interrupted)).not.toThrow()
    expect(rejected).toEqual([interrupted])
  })
})
