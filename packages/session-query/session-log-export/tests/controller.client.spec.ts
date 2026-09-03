// @vitest-environment jsdom
/**
 * The browser download controller reads the host ZIP itself: it streams the
 * response body, publishes progress as chunks arrive, hands the assembled
 * archive to the browser save flow, and reports every failure — HTTP,
 * transport, and mid-stream — in the panel instead of leaving it to a browser
 * download manager, which an embedding shell need not surface at all.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  downloadBlob,
  filenameFromContentDisposition,
  SessionLogDownloadController,
  sessionLogZipFilename,
} from '../src/client/controller.ts'
import {
  SESSION_EXPORT_BYTES_HEADER,
  SESSION_EXPORT_ENTRIES_HEADER,
  SESSION_EXPORT_ESTIMATED_WIRE_BYTES_HEADER,
} from '../src/export-extent.ts'

const SID = 'session-export-controller' as SessionId
const SIGNATURE = [0x50, 0x4b, 0x03, 0x04]

/** Three 20-byte entries, announced as 300 uncompressed bytes on 60 of wire. */
const EXTENT_HEADERS = {
  [SESSION_EXPORT_ENTRIES_HEADER]: '3',
  [SESSION_EXPORT_BYTES_HEADER]: '300',
  [SESSION_EXPORT_ESTIMATED_WIRE_BYTES_HEADER]: '60',
  'content-disposition': 'attachment; filename="dsh-session-fixture.zip"',
}

/** One entry's archive bytes: a local file header plus filler. */
function entryChunk(): Uint8Array {
  return new Uint8Array([...SIGNATURE, ...new Array<number>(16).fill(0x41)])
}

function archiveResponse(chunks: readonly Uint8Array[], init: ResponseInit = {}): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  }), init)
}

/** An archive whose chunks the test releases one at a time. */
function heldArchive(init: ResponseInit = {}) {
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { stream = controller },
  }), init)
  return {
    response,
    push: (chunk: Uint8Array) => { stream.enqueue(chunk) },
    close: () => { stream.close() },
    fail: (reason: Error) => { stream.error(reason) },
  }
}

/** A response whose body errors as soon as the request signal aborts. */
function abortableArchive(init?: RequestInit): Response {
  const signal = init?.signal
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(entryChunk())
      signal?.addEventListener('abort', () => { controller.error(new Error('aborted')) }, { once: true })
    },
  }), { headers: EXTENT_HEADERS })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('SessionLogDownloadController', () => {
  it('streams the host ZIP, reports rising progress, and saves the assembled archive', async () => {
    const archive = heldArchive({ headers: EXTENT_HEADERS })
    const fetcher = vi.fn(async () => archive.response)
    const save = vi.fn()
    const controller = new SessionLogDownloadController(fetcher, save)

    const run = controller.download(SID)
    const reported: (number | null)[] = []
    const progressOf = () => controller.store.getSnapshot().bySession[SID]?.progress
    await vi.waitFor(() => { expect(progressOf()?.receivedBytes).toBe(0) })
    reported.push(progressOf()?.fraction ?? null)
    for (const expectedBytes of [20, 40, 60]) {
      archive.push(entryChunk())
      await vi.waitFor(() => { expect(progressOf()?.receivedBytes).toBe(expectedBytes) })
      reported.push(progressOf()?.fraction ?? null)
    }
    archive.close()
    await run

    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.pathname).toBe('/api/session.export')
    expect(url.searchParams.get('sessionId')).toBe(SID)
    expect(url.searchParams.get('includeDescendants')).toBe('true')
    expect(init.method).toBe('GET')
    expect(init.signal).toBeInstanceOf(AbortSignal)

    expect(reported).toHaveLength(4)
    expect(reported[0]).toBeNull()
    expect(reported[1]).toBeCloseTo(1 / 3, 10)
    expect(reported[2]).toBeCloseTo(2 / 3, 10)
    expect(reported[3]).toBe(0.99)

    expect(save).toHaveBeenCalledOnce()
    const [saved, filename] = save.mock.calls[0] as unknown as [Blob, string]
    expect(saved.size).toBe(60)
    expect(saved.type).toBe('application/zip')
    expect(filename).toBe('dsh-session-fixture.zip')
    expect(controller.store.getSnapshot().bySession[SID]).toEqual({
      open: true,
      status: 'success',
      error: null,
      progress: { fraction: 1, entriesDone: 3, entriesTotal: 3, receivedBytes: 60 },
    })
  })

  it('reads an RFC 5987 filename in preference to the plain parameter', async () => {
    const save = vi.fn()
    const controller = new SessionLogDownloadController(
      async () => archiveResponse([entryChunk()], {
        headers: {
          ...EXTENT_HEADERS,
          'content-disposition': "attachment; filename=\"fallback.zip\"; filename*=UTF-8''dsh-%E4%BC%9A%E8%AF%9D.zip",
        },
      }),
      save,
    )

    await controller.download(SID)

    expect(save.mock.calls[0]?.[1]).toBe('dsh-会话.zip')
  })

  it('stays indeterminate and names the archive itself when the host announces nothing', async () => {
    const save = vi.fn()
    const controller = new SessionLogDownloadController(
      async () => archiveResponse([entryChunk()]), save,
    )

    await controller.download(SID)

    expect(save.mock.calls[0]?.[1]).toBe('dsh-session-session-export-controller.zip')
    expect(controller.store.getSnapshot().bySession[SID]?.progress).toEqual({
      fraction: 1, entriesDone: 1, entriesTotal: null, receivedBytes: 20,
    })
  })

  it('collapses concurrent gestures and keeps a dismissed download running', async () => {
    const archive = heldArchive({ headers: EXTENT_HEADERS })
    const fetcher = vi.fn(async () => archive.response)
    const save = vi.fn()
    const controller = new SessionLogDownloadController(fetcher, save)

    const first = controller.download(SID)
    const second = controller.download(SID)
    expect(first).toBe(second)
    controller.dismiss(SID)
    archive.push(entryChunk())
    archive.close()
    await first

    expect(fetcher).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot().bySession[SID]?.open).toBe(false)
    controller.dismiss(SID)
  })

  it('publishes HTTP, transport, missing-body, and mid-stream failures', async () => {
    const http = new SessionLogDownloadController(
      async () => new Response('backend unavailable', { status: 500 }), vi.fn(),
    )
    await http.download(SID)
    expect(http.store.getSnapshot().bySession[SID]).toMatchObject({
      open: true,
      status: 'error',
      error: 'HTTP 500 backend unavailable',
    })

    const transport = new SessionLogDownloadController(async () => { throw 'offline' }, vi.fn())
    await transport.download(SID)
    expect(transport.store.getSnapshot().bySession[SID]?.error).toBe('offline')

    const emptyDetail = new SessionLogDownloadController(
      async () => ({
        ok: false, status: 503, text: async () => { throw new Error('body unavailable') },
      }) as unknown as Response,
      vi.fn(),
    )
    await emptyDetail.download(SID)
    expect(emptyDetail.store.getSnapshot().bySession[SID]?.error).toBe('HTTP 503')

    const bodyless = new SessionLogDownloadController(
      async () => ({ ok: true, status: 200, body: null, headers: new Headers() }) as unknown as Response,
      vi.fn(),
    )
    await bodyless.download(SID)
    expect(bodyless.store.getSnapshot().bySession[SID]?.error)
      .toBe('The host sent no archive stream.')

    const archive = heldArchive({ headers: EXTENT_HEADERS })
    const save = vi.fn()
    const torn = new SessionLogDownloadController(async () => archive.response, save)
    const run = torn.download(SID)
    archive.push(entryChunk())
    await vi.waitFor(() => {
      expect(torn.store.getSnapshot().bySession[SID]?.progress.receivedBytes).toBe(20)
    })
    archive.fail(new Error('subagent "sub-1" has no stored log'))
    await run
    expect(save).not.toHaveBeenCalled()
    const torndown = torn.store.getSnapshot().bySession[SID]
    expect(torndown).toMatchObject({
      open: true,
      status: 'error',
      error: 'subagent "sub-1" has no stored log',
    })
    // The panel keeps the progress the transfer had reached when it tore.
    expect(torndown?.progress.entriesDone).toBe(0)
    expect(torndown?.progress.entriesTotal).toBe(3)
    expect(torndown?.progress.receivedBytes).toBe(20)
    expect(torndown?.progress.fraction).toBeCloseTo(1 / 3, 10)
  })

  it('cancels an in-flight download and returns the Session to idle', async () => {
    const save = vi.fn()
    const fetcher = vi.fn((_input: string | URL, init?: RequestInit) => Promise.resolve(abortableArchive(init)))
    const controller = new SessionLogDownloadController(fetcher, save)

    const pending = controller.download(SID)
    await vi.waitFor(() => {
      expect(controller.store.getSnapshot().bySession[SID]?.progress.receivedBytes).toBe(20)
    })
    controller.cancel(SID)
    await pending

    expect(controller.store.getSnapshot().bySession[SID]).toBeUndefined()
    expect(save).not.toHaveBeenCalled()

    // Cancelling a Session with nothing in flight is inert.
    controller.cancel('absent' as SessionId)
    expect(controller.store.getSnapshot().bySession['absent']).toBeUndefined()
  })

  it('saves nothing when the cancel lands after the last read', async () => {
    const archive = heldArchive({ headers: EXTENT_HEADERS })
    const save = vi.fn()
    const controller = new SessionLogDownloadController(async () => archive.response, save)

    const run = controller.download(SID)
    archive.push(entryChunk())
    await vi.waitFor(() => {
      expect(controller.store.getSnapshot().bySession[SID]?.progress.receivedBytes).toBe(20)
    })
    // The stream ends and the cancel arrives in the same turn, so the read
    // loop has already left before the abort is observed.
    archive.close()
    controller.cancel(SID)
    await run

    expect(save).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().bySession[SID]).toBeUndefined()
  })

  it('aborts active fetches on disposal and ignores later requests', async () => {
    let signal: AbortSignal | undefined
    const fetcher = vi.fn((_input: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal ?? undefined
      signal?.addEventListener('abort', () => {
        reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
      }, { once: true })
    }))
    const controller = new SessionLogDownloadController(fetcher, vi.fn())
    const pending = controller.download(SID)

    await controller.dispose()

    await expect(pending).resolves.toBeUndefined()
    expect(signal?.aborted).toBe(true)
    await expect(controller.download(SID)).resolves.toBeUndefined()
    await controller.dispose()
  })

  it('uses the null-origin fallback and the default browser save', async () => {
    vi.stubGlobal('location', { origin: 'null' })
    const fetcher = vi.fn(
      async (_input: string | URL, _init?: RequestInit) => archiveResponse([entryChunk()], { headers: EXTENT_HEADERS }),
    )
    vi.stubGlobal('fetch', fetcher)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:dsh/archive')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const controller = new SessionLogDownloadController()

    await controller.download(SID)

    expect((fetcher.mock.calls[0]?.[0] as URL).origin).toBe('http://dsh.internal')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' })
    expect(click).toHaveBeenCalledOnce()
    expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe('dsh-session-fixture.zip')
    expect((createObjectURL.mock.calls[0]?.[0] as Blob).size).toBe(20)
    expect(revokeObjectURL).not.toHaveBeenCalled()
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:dsh/archive')
  })

  it('defaults panel openness when state is externally cleared before settlement', async () => {
    const settled = heldArchive({ headers: EXTENT_HEADERS })
    const successful = new SessionLogDownloadController(async () => settled.response, vi.fn())
    const successRun = successful.download(SID)
    await vi.waitFor(() => {
      expect(successful.store.getSnapshot().bySession[SID]?.status).toBe('downloading')
    })
    successful.store.set({ bySession: {} })
    settled.push(entryChunk())
    settled.close()
    await successRun
    expect(successful.store.getSnapshot().bySession[SID]?.open).toBe(true)

    const failure = Promise.withResolvers<Response>()
    const failing = new SessionLogDownloadController(() => failure.promise, vi.fn())
    const failureRun = failing.download(SID)
    failing.store.set({ bySession: {} })
    failure.reject(new Error('failed after clear'))
    await failureRun
    expect(failing.store.getSnapshot().bySession[SID]).toEqual({
      open: true,
      status: 'error',
      error: 'failed after clear',
      progress: { fraction: null, entriesDone: 0, entriesTotal: null, receivedBytes: 0 },
    })
  })
})

describe('browser download helpers', () => {
  it('sanitizes the fallback archive filename', () => {
    expect(sessionLogZipFilename('a/b' as SessionId)).toBe('dsh-session-a_b.zip')
  })

  it('reads the host filename from Content-Disposition and rejects unusable ones', () => {
    expect(filenameFromContentDisposition(null)).toBeNull()
    expect(filenameFromContentDisposition('attachment')).toBeNull()
    expect(filenameFromContentDisposition('attachment; filename="dsh-session-a.zip"')).toBe('dsh-session-a.zip')
    expect(filenameFromContentDisposition('attachment; Filename=dsh-session-b.zip; size=1')).toBe('dsh-session-b.zip')
    expect(filenameFromContentDisposition('attachment; filename=""')).toBeNull()
    expect(filenameFromContentDisposition('attachment; filename=".."')).toBeNull()
    expect(filenameFromContentDisposition('attachment; filename="."')).toBeNull()
    expect(filenameFromContentDisposition('attachment; filename="../../etc/passwd"')).toBeNull()
    expect(filenameFromContentDisposition('attachment; filename="a\\b.zip"')).toBeNull()
  })

  it('prefers an RFC 5987 filename and falls back when it is unusable', () => {
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8''dsh-%E4%BC%9A%E8%AF%9D.zip"))
      .toBe('dsh-会话.zip')
    expect(filenameFromContentDisposition(
      "attachment; filename=\"plain.zip\"; filename*=UTF-8'zh-CN'starred.zip",
    )).toBe('starred.zip')
    // A truncated percent-escape cannot be decoded; the plain parameter answers.
    expect(filenameFromContentDisposition("attachment; filename=\"plain.zip\"; filename*=UTF-8''%E4%BC.zip"))
      .toBe('plain.zip')
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8''%E4%BC.zip")).toBeNull()
    // A decodable but unusable extended name also falls back.
    expect(filenameFromContentDisposition("attachment; filename=\"plain.zip\"; filename*=UTF-8''%2E%2E"))
      .toBe('plain.zip')
  })

  it('hands the assembled archive to a download anchor and revokes its URL one task later', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:dsh/one')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    downloadBlob(new Blob([new Uint8Array([1, 2, 3])], { type: 'application/zip' }), 'archive.zip')

    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    const anchor = click.mock.instances[0] as HTMLAnchorElement
    expect(anchor.getAttribute('href')).toBe('blob:dsh/one')
    expect(anchor.download).toBe('archive.zip')
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:dsh/one')
  })
})
