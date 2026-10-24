/**
 * The `Files` section of a rebuild message: which of the session's earlier
 * reads are still worth restating, and in what form.
 *
 * A changed full read is restated as current content; an unchanged full read
 * is one line and repeats no content; a window, a missing/unreadable file, or
 * a file over the inspection ceiling is a compact reference the model can
 * re-read. The section carries at most five files and two thousand characters
 * so it shares the message budget with the task-state sections.
 *
 * @module @deepseek-ai/dsh-compaction-rehydration/file-section
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { classifyRead, readRegistry } from './read-registry.ts'
import type { ReadClassification, ReadFsLike, ReadRecord, ReadReferenceReason } from './read-registry.ts'

/** Most files one Files section may list. */
export const FILE_COUNT_LIMIT = 5

/** Most characters one Files section may carry before the total budget applies. */
export const FILE_SECTION_LIMIT = 2000

/** Most characters of one changed file restated as content. */
export const FILE_CONTENT_LIMIT = 1200

/** Drop the last newline so a fenced block does not end with a blank line. */
function trimFinalNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

/** Whether a recorded path looks like a credential store rather than source text. */
function isSensitivePath(path: string): boolean {
  const lower = path.toLowerCase()
  const base = lower.slice(lower.lastIndexOf('/') + 1)
  if (base === '.env' || base.startsWith('.env.')) return true
  if (base === 'id_rsa' || base.startsWith('id_rsa.')) return true
  if (base.endsWith('.pem') || base.endsWith('.key') || base.endsWith('.p12') || base.endsWith('.pfx')) return true
  if (base.startsWith('credentials') || base.startsWith('secrets')) return true
  return lower.includes('/.ssh/') || lower.includes('/.aws/') || lower.includes('/.gnupg/')
}

/** One line naming a file the model does not need the content of. */
function referenceLine(path: string, reason: ReadReferenceReason): string {
  const detail = reason === 'missing'
    ? 'not found now'
    : reason === 'unreadable'
      ? 'not readable now'
      : reason === 'not-file'
        ? 'no longer a regular file'
        : reason === 'partial-window'
          ? 'only a window was read earlier'
          : reason === 'changed-window'
            ? 'changed and only a window was read earlier'
            : reason === 'oversized'
              ? 'too large to restate here'
              : 'its state cannot be checked here'
  return `- \`${path}\` — ${detail}; read it again if needed.`
}

/** Render current content for one changed file, bounded and fenced safely. */
function contentBlock(path: string, record: ReadRecord, text: string): string {
  const trimmed = trimFinalNewline(text)
  const bounded = trimmed.length <= FILE_CONTENT_LIMIT
    ? trimmed
    : `${trimmed.slice(0, FILE_CONTENT_LIMIT - '… (truncated)'.length)}… (truncated)`
  const fence = bounded.includes('```') ? '````' : '```'
  return `### \`${path}\`\nChanged since your read at seq ${String(record.readSeq)}.\n${fence}text\n${bounded}\n${fence}`
}

/** Render the entry for one classified file, or `undefined` when it should be skipped. */
function entryFor(classification: ReadClassification): string | undefined {
  const { record } = classification
  if (classification.kind === 'already_read_file') {
    return `- \`${record.path}\` — unchanged since your read at seq ${String(record.readSeq)}; content not repeated.`
  }
  if (classification.kind === 'file') return contentBlock(record.path, record, classification.text)
  return referenceLine(record.path, classification.reason)
}

/**
 * Build the `Files` section of a rebuild message.
 *
 * Candidates are the session's own newest reads, one per path. Sensitive
 * locations (credential stores) are skipped entirely, not named. Entries are
 * added until the section budget or the file count runs out; an entry that
 * does not fit falls back to its reference line, then stops the section.
 * @param session - Session whose own log supplies the reads.
 * @param ctx - context that may expose the optional `fs` service.
 * @returns the section, or undefined when no read can be restated or checked.
 */
export async function fileSection(session: Session, ctx: Context): Promise<{ readonly name: 'files'; readonly heading: string; readonly text: string } | undefined> {
  const fs = ctx.get('fs') as ReadFsLike | undefined
  if (fs === undefined) return undefined
  const records = readRegistry(session).records.filter(record => !isSensitivePath(record.path))
  if (records.length === 0) return undefined
  const lines: string[] = []
  let used = 0
  for (const record of records.slice(0, FILE_COUNT_LIMIT)) {
    const classification = await classifyRead(record, fs)
    const entry = entryFor(classification)
    if (entry === undefined) continue
    const cost = entry.length + 2
    if (used + cost > FILE_SECTION_LIMIT) {
      if (classification.kind !== 'compact_file_reference') {
        const fallback = referenceLine(record.path, 'oversized')
        if (used + fallback.length + 2 <= FILE_SECTION_LIMIT) {
          lines.push(fallback)
          used += fallback.length + 2
        }
      }
      break
    }
    lines.push(entry)
    used += cost
  }
  if (lines.length === 0) return undefined
  return { name: 'files', heading: 'Files read earlier', text: lines.join('\n\n') }
}
