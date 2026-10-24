/**
 * Replayable read registry: the text files one Session read, the facts the log
 * kept about each read, and the freshness classification a consumer uses when
 * a checkpoint must decide what to restore.
 *
 * The registry folds only the Session's own events. A `read` call and its
 * result are paired by call id; the result's persisted `meta` carries the
 * window and, for reads written by this build, the filesystem version, size,
 * full/window marker, and window digest. A result the tool-result pruner
 * shadowed still has that meta, and the surface-lineage helper resolves the
 * original sequence so a recovery pointer stays valid.
 *
 * The version and digest fields are optional: logs written before they existed
 * fall back to a bounded re-read of the current file and a digest comparison.
 *
 * @module @deepseek-ai/dsh-compaction-rehydration/read-registry
 */

import { createHash } from 'node:crypto'
import { originalToolResultSeq } from '@deepseek-ai/dsh-compaction'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'

/** One line of a read window, as the tool persisted it. */
export interface ReadLine {
  /** 1-based line number in the file. */
  readonly number: number
  /** Line text without its trailing newline. */
  readonly text: string
}

/** How a read result classified itself when it was written. */
export type ReadCoverage = 'full' | 'window'

/** One successful `read` this Session recorded, latest write per path winning. */
export interface ReadRecord {
  /** The process path the tool reported. */
  readonly path: string
  /** 1-based first line the read returned. */
  readonly offset: number
  /** The returned lines. */
  readonly lines: readonly ReadLine[]
  /** Exact total line count seen by the read. */
  readonly totalLines: number
  /** Filesystem version token at read time, when the log carries it. */
  readonly version?: string
  /** File size at read time, when the backend reported it. */
  readonly size?: number
  /** Whether the read covered the whole file unmodified, when the log says. */
  readonly read?: ReadCoverage
  /** SHA-256 of the returned line window, when the log carries it. */
  readonly digest?: string
  /** Sequence of the original `tool/result` event (never a pruned replacement). */
  readonly readSeq: SessionSeq
  /** Sequence of the `tool/call` that requested the read. */
  readonly callSeq: SessionSeq
}

/** One failed `read` call, kept only to explain why a path is absent. */
export interface ReadFailure {
  /** The path the call asked for. */
  readonly path: string
  /** Sequence of the failed `tool/call`. */
  readonly callSeq: SessionSeq
}

/** Everything the log says about this Session's reads. */
export interface ReadRegistry {
  /** Successful reads, one per path, newest first. */
  readonly records: readonly ReadRecord[]
  /** Failed reads, newest first. */
  readonly failures: readonly ReadFailure[]
}

/** Structural view of the `fs` service the freshness check needs. */
export interface ReadFsLike {
  resolve(path: string, opts?: { signal?: AbortSignal }): Promise<object>
  stat(
    target: object,
    signal?: AbortSignal,
  ): Promise<{ readonly version: string; readonly size?: number; readonly type: string } | undefined>
  readText(target: object, signal?: AbortSignal): Promise<string>
}

/** Limits the freshness check applies before reading a file. */
export interface ReadClassificationOptions {
  /** Do not read a file larger than this many bytes; classify it as a reference. Default 256 KiB. */
  readonly maxInspectBytes?: number
}

/** Why a read cannot be restored as content. */
export type ReadReferenceReason =
  | 'missing'
  | 'unreadable'
  | 'not-file'
  | 'partial-window'
  | 'changed-window'
  | 'oversized'
  | 'unavailable'

/** The freshness decision for one recorded read. */
export type ReadClassification =
  | { readonly kind: 'already_read_file'; readonly record: ReadRecord }
  | { readonly kind: 'file'; readonly record: ReadRecord; readonly text: string }
  | { readonly kind: 'compact_file_reference'; readonly record: ReadRecord; readonly reason: ReadReferenceReason }

/** Default ceiling for reading a file just to compare freshness. */
export const MAX_INSPECT_BYTES = 256 * 1024

/** SHA-256 of a read window's line text, the form the tool persists. */
export function readWindowDigest(lines: readonly { readonly text: string }[]): string {
  return createHash('sha256').update(lines.map(line => line.text).join('\n'), 'utf8').digest('hex')
}

/**
 * Hash a whole decoded file the way a full read's window would hash it.
 * The tool persists lines without their trailing newline, so a file ending in
 * `\n` is compared without that final newline.
 * @param text - decoded file text.
 * @returns SHA-256 of the line-joined content.
 */
export function readTextDigest(text: string): string {
  return createHash('sha256').update(text.endsWith('\n') ? text.slice(0, -1) : text, 'utf8').digest('hex')
}

/** Parse one `read` call's arguments without trusting their JSON. */
function readCallArguments(raw: string): { readonly path: string; readonly offset: number } | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const path = record['file_path']
  const offset = record['offset']
  if (typeof path !== 'string' || path.length === 0) return undefined
  if (offset !== undefined && (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 1)) return undefined
  return { path, offset: typeof offset === 'number' ? offset : 1 }
}

/** Narrow the tool-private `meta` without trusting a persisted payload. */
function readMetaOf(meta: unknown): {
  readonly path: string
  readonly offset: number
  readonly lines: readonly ReadLine[]
  readonly totalLines: number
  readonly version?: string
  readonly size?: number
  readonly read?: ReadCoverage
  readonly digest?: string
} | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const record = meta as Record<string, unknown>
  const path = record['path']
  const offset = record['offset']
  const lines = record['lines']
  const totalLines = record['totalLines']
  if (typeof path !== 'string' || path.length === 0) return undefined
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 1) return undefined
  if (typeof totalLines !== 'number' || !Number.isInteger(totalLines) || totalLines < 0) return undefined
  if (!Array.isArray(lines)) return undefined
  const narrowed: ReadLine[] = []
  for (const line of lines) {
    if (typeof line !== 'object' || line === null) return undefined
    const entry = line as Record<string, unknown>
    if (typeof entry['number'] !== 'number' || typeof entry['text'] !== 'string') return undefined
    narrowed.push({ number: entry['number'], text: entry['text'] })
  }
  const version = record['version']
  const size = record['size']
  const read = record['read']
  const digest = record['digest']
  return {
    path,
    offset,
    lines: narrowed,
    totalLines,
    ...typeof version === 'string' ? { version } : {},
    ...typeof size === 'number' ? { size } : {},
    ...read === 'full' || read === 'window' ? { read } : {},
    ...typeof digest === 'string' ? { digest } : {},
  }
}

/**
 * Fold the Session's own log into the read registry.
 *
 * The newest successful read per path wins; a failed later read does not erase
 * the earlier success. Pruned replacements keep their persisted meta, and their
 * cited original sequence is what a recovery pointer must name.
 * @param session - Session whose own events are folded.
 * @returns successful reads newest first and failed reads newest first.
 */
export function readRegistry(session: Session): ReadRegistry {
  const calls = new Map<string, { readonly path: string; readonly offset: number; readonly seq: SessionSeq }>()
  const records = new Map<string, ReadRecord>()
  const failures: ReadFailure[] = []
  for (const event of session.ownEvents()) {
    if (event.type === 'tool/call' && event.data.name === 'read') {
      const parsed = readCallArguments(event.data.arguments)
      if (parsed !== undefined) calls.set(String(event.data.callId), { ...parsed, seq: event.seq })
      continue
    }
    if (event.type !== 'tool/result') continue
    const callId = String(event.data.message.toolCallId)
    const call = calls.get(callId)
    if (call === undefined) continue
    if (event.data.message.isError === true) {
      failures.push({ path: call.path, callSeq: call.seq })
      continue
    }
    const meta = readMetaOf(event.data.meta)
    if (meta === undefined) continue
    const readSeq = originalToolResultSeq(session, event.seq) ?? event.seq
    records.set(meta.path, {
      ...meta,
      readSeq,
      callSeq: call.seq,
    })
  }
  const newestFirst = <T extends { readonly readSeq?: SessionSeq; readonly callSeq: SessionSeq }>(entries: readonly T[]): T[] =>
    [...entries].sort((left, right) => Number(right.callSeq) - Number(left.callSeq))
  return {
    records: newestFirst([...records.values()]).map(record => record),
    failures: failures.reverse(),
  }
}

/**
 * Test one recorded read against the current file.
 *
 * A recorded version that still matches decides without reading content. An
 * older log without a version is compared by digest after one bounded read.
 * Only a whole-file record can become `already_read_file`; a recorded window,
 * a changed file whose window cannot be reproduced, an absent or unreadable
 * file, and a file over the inspection ceiling all become references.
 * @param record - the recorded read to check.
 * @param fs - the filesystem service, or undefined when the deployment has none.
 * @param options - inspection ceiling.
 * @returns the restoration decision for this file.
 */
export async function classifyRead(
  record: ReadRecord,
  fs: ReadFsLike | undefined,
  options: ReadClassificationOptions = {},
): Promise<ReadClassification> {
  const reference = (reason: ReadReferenceReason): ReadClassification =>
    ({ kind: 'compact_file_reference', record, reason })
  if (fs === undefined) return reference('unavailable')
  const maxInspectBytes = options.maxInspectBytes ?? MAX_INSPECT_BYTES
  let target: object
  try {
    target = await fs.resolve(record.path)
  } catch {
    return reference('unreadable')
  }
  let info
  try {
    info = await fs.stat(target)
  } catch {
    return reference('unreadable')
  }
  if (info === undefined) return reference('missing')
  if (info.type !== 'file') return reference('not-file')
  const full = record.read === 'full' || (record.read === undefined && legacyFull(record))
  if (!full) return reference('partial-window')
  if (record.version !== undefined) {
    if (info.version === record.version) return { kind: 'already_read_file', record }
    return (await boundedText(record, target, fs, maxInspectBytes)) ?? reference('oversized')
  }
  if (info.size !== undefined && info.size > maxInspectBytes) return reference('oversized')
  let text: string
  try {
    text = await fs.readText(target)
  } catch {
    return reference('unreadable')
  }
  const expected = record.digest ?? readWindowDigest(record.lines)
  if (readTextDigest(text) === expected) return { kind: 'already_read_file', record }
  return { kind: 'file', record, text }
}

/** A log without the coverage marker: full only when the window clearly covers the file. */
function legacyFull(record: ReadRecord): boolean {
  if (record.offset !== 1) return false
  if (record.lines.length !== record.totalLines) return false
  return !record.lines.some(line => /\.\.\. \(line truncated to \d+ chars\)$/u.test(line.text))
}

/** Read a changed file as content when it stays under the inspection ceiling. */
async function boundedText(
  record: ReadRecord,
  target: object,
  fs: ReadFsLike,
  maxInspectBytes: number,
): Promise<ReadClassification | undefined> {
  let info
  try {
    info = await fs.stat(target)
  } catch {
    return { kind: 'compact_file_reference', record, reason: 'unreadable' }
  }
  if (info !== undefined && info.size !== undefined && info.size > maxInspectBytes) return undefined
  try {
    return { kind: 'file', record, text: await fs.readText(target) }
  } catch {
    return { kind: 'compact_file_reference', record, reason: 'unreadable' }
  }
}
