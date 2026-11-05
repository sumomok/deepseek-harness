/**
 * The `Files` section of a rebuild message: which of the session's earlier
 * reads are still worth restating, and in what form.
 *
 * Two rules bound what may appear. First, a path must be inside the Session's
 * working directory; a Session without one, or a read outside it, contributes
 * nothing at all — not even an unchanged path name. Second, known credential
 * locations are omitted entirely even inside the workspace. Everything else
 * follows freshness: a changed full read is restated as current content, an
 * unchanged full read is one line and repeats no content, and a window, a
 * missing/unreadable file, or a file over the inspection ceiling is a compact
 * reference the model can re-read. Filename matching is best-effort; the
 * durable safety boundary for unknown secrets is the workspace plus the
 * deployment's deny rules, not this list.
 *
 * The section carries at most five files and two thousand characters so it
 * shares the message budget with the task-state sections.
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

/** Directory components (anywhere below the workspace) that hold credentials. */
const SENSITIVE_DIRECTORIES = new Set([
  '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.config/gcloud', '.config/gh',
  'secrets', 'credentials',
])

/** Basenames at any depth that hold credentials. */
const SENSITIVE_BASENAMES = new Set([
  '.npmrc', '.netrc', '.git-credentials', '.htpasswd', '.pgpass',
  'application_default_credentials.json',
])

/**
 * Whether a recorded path looks like a credential store rather than source text.
 *
 * Matching is intentionally conservative and never a proof: an unknown secret
 * with an ordinary name is caught only by its workspace and the deployment's
 * deny rules. Directory components are checked as well as the basename so
 * `secrets/api_key.txt` and `.config/gcloud/application_default_credentials.json`
 * are covered, with `\` normalized so Windows-shaped paths match too.
 * @param path - the recorded process path.
 * @returns whether the Files section must omit this path entirely.
 */
function isSensitivePath(path: string): boolean {
  const normalized = path.toLowerCase().replaceAll('\\', '/')
  const parts = normalized.split('/').filter(part => part.length > 0)
  const base = parts.at(-1) ?? ''
  if (SENSITIVE_BASENAMES.has(base)) return true
  if (base === '.env' || base.startsWith('.env.')) return true
  if (base === 'id_rsa' || base.startsWith('id_rsa.')) return true
  if (base.endsWith('.pem') || base.endsWith('.key') || base.endsWith('.p12') || base.endsWith('.pfx')) return true
  if (base.startsWith('credentials') || base.startsWith('secrets')) return true
  if (parts.some((part, index) => index < parts.length - 1 && SENSITIVE_DIRECTORIES.has(part))) return true
  // Two-component credential homes are checked on the joined suffix.
  return normalized.includes('/.config/gcloud/') || normalized.includes('/.config/gh/')
}

/** Normalize a path for lexical containment when the backend exposes no `contains`. */
function normalizePath(path: string): string {
  const slashed = path.replaceAll('\\', '/')
  return slashed.length > 1 && slashed.endsWith('/') ? slashed.slice(0, -1) : slashed
}

/** Whether a recorded path is lexically the workspace or below it. */
function pathWithin(cwd: string, path: string): boolean {
  const workspace = normalizePath(cwd)
  const candidate = normalizePath(path)
  return candidate === workspace || candidate.startsWith(`${workspace}/`)
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
  const cwd = session.header.cwd
  if (cwd === undefined || cwd.trim() === '') return undefined
  let workspaceTarget: object
  try {
    workspaceTarget = await fs.resolve(cwd)
  } catch {
    // Without a resolvable workspace no candidate can be proven inside it.
    return undefined
  }
  const candidates = readRegistry(session).records.filter(record => !isSensitivePath(record.path))
  if (candidates.length === 0) return undefined
  const insideWorkspace = async (path: string): Promise<object | undefined> => {
    try {
      const target = await fs.resolve(path)
      const contained = fs.contains !== undefined
        ? fs.contains(workspaceTarget, target)
        : pathWithin(cwd, path)
      return contained ? target : undefined
    } catch {
      // A path that cannot be resolved cannot be proven inside the workspace.
      return undefined
    }
  }
  const records: ReadRecord[] = []
  for (const record of candidates) {
    if (await insideWorkspace(record.path) !== undefined) records.push(record)
  }
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
