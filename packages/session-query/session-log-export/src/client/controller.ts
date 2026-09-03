/** Browser download state shared by the Session Header button and `/export`. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  readSessionLogExportExtent,
  SESSION_EXPORT_PROGRESS_START,
  SessionExportProgressTracker,
  type SessionExportProgress,
} from './progress.ts'

/** Download phases presented by the shared panel. */
export type SessionLogDownloadStatus = 'downloading' | 'success' | 'error'

/** One Session's current download-panel state. */
export interface SessionLogDownloadEntry {
  readonly open: boolean
  readonly status: SessionLogDownloadStatus
  readonly error: string | null
  readonly progress: SessionExportProgress
}

/** Download states keyed by the Session whose Header owns the panel. */
export interface SessionLogDownloadState {
  bySession: Record<string, SessionLogDownloadEntry | undefined>
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>
type Save = (archive: Blob, filename: string) => void

const INITIAL: SessionLogDownloadState = { bySession: {} }

/** `filename=` parameter of a Content-Disposition header, quoted or bare. */
const CONTENT_DISPOSITION_FILENAME = /;\s*filename\s*=\s*(?:"([^"\r\n]*)"|([^;\r\n]*))/i

/** RFC 5987 `filename*=` parameter: charset, optional language, percent-encoded name. */
const CONTENT_DISPOSITION_FILENAME_STAR = /;\s*filename\*\s*=\s*[\w-]*'[^']*'([^;\r\n]*)/i

/**
 * Collapse an untrusted Session id into the filename convention owned by the host endpoint.
 * @param sessionId - Session whose archive is downloaded.
 * @returns one safe browser download filename.
 */
export function sessionLogZipFilename(sessionId: SessionId): string {
  return `dsh-session-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.zip`
}

/**
 * Accept one candidate filename, or reject it as unusable.
 * @param candidate - the raw parameter value.
 * @returns the trimmed filename, or `null` when it is empty, a dot segment, or
 * carries a path separator.
 */
function usableFilename(candidate: string): string | null {
  const filename = candidate.trim()
  if (filename === '' || filename === '.' || filename === '..') return null
  return /[/\\]/.test(filename) ? null : filename
}

/**
 * Decode an RFC 5987 parameter value. The charset label is not honored:
 * every value this route sends is UTF-8, which is what `decodeURIComponent`
 * assumes.
 * @param encoded - the percent-encoded value.
 * @returns the decoded text, or `null` when the escapes are malformed.
 */
function decodeExtendedValue(encoded: string): string | null {
  try {
    return decodeURIComponent(encoded)
  } catch {
    // A malformed percent-escape from the wire; the plain parameter, or the
    // caller's own filename, answers instead.
    return null
  }
}

/**
 * Read the archive filename the host endpoint named for this download,
 * preferring the RFC 5987 `filename*` parameter over the plain one.
 * @param header - the response's Content-Disposition value, if any.
 * @returns the filename, or `null` when the header names none or names one
 * that is empty or not a single path segment.
 */
export function filenameFromContentDisposition(header: string | null): string | null {
  if (header === null) return null
  const [, encoded] = CONTENT_DISPOSITION_FILENAME_STAR.exec(header) ?? []
  const decoded = encoded === undefined ? null : decodeExtendedValue(encoded)
  const extended = decoded === null ? null : usableFilename(decoded)
  if (extended !== null) return extended
  const [, quoted, bare] = CONTENT_DISPOSITION_FILENAME.exec(header) ?? []
  return usableFilename(quoted ?? bare ?? '')
}

/**
 * Hand one downloaded archive to the browser save flow.
 * @param archive - the received ZIP bytes.
 * @param filename - browser download filename.
 */
export function downloadBlob(archive: Blob, filename: string): void {
  const url = URL.createObjectURL(archive)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  // Revoking in the same task can race the browser's read of the anchor's
  // href; one task later the save has been handed off.
  setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}

/** Resolve the browser's Host base with the connection carrier's null-origin fallback. */
function hostBase(): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Owns one in-flight browser download per Session and publishes panel state. */
export class SessionLogDownloadController {
  /**
   * uSES-safe state source shared by every Session-scoped panel contribution.
   * Frame-batched: an archive arrives in many chunks and each one republishes
   * progress, so subscribers are notified once per animation frame instead of
   * once per chunk.
   */
  readonly store: SnapshotStore<SessionLogDownloadState> = createSnapshotStore(INITIAL, { flush: 'raf' })

  private readonly active = new Map<SessionId, { readonly abort: AbortController; readonly done: Promise<void> }>()
  private disposed = false

  /**
   * @param fetcher - HTTP carrier used to read the host-streamed ZIP.
   * @param save - browser save operation.
   */
  constructor(
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
    private readonly save: Save = downloadBlob,
  ) {}

  /**
   * Download one Session tree; concurrent gestures for the same Session share one operation.
   * @param sessionId - root Session whose ZIP includes descendants and attachments.
   * @returns after the browser save starts, an error state is published, the
   * download is cancelled, or a late post-disposal request is ignored.
   */
  download(sessionId: SessionId): Promise<void> {
    const existing = this.active.get(sessionId)
    if (existing !== undefined) return existing.done
    if (this.disposed) return Promise.resolve()
    const abort = new AbortController()
    const done = this.run(sessionId, abort.signal).finally(() => {
      this.active.delete(sessionId)
    })
    this.active.set(sessionId, { abort, done })
    return done
  }

  /**
   * Close one Session's panel without cancelling its download; the archive
   * still arrives and is still saved.
   * @param sessionId - Session whose panel closes.
   */
  dismiss(sessionId: SessionId): void {
    const current = this.store.getSnapshot().bySession[String(sessionId)]
    if (current === undefined || !current.open) return
    this.publish(sessionId, { ...current, open: false })
  }

  /**
   * Abandon one Session's download: the transfer is aborted, nothing is saved,
   * and the Session returns to its idle state.
   * @param sessionId - Session whose download is abandoned.
   */
  cancel(sessionId: SessionId): void {
    this.active.get(sessionId)?.abort.abort()
    this.clear(sessionId)
  }

  /**
   * Abort active fetches and reach quiescence.
   * @returns after every active operation settles.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    const active = [...this.active.values()]
    for (const operation of active) operation.abort.abort()
    await Promise.allSettled(active.map(operation => operation.done))
  }

  private async run(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    this.publish(sessionId, {
      open: true, status: 'downloading', error: null, progress: SESSION_EXPORT_PROGRESS_START,
    })
    try {
      const url = new URL('/api/session.export', hostBase())
      url.searchParams.set('sessionId', sessionId)
      url.searchParams.set('includeDescendants', 'true')
      const response = await this.fetcher(url, { method: 'GET', signal })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`HTTP ${response.status}${detail === '' ? '' : ` ${detail}`}`)
      }
      const body = response.body
      if (body === null) throw new Error('The host sent no archive stream.')
      const tracker = new SessionExportProgressTracker(readSessionLogExportExtent(response.headers))
      const reader = body.getReader()
      const chunks: Uint8Array<ArrayBuffer>[] = []
      for (;;) {
        const read = await reader.read()
        if (read.done) break
        chunks.push(read.value)
        this.progressed(sessionId, tracker.push(read.value))
      }
      // A cancellation that lands between the final read and the save would
      // otherwise still hand the archive to the browser.
      signal.throwIfAborted()
      this.save(
        new Blob(chunks, { type: 'application/zip' }),
        filenameFromContentDisposition(response.headers.get('content-disposition'))
          ?? sessionLogZipFilename(sessionId),
      )
      const open = this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true
      this.publish(sessionId, { open, status: 'success', error: null, progress: tracker.complete() })
    } catch (error: unknown) {
      if (signal.aborted) {
        this.clear(sessionId)
        return
      }
      const current = this.store.getSnapshot().bySession[String(sessionId)]
      this.publish(sessionId, {
        open: current?.open ?? true,
        status: 'error',
        error: messageOf(error),
        progress: current?.progress ?? SESSION_EXPORT_PROGRESS_START,
      })
    }
  }

  private progressed(sessionId: SessionId, progress: SessionExportProgress): void {
    const current = this.store.getSnapshot().bySession[String(sessionId)]
    if (current === undefined) return
    this.publish(sessionId, { ...current, progress })
  }

  private publish(sessionId: SessionId, entry: SessionLogDownloadEntry): void {
    this.store.update((state) => {
      state.bySession = { ...state.bySession, [String(sessionId)]: entry }
    })
  }

  private clear(sessionId: SessionId): void {
    this.store.update((state) => {
      state.bySession = { ...state.bySession, [String(sessionId)]: undefined }
    })
  }
}
