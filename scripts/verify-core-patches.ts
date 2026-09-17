/**
 * Check that this fork's patch line and its registry name the same patches.
 *
 * Every commit above `upstream/master` carries exactly one `Patch: <slug>`
 * trailer, and every slug a commit names is registered in
 * `.claude/core-patches.md`; every registered slug whose status still stands on
 * this line — `在役` or `局部退役` — has at least one commit on the line, and
 * every slug the registry retires has none. The directions are checked
 * together, so a renamed slug fails on both sides rather than silently
 * splitting one patch into two records, and a record that declares a patch
 * retired while its commits remain fails rather than passing.
 *
 * Commit hashes cannot carry patch identity here: every rolling sync rebases the
 * whole line onto a new upstream base, so each hash is replaced, and upstream's
 * `verify-repository-references` rejects hashes in maintained prose. The trailer
 * and the registry slug survive a rebase because they are commit message text.
 * Trailers are read through git's own `%(trailers:key=Patch)`, so what this
 * check accepts is exactly what `git interpret-trailers` and every other
 * trailer consumer sees.
 *
 * The check only applies to the patch line itself. The registry names which
 * line that is, and a checkout on any other branch — `develop`, an integration
 * branch, a detached HEAD — reports `skipped` and exits 0, because commits
 * there carry no patch identity and are not meant to.
 *
 * Without an `upstream/master` ref — a shallow clone, or a checkout with no
 * upstream remote configured — the line's extent is unknown, so the check
 * reports `skipped: no upstream/master ref` and exits 0 rather than guessing a
 * base. CI checks out only `origin`, so this is what CI reaches: the check has
 * teeth on a maintainer's clone that configures the upstream remote, and
 * nowhere else.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/** Registry path, relative to the repository root. */
export const REGISTRY_PATH = '.claude/core-patches.md'

/** The statuses a registry record may declare. */
export const PATCH_STATUSES = ['在役', '局部退役', '退役'] as const

/** One registry record's declared status. */
export type PatchStatus = (typeof PATCH_STATUSES)[number]

/**
 * Level-2 headings the registry uses for its own prose rather than for a patch
 * record. Any other level-2 heading must parse as a record, so a typo in one
 * demotes the record to a reported violation instead of erasing it.
 */
export const NON_RECORD_HEADINGS = ['身份规则', '历史轮次'] as const

/** One registered patch family. */
export interface PatchRecord {
  /** Registry slug, unique across the file. */
  slug: string
  /** Human title on the same heading line. */
  title: string
  /** Declared status, or null when the record states none. */
  status: PatchStatus | null
}

/** The registry file as this check reads it. */
export interface Registry {
  /** Records in file order, including duplicates so the caller can report them. */
  records: PatchRecord[]
  /** Level-2 heading text that is neither a record nor a declared prose heading. */
  malformedHeadings: string[]
  /** The branch the registry declares as the current patch line, or null when it declares none. */
  declaredLine: string | null
}

/** One commit on the line above `upstream/master`. */
export interface LineCommit {
  /** Commit identifier, for diagnostics only. */
  id: string
  /** Subject line, for diagnostics only. */
  subject: string
  /** Parent count; anything above one is a merge. */
  parents: number
  /** Every `Patch:` trailer value git reads from the message, in order. */
  slugs: string[]
}

/** One disagreement between the line and the registry. */
export interface RegistryViolation {
  /** What disagrees. */
  kind:
    | 'trailer-count'
    | 'merge-commit'
    | 'unregistered-slug'
    | 'unused-active-slug'
    | 'retired-slug-in-use'
    | 'duplicate-slug'
    | 'missing-status'
    | 'malformed-heading'
  /** Commit id for commit-side findings, slug or heading text for registry-side findings. */
  subject: string
  /** Complete, self-contained description. */
  detail: string
}

/** How `upstream/master` relates to the checked-out line. */
export type UpstreamBase = 'missing' | 'stale' | 'base'

/** What one run of the check concluded. */
export interface CheckResult {
  /** `skipped` exits 0 without comparing; `ok` and `failed` report the comparison. */
  status: 'skipped' | 'ok' | 'failed'
  /** Complete, self-contained report, one finding per line, without a trailing newline. */
  report: string
}

const HEADING = /^## (.+)$/u
const RECORD_HEADING = /^([a-z0-9]+(?:-[a-z0-9]+)*) — (.+)$/u
const STATUS = /^- \*\*状态\*\*：(在役|局部退役|退役)/u
const DECLARED_LINE = /^\*\*当前补丁线\*\*：`([^`]+)`/u

/**
 * Read the registry's records, its malformed headings, and the line it declares.
 * @param source - the registry file contents.
 * @returns everything this check reads out of the file.
 */
export function parseRegistry(source: string): Registry {
  const records: PatchRecord[] = []
  const malformedHeadings: string[] = []
  let declaredLine: string | null = null
  let current: PatchRecord | undefined
  for (const line of source.split('\n')) {
    if (declaredLine === null) {
      const declared = DECLARED_LINE.exec(line)
      if (declared?.[1] !== undefined) declaredLine = declared[1]
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      const [, text = ''] = heading
      const record = RECORD_HEADING.exec(text)
      if (record !== null) {
        const [, slug = '', title = ''] = record
        current = { slug, title, status: null }
        records.push(current)
        continue
      }
      // A heading that is neither a record nor one of the file's own prose
      // sections closes the previous record so its status cannot leak forward,
      // and is reported: an unparsed heading would otherwise erase the record
      // it names, taking that record's checks with it.
      current = undefined
      if (!(NON_RECORD_HEADINGS as readonly string[]).includes(text)) malformedHeadings.push(text)
      continue
    }
    const status = current !== undefined && current.status === null ? STATUS.exec(line) : null
    if (status !== null && current !== undefined) current.status = status[1] as PatchStatus
  }
  return { records, malformedHeadings, declaredLine }
}

/**
 * Compare the line against the registry in both directions.
 * @param commits - every commit above the upstream base, in any order.
 * @param registry - the parsed registry.
 * @returns one violation per disagreement; empty when the two agree.
 */
export function findRegistryViolations(
  commits: readonly LineCommit[],
  registry: Registry,
): RegistryViolation[] {
  const violations: RegistryViolation[] = []
  for (const heading of registry.malformedHeadings) {
    violations.push({
      kind: 'malformed-heading',
      subject: heading,
      detail: `${REGISTRY_PATH} heading "## ${heading}" is neither a record (\`## <slug> — <标题>\`, em dash) nor one of ${NON_RECORD_HEADINGS.join(' / ')}; a heading this check cannot parse would take its record's checks with it.`,
    })
  }
  const status = new Map<string, PatchStatus | null>()
  for (const record of registry.records) {
    if (status.has(record.slug)) {
      violations.push({
        kind: 'duplicate-slug',
        subject: record.slug,
        detail: `${REGISTRY_PATH} registers ${record.slug} more than once; one slug names one patch family.`,
      })
    }
    status.set(record.slug, record.status)
    if (record.status === null) {
      violations.push({
        kind: 'missing-status',
        subject: record.slug,
        detail: `${REGISTRY_PATH} record ${record.slug} declares no 状态 line (expected one of ${PATCH_STATUSES.join(' / ')}).`,
      })
    }
  }
  const used = new Map<string, string>()
  for (const commit of commits) {
    if (commit.parents > 1) {
      violations.push({
        kind: 'merge-commit',
        subject: commit.id,
        detail: `${commit.id} (${commit.subject}) is a merge commit; this patch line stays linear, so every commit above upstream/master has one parent and carries its own Patch trailer.`,
      })
      continue
    }
    if (commit.slugs.length !== 1) {
      violations.push({
        kind: 'trailer-count',
        subject: commit.id,
        detail: `${commit.id} (${commit.subject}) carries ${String(commit.slugs.length)} Patch trailers as git reads them; every commit on this line carries exactly one, in the message's last paragraph.`,
      })
      continue
    }
    const [slug = ''] = commit.slugs
    if (!used.has(slug)) used.set(slug, commit.id)
    if (!status.has(slug)) {
      violations.push({
        kind: 'unregistered-slug',
        subject: commit.id,
        detail: `${commit.id} (${commit.subject}) names Patch: ${slug}, which ${REGISTRY_PATH} does not register.`,
      })
    }
  }
  for (const record of registry.records) {
    if ((record.status === '在役' || record.status === '局部退役') && !used.has(record.slug)) {
      violations.push({
        kind: 'unused-active-slug',
        subject: record.slug,
        detail: `${REGISTRY_PATH} records ${record.slug} as ${record.status}, but no commit above upstream/master names it.`,
      })
    }
    const commitId = used.get(record.slug)
    if (record.status === '退役' && commitId !== undefined) {
      violations.push({
        kind: 'retired-slug-in-use',
        subject: record.slug,
        detail: `${REGISTRY_PATH} records ${record.slug} as 退役, but ${commitId} still names it; a retired patch is off the line, not only off the registry.`,
      })
    }
  }
  return violations
}

/**
 * Read the branch the checkout is on.
 * @param repoRoot - repository root directory.
 * @returns the branch name, or null on a detached HEAD.
 */
export function currentBranch(repoRoot: string): string | null {
  const name = execFileSync('git', ['branch', '--show-current'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim()
  return name === '' ? null : name
}

/**
 * Resolve how `upstream/master` relates to the checked-out line.
 * @param repoRoot - repository root directory.
 * @returns `missing` with no such ref, `base` when it is HEAD's merge base, `stale` otherwise.
 */
export function upstreamBase(repoRoot: string): UpstreamBase {
  let upstream: string
  try {
    upstream = execFileSync('git', ['rev-parse', '--verify', '--quiet', 'upstream/master^{commit}'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    // rev-parse exits non-zero for an unknown ref; no other failure mode reaches
    // here, because the working directory is this repository.
    return 'missing'
  }
  const base = execFileSync('git', ['merge-base', 'upstream/master', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim()
  return base === upstream ? 'base' : 'stale'
}

/**
 * Read the commits above `upstream/master` with the `Patch:` trailers git reads.
 * @param repoRoot - repository root directory.
 * @returns one entry per commit, oldest first.
 */
export function lineCommits(repoRoot: string): LineCommit[] {
  const raw = execFileSync('git', [
    'log',
    '--reverse',
    '--format=%H%x1f%s%x1f%P%x1f%(trailers:key=Patch,valueonly,separator=%x0c)%x1e',
    'upstream/master..HEAD',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return raw.split('\x1e').map(entry => entry.replace(/^\n/u, '')).filter(entry => entry !== '')
    .map((entry) => {
      const [id = '', subject = '', parents = '', trailers = ''] = entry.split('\x1f')
      return {
        id: id.slice(0, 10),
        subject,
        parents: parents.split(' ').filter(parent => parent !== '').length,
        slugs: trailers.split('\x0c').map(slug => slug.trim()).filter(slug => slug !== ''),
      }
    })
}

/**
 * Run the whole check against one repository.
 * @param repoRoot - repository root directory.
 * @returns what the run concluded and the report to print.
 */
export function runCheck(repoRoot: string): CheckResult {
  let source: string
  try {
    source = readFileSync(resolve(repoRoot, REGISTRY_PATH), 'utf8')
  } catch {
    // Any read failure leaves nothing to compare against; the path is the only
    // useful thing to say, and a stack trace would bury it.
    return { status: 'failed', report: `${REGISTRY_PATH} is missing or unreadable; the patch line has no registry to check against.` }
  }
  const registry = parseRegistry(source)
  if (registry.declaredLine === null) {
    return { status: 'failed', report: `${REGISTRY_PATH} declares no 当前补丁线; without it this check cannot tell the patch line from any other branch.` }
  }
  const branch = currentBranch(repoRoot)
  if (branch !== registry.declaredLine) {
    return {
      status: 'skipped',
      report: `skipped: not on the declared patch line ${registry.declaredLine} (${branch ?? 'detached HEAD'})`,
    }
  }
  const base = upstreamBase(repoRoot)
  if (base === 'missing') return { status: 'skipped', report: 'skipped: no upstream/master ref' }
  if (base === 'stale') {
    return { status: 'failed', report: 'upstream/master is not this line\'s base: fetch the upstream remote, or rebase the line onto it.' }
  }
  const commits = lineCommits(repoRoot)
  const violations = findRegistryViolations(commits, registry)
  if (violations.length > 0) {
    return {
      status: 'failed',
      report: ['the patch line and its registry disagree:', ...violations.map(violation => `  ${violation.kind}: ${violation.detail}`)].join('\n'),
    }
  }
  return {
    status: 'ok',
    report: `${String(commits.length)} commit(s) and ${String(registry.records.length)} registry record(s) agree.`,
  }
}

function main(): void {
  const result = runCheck(root)
  const stream = result.status === 'failed' ? process.stderr : process.stdout
  stream.write(`verify-core-patches: ${result.report}\n`)
  if (result.status === 'failed') process.exitCode = 1
}

if (import.meta.main) main()
