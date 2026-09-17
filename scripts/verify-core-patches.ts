/**
 * Check that this fork's patch line and its registry name the same patches.
 *
 * Every commit above `upstream/master` carries exactly one `Patch: <slug>`
 * trailer, and every slug a commit names is registered in
 * `.claude/core-patches.md`; every registered slug whose status still stands on
 * this line — `在役` or `局部退役` — has at least one commit on the line. The two
 * directions are checked together, so a renamed slug fails on both sides rather
 * than silently splitting one patch into two records.
 *
 * Commit hashes cannot carry patch identity here: every rolling sync rebases the
 * whole line onto a new upstream base, so each hash is replaced, and upstream's
 * `verify-repository-references` rejects hashes in maintained prose. The trailer
 * and the registry slug survive a rebase because they are commit message text.
 *
 * Without an `upstream/master` ref — a shallow clone, or a checkout with no
 * upstream remote configured — the line's extent is unknown, so the check
 * reports `skipped: no upstream/master ref` and exits 0 rather than guessing a
 * base.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')

/** Registry path, relative to the repository root. */
export const REGISTRY_PATH = '.claude/core-patches.md'

/** The statuses a registry record may declare. */
export const PATCH_STATUSES = ['在役', '局部退役', '退役'] as const

/** One registry record's declared status. */
export type PatchStatus = (typeof PATCH_STATUSES)[number]

/** One registered patch family. */
export interface PatchRecord {
  /** Registry slug, unique across the file. */
  slug: string
  /** Human title on the same heading line. */
  title: string
  /** Declared status, or null when the record states none. */
  status: PatchStatus | null
}

/** One commit on the line above `upstream/master`. */
export interface LineCommit {
  /** Commit identifier, for diagnostics only. */
  id: string
  /** Subject line, for diagnostics only. */
  subject: string
  /** Every `Patch:` trailer value the message carries, in order. */
  slugs: string[]
}

/** One disagreement between the line and the registry. */
export interface RegistryViolation {
  /** What disagrees. */
  kind: 'trailer-count' | 'unregistered-slug' | 'unused-active-slug' | 'duplicate-slug' | 'missing-status'
  /** Commit id for commit-side findings, slug for registry-side findings. */
  subject: string
  /** Complete, self-contained description. */
  detail: string
}

const HEADING = /^## ([a-z0-9]+(?:-[a-z0-9]+)*) — (.+)$/u
const STATUS = /^- \*\*状态\*\*：(在役|局部退役|退役)/u
const TRAILER = /^Patch:[ \t]*(\S+)[ \t]*$/u

/**
 * Read every patch record out of the registry's Markdown.
 * @param source - the registry file contents.
 * @returns records in file order, including duplicates so the caller can report them.
 */
export function parseRegistry(source: string): PatchRecord[] {
  const records: PatchRecord[] = []
  let current: PatchRecord | undefined
  for (const line of source.split('\n')) {
    const heading = HEADING.exec(line)
    if (heading !== null) {
      const [, slug = '', title = ''] = heading
      current = { slug, title, status: null }
      records.push(current)
      continue
    }
    if (line.startsWith('## ')) {
      // A heading that is not a patch record (the file's own explanatory
      // sections) closes the previous record so its status cannot leak forward.
      current = undefined
      continue
    }
    const status = current !== undefined && current.status === null ? STATUS.exec(line) : null
    if (status !== null && current !== undefined) current.status = status[1] as PatchStatus
  }
  return records
}

/**
 * Collect the `Patch:` trailer values of one commit message.
 * @param message - the raw commit message body.
 * @returns every value, in message order.
 */
export function patchTrailers(message: string): string[] {
  const slugs: string[] = []
  for (const line of message.split('\n')) {
    const match = TRAILER.exec(line.trimEnd())
    if (match?.[1] !== undefined) slugs.push(match[1])
  }
  return slugs
}

/**
 * Compare the line against the registry in both directions.
 * @param commits - every commit above the upstream base, newest first or oldest first.
 * @param records - the registry's records, in file order.
 * @returns one violation per disagreement; empty when the two agree.
 */
export function findRegistryViolations(
  commits: readonly LineCommit[],
  records: readonly PatchRecord[],
): RegistryViolation[] {
  const violations: RegistryViolation[] = []
  const seen = new Set<string>()
  for (const record of records) {
    if (seen.has(record.slug)) {
      violations.push({
        kind: 'duplicate-slug',
        subject: record.slug,
        detail: `${REGISTRY_PATH} registers ${record.slug} more than once; one slug names one patch family.`,
      })
    }
    seen.add(record.slug)
    if (record.status === null) {
      violations.push({
        kind: 'missing-status',
        subject: record.slug,
        detail: `${REGISTRY_PATH} record ${record.slug} declares no 状态 line (expected one of ${PATCH_STATUSES.join(' / ')}).`,
      })
    }
  }
  const used = new Set<string>()
  for (const commit of commits) {
    if (commit.slugs.length !== 1) {
      violations.push({
        kind: 'trailer-count',
        subject: commit.id,
        detail: `${commit.id} (${commit.subject}) carries ${String(commit.slugs.length)} Patch trailers; every commit on this line carries exactly one.`,
      })
      continue
    }
    const [slug = ''] = commit.slugs
    used.add(slug)
    if (!seen.has(slug)) {
      violations.push({
        kind: 'unregistered-slug',
        subject: commit.id,
        detail: `${commit.id} (${commit.subject}) names Patch: ${slug}, which ${REGISTRY_PATH} does not register.`,
      })
    }
  }
  for (const record of records) {
    if ((record.status === '在役' || record.status === '局部退役') && !used.has(record.slug)) {
      violations.push({
        kind: 'unused-active-slug',
        subject: record.slug,
        detail: `${REGISTRY_PATH} records ${record.slug} as ${record.status}, but no commit above upstream/master names it.`,
      })
    }
  }
  return violations
}

/**
 * Resolve whether the repository has the upstream base this check needs.
 * @param repoRoot - repository root directory.
 * @returns true when `upstream/master` resolves to an object.
 */
function hasUpstreamBase(repoRoot: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'upstream/master^{commit}'], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch {
    // rev-parse exits non-zero for an unknown ref; no other failure mode reaches
    // here, because the working directory is this repository.
    return false
  }
}

/**
 * Read the commits above `upstream/master` with their `Patch:` trailers.
 * @param repoRoot - repository root directory.
 * @returns one entry per commit, oldest first.
 */
function lineCommits(repoRoot: string): LineCommit[] {
  const raw = execFileSync('git', ['log', '--reverse', '--format=%H%x1f%s%x1f%B%x1e', 'upstream/master..HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return raw.split('\x1e').map(entry => entry.replace(/^\n/u, '')).filter(entry => entry !== '')
    .map((entry) => {
      const [id = '', subject = '', message = ''] = entry.split('\x1f')
      return { id: id.slice(0, 10), subject, slugs: patchTrailers(message) }
    })
}

function main(): void {
  if (!hasUpstreamBase(root)) {
    process.stdout.write('verify-core-patches: skipped: no upstream/master ref\n')
    return
  }
  const records = parseRegistry(readFileSync(resolve(root, REGISTRY_PATH), 'utf8'))
  const commits = lineCommits(root)
  const violations = findRegistryViolations(commits, records)
  if (violations.length > 0) {
    process.stderr.write('verify-core-patches: the patch line and its registry disagree:\n')
    for (const violation of violations) process.stderr.write(`  ${violation.kind}: ${violation.detail}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(
    `verify-core-patches: ${String(commits.length)} commit(s) and ${String(records.length)} registry record(s) agree.\n`,
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
