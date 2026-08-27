/**
 * Client-side pre-sniff: text vs binary, decided from a byte probe read off
 * the front of a dropped/pasted `File` — the same NUL-byte-then-UTF-8 test
 * `@deepseek-ai/dsh-attachment-local`'s authoritative `detectText` runs
 * server-side, duplicated here rather than imported: that package is
 * Node-only (a `sharp` peer, filesystem paths), so a client bundle cannot
 * depend on it. This sniff exists only to split a dropped/pasted batch for
 * UX — routing text-sniffable files away from the image path's all-or-
 * nothing format toast — before any file ever reaches the durable
 * attachment seam; the seam's own validation is authoritative and the only
 * one that can reject a submission.
 *
 * @module @deepseek-ai/dsh-client-ui-conversation/client/file-sniff
 */

/** Bytes read from the front of a file before deciding text vs binary. */
const PROBE_BYTES = 8192

/**
 * Whether `file`'s leading bytes look like text: no NUL byte, and the probe
 * decodes as valid UTF-8 (a `stream: true` decode tolerates a multi-byte
 * sequence split at the probe's own edge instead of misreading a boundary
 * cut as invalid).
 * @param file - the file to probe; only its first {@link PROBE_BYTES} bytes are read.
 * @returns whether the file is worth routing to the text-file draft path.
 */
export async function sniffIsText(file: File): Promise<boolean> {
  const probe = new Uint8Array(await file.slice(0, PROBE_BYTES).arrayBuffer())
  if (probe.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(probe, { stream: true })
  } catch {
    return false
  }
  return true
}

/** One dropped/pasted batch, split by content sniff. */
export interface PartitionedFiles {
  /** Files that sniff as text — candidates for the file-attachment draft path. */
  readonly texts: readonly File[]
  /** Everything else — images and other binaries, routed to the existing image path unchanged. */
  readonly other: readonly File[]
}

/**
 * Split one dropped/pasted batch by content sniff, so a batch mixing images
 * and text files no longer rejects everything through the image path's
 * whole-batch format check: only the non-text remainder reaches it.
 * @param files - the batch, in drop/paste order.
 * @returns the split, preserving order within each side.
 */
export async function partitionDroppedFiles(files: readonly File[]): Promise<PartitionedFiles> {
  const sniffed = await Promise.all(files.map(async file => ({ file, isText: await sniffIsText(file) })))
  const texts: File[] = []
  const other: File[] = []
  for (const { file, isText } of sniffed) (isText ? texts : other).push(file)
  return { texts, other }
}
