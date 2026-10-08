/**
 * Check that this fork's patch line and its registry account for the same
 * change against the upstream release the line has merged.
 *
 * The registry, `.claude/core-patches.md`, declares the patch line with
 * `**当前补丁线**：\`<branch>\`` and its upstream base with
 * `**基座 tag**：\`<tag>\``. The tag resolves through
 * `refs/tags/<tag>^{commit}`, and `git merge-base HEAD <tag>` must be the tag
 * itself: the declared release has been merged into the line. Upstream releases
 * enter the line through `git merge`, so the line is never rebased and commit
 * hashes on it are stable; `verify-repository-references` still rejects them in
 * maintained prose, which is why patch identity is a slug.
 *
 * Paths. The change set is `git diff --no-renames --name-only <base> HEAD`
 * minus {@link GENERATED_PATHSPECS}. Every record whose status is `在役` or
 * `局部退役` carries a `- **路径**：` line of backquoted git pathspecs, each
 * matched with `:(glob)` magic. Every changed path must be claimed by at least
 * one such record (`unclaimed-path`); every such record must claim at least one
 * changed path (`unused-active-slug`), and every pathspec must match at least one
 * (`unused-pathspec`), so a retired family and an outdated claim both surface. A
 * standing record without a 路径 line is `missing-paths`; a `退役` record with one
 * is `retired-record-claims-paths`, because a retired family owns no change and
 * any change it left behind must surface as unclaimed. Retiring a family is its
 * change disappearing from the diff; its old commits may stay on the line.
 *
 * Commits. Every non-merge commit on the first-parent chain from the base to
 * HEAD carries exactly one `Patch:` trailer (`trailer-count`) whose value is a
 * slug (`malformed-trailer`) that the registry registers under any status
 * (`unregistered-slug`). Trailers are read through git's own
 * `%(trailers:key=Patch)`. The first-parent walk keeps commits that arrived
 * under a merge's second parent — upstream's, and the history the line was
 * joined to — out of the enumeration.
 *
 * Merges. A merge on the first-parent chain is accepted when it has exactly two
 * parents and the second is exactly the commit some `refs/tags/dsh-v*` tag
 * points at (an upstream release merge, annotated tags dereferenced), or when
 * its tree equals its first parent's tree (an `-s ours` join). Any other merge,
 * an octopus that names a release included, is `merge-commit`, since a topic
 * merge hides untrailed commits under its further parents. The release rule
 * deliberately asks nothing about the declared tag: earlier rounds' release
 * merges stay on the first-parent chain after the declaration moves to a newer
 * tag they cannot reach.
 *
 * Scope. A checkout on any branch other than the declared line — `develop`, an
 * integration branch, a detached HEAD — and a shallow clone report `skipped` and
 * exit 0. A registry that cannot be read, that leaves a code fence open, or that
 * does not declare exactly one patch line and exactly one base tag fails on
 * every branch, because a check that cannot read its own declarations cannot
 * tell which case it is in.
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

/**
 * Generator outputs no family claims, as `:(glob)` pathspecs. Each generator
 * rewrites its whole output from sources that the families do claim, so a
 * family's change reaches these files through the regeneration, not through a
 * patch of its own.
 */
export const GENERATED_PATHSPECS = [
  '**/*.i18n.yaml',
  'pnpm-lock.yaml',
  'THIRD_PARTY_NOTICES.md',
  'docs/config-catalog.md',
  'docs/config-catalog.zh.md',
  'docs/capability-seams.md',
  'docs/event-producer-consumer.md',
  'docs/event-producer-consumer.zh.md',
  'docs/module-graph.md',
  'docs/module-graph.zh.md',
  'docs/persistence-catalog.md',
  'docs/persistence-catalog.zh.md',
  'docs/persistence-schema.json',
  'packages/extensions/cordis-client-runner/src/client/slot-catalog.ts',
  'packages/extensions/cordis-client-runner/src/client/api-catalog.ts',
  'packages/extensions/tool-cordis/src/api-catalog.ts',
  'snapshots/**/*.expected.md',
  'apps/web/tests/expected/**',
] as const

/** Tag refs whose commits count as upstream releases a merge may bring in. */
export const RELEASE_TAG_PATTERN = 'refs/tags/dsh-v*'

/** One registered patch family. */
export interface PatchRecord {
  /** Registry slug, unique across the file. */
  slug: string
  /** Human title on the same heading line. */
  title: string
  /** Declared status, or null when the record states none. */
  status: PatchStatus | null
  /** Pathspecs from the record's 路径 lines in file order, or null when it has none. */
  pathspecs: string[] | null
}

/** The registry file as this check reads it. */
export interface Registry {
  /** Records in file order, including duplicates so the caller can report them. */
  records: PatchRecord[]
  /** Level-2 heading text that is neither a record nor a declared prose heading. */
  malformedHeadings: string[]
  /** Every declared patch-line branch name, in file order; exactly one is required. */
  declaredLines: string[]
  /** Every declared base tag name, in file order; exactly one is required. */
  declaredBaseTags: string[]
  /** 1-based line of a code fence the file never closes, or null when every fence closes. */
  unclosedFence: number | null
}

/** One non-merge commit on the first-parent chain above the base. */
export interface LineCommit {
  /** Commit identifier, for diagnostics only. */
  id: string
  /** Subject line, for diagnostics only. */
  subject: string
  /** Every `Patch:` trailer value git reads from the message, in order. */
  slugs: string[]
}

/** One merge commit on the first-parent chain above the base. */
export interface LineMerge {
  /** Commit identifier, for diagnostics only. */
  id: string
  /** Subject line, for diagnostics only. */
  subject: string
  /** True when the merge has exactly two parents and the second is exactly a commit a release tag points at. */
  mergesRelease: boolean
  /** True when the merge's tree equals its first parent's tree. */
  treeUnchanged: boolean
}

/** One pathspec a standing record declares, with the changed paths it matches. */
export interface PathspecClaim {
  /** Slug of the record that declares the pathspec. */
  slug: string
  /** The pathspec as written, without the `:(glob)` magic this check adds. */
  pathspec: string
  /** Changed paths outside the generated set that the pathspec matches. */
  paths: string[]
}

/** What this check reads from git for one patch line. */
export interface PatchLine {
  /** Non-merge commits on the first-parent chain above the base, oldest first. */
  commits: LineCommit[]
  /** Merge commits on the first-parent chain above the base, oldest first. */
  merges: LineMerge[]
  /** Paths that differ between the base and HEAD, minus the generated set. */
  changedPaths: string[]
  /** Every pathspec of every `在役` or `局部退役` record, with its matches. */
  claims: PathspecClaim[]
}

/** One disagreement between the line and the registry. */
export interface RegistryViolation {
  /** What disagrees. */
  kind:
    | 'unclaimed-path'
    | 'unused-active-slug'
    | 'unused-pathspec'
    | 'missing-paths'
    | 'retired-record-claims-paths'
    | 'trailer-count'
    | 'malformed-trailer'
    | 'unregistered-slug'
    | 'merge-commit'
    | 'duplicate-slug'
    | 'missing-status'
    | 'malformed-heading'
  /** Commit id, path, slug or heading text, whichever the finding is about. */
  subject: string
  /** Complete, self-contained description. */
  detail: string
}

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
const PATHS = /^- \*\*路径\*\*：(.*)$/u
const PATHSPEC = /`([^`]+)`/gu
const DECLARED_LINE = /^\*\*当前补丁线\*\*：`([^`]+)`/u
const DECLARED_BASE_TAG = /^\*\*基座 tag\*\*：`([^`]+)`/u
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/**
 * Read the registry's records, its malformed headings, and what it declares.
 * Line endings are normalized first, and fenced blocks are dropped: a fenced
 * example of the record or declaration format is documentation, and parsing it
 * would let one code block silently replace the line this check runs against.
 * A fence the file never closes swallows every record below it, so where it
 * opened is reported rather than left to surface as missing records.
 * @param source - the registry file contents.
 * @returns everything this check reads out of the file.
 */
export function parseRegistry(source: string): Registry {
  const records: PatchRecord[] = []
  const malformedHeadings: string[] = []
  const declaredLines: string[] = []
  const declaredBaseTags: string[] = []
  let current: PatchRecord | undefined
  let fence: { marker: string; line: number } | undefined
  let lineNumber = 0
  for (const line of source.replace(/\r\n?/gu, '\n').split('\n')) {
    lineNumber += 1
    const [, marker, info = ''] = FENCE.exec(line) ?? []
    if (fence !== undefined) {
      // A fence closes on a run of the same character at least as long as the
      // one that opened it — exactly the runs that start with it — carrying no
      // info string, so a ```js line nested in a ``` block does not close it.
      if (marker !== undefined && marker.startsWith(fence.marker) && info.trim() === '') fence = undefined
      continue
    }
    if (marker !== undefined) {
      fence = { marker, line: lineNumber }
      continue
    }
    const [, declaredLine] = DECLARED_LINE.exec(line) ?? []
    if (declaredLine !== undefined) declaredLines.push(declaredLine)
    const [, declaredBaseTag] = DECLARED_BASE_TAG.exec(line) ?? []
    if (declaredBaseTag !== undefined) declaredBaseTags.push(declaredBaseTag)
    const heading = HEADING.exec(line)
    if (heading !== null) {
      const [, text = ''] = heading
      const record = RECORD_HEADING.exec(text)
      if (record !== null) {
        const [, slug = '', title = ''] = record
        current = { slug, title, status: null, pathspecs: null }
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
    if (current === undefined) continue
    const status = current.status === null ? STATUS.exec(line) : null
    if (status !== null) current.status = status[1] as PatchStatus
    const [, paths] = PATHS.exec(line) ?? []
    // Every 路径 line of a record contributes, so a second line extends the
    // claim instead of being dropped without a finding.
    if (paths !== undefined) current.pathspecs = [...current.pathspecs ?? [], ...Array.from(paths.matchAll(PATHSPEC), match => match[1] ?? '')]
  }
  return { records, malformedHeadings, declaredLines, declaredBaseTags, unclosedFence: fence?.line ?? null }
}

/**
 * Read whether a record's status keeps it on the line.
 * @param record - the record to classify.
 * @returns true for `在役` and `局部退役`.
 */
export function isStanding(record: PatchRecord): boolean {
  return record.status === '在役' || record.status === '局部退役'
}

/**
 * Compare the line against the registry: its records, its commits and merges,
 * and the paths it changes against the base.
 * @param line - what git says about the line above its base.
 * @param registry - the parsed registry.
 * @returns one violation per disagreement; empty when the two agree.
 */
export function findRegistryViolations(line: PatchLine, registry: Registry): RegistryViolation[] {
  const violations: RegistryViolation[] = []
  for (const heading of registry.malformedHeadings) {
    violations.push({
      kind: 'malformed-heading',
      subject: heading,
      detail: `${REGISTRY_PATH} heading "## ${heading}" is neither a record (\`## <slug> — <标题>\`, em dash) nor one of ${NON_RECORD_HEADINGS.join(' / ')}; a heading this check cannot parse would take its record's checks with it.`,
    })
  }
  const registered = new Set<string>()
  for (const record of registry.records) {
    if (registered.has(record.slug)) {
      violations.push({
        kind: 'duplicate-slug',
        subject: record.slug,
        detail: `${REGISTRY_PATH} registers ${record.slug} more than once; one slug names one patch family.`,
      })
    }
    registered.add(record.slug)
    if (record.status === null) {
      violations.push({
        kind: 'missing-status',
        subject: record.slug,
        detail: `${REGISTRY_PATH} record ${record.slug} declares no 状态 line (expected one of ${PATCH_STATUSES.join(' / ')}).`,
      })
    }
    if (isStanding(record) && (record.pathspecs === null || record.pathspecs.length === 0)) {
      violations.push({
        kind: 'missing-paths',
        subject: record.slug,
        detail: `${REGISTRY_PATH} records ${record.slug} as ${String(record.status)} without a 路径 line naming at least one backquoted pathspec; a standing family claims the paths it changes against the base tag.`,
      })
    }
    if (record.status === '退役' && record.pathspecs !== null) {
      violations.push({
        kind: 'retired-record-claims-paths',
        subject: record.slug,
        detail: `${REGISTRY_PATH} records ${record.slug} as 退役 and still carries a 路径 line; a retired family claims no change, so any change it left behind must surface as unclaimed.`,
      })
    }
  }
  const claimed = new Set<string>()
  const claimingSlugs = new Set<string>()
  for (const claim of line.claims) {
    for (const path of claim.paths) claimed.add(path)
    if (claim.paths.length > 0) {
      claimingSlugs.add(claim.slug)
      continue
    }
    violations.push({
      kind: 'unused-pathspec',
      subject: claim.slug,
      detail: `${REGISTRY_PATH} record ${claim.slug} claims \`${claim.pathspec}\`, which matches no path that differs from the base tag outside the generated set.`,
    })
  }
  for (const record of registry.records) {
    if (!isStanding(record) || record.pathspecs === null || record.pathspecs.length === 0) continue
    if (claimingSlugs.has(record.slug)) continue
    violations.push({
      kind: 'unused-active-slug',
      subject: record.slug,
      detail: `${REGISTRY_PATH} records ${record.slug} as ${String(record.status)}, but none of its pathspecs matches a path that differs from the base tag; its change is gone, so its status is 退役.`,
    })
  }
  for (const path of line.changedPaths) {
    if (claimed.has(path)) continue
    violations.push({
      kind: 'unclaimed-path',
      subject: path,
      detail: `${path} differs from the base tag, and no 在役 or 局部退役 record in ${REGISTRY_PATH} claims it in its 路径 line.`,
    })
  }
  for (const commit of line.commits) {
    if (commit.slugs.length !== 1) {
      violations.push({
        kind: 'trailer-count',
        subject: commit.id,
        detail: `${commit.id} (${commit.subject}) carries ${String(commit.slugs.length)} Patch trailers as git reads them; every commit on this line's first-parent chain carries exactly one, in the message's last paragraph.`,
      })
      continue
    }
    const [slug = ''] = commit.slugs
    if (!SLUG.test(slug)) {
      violations.push({
        kind: 'malformed-trailer',
        subject: commit.id,
        detail: `${commit.id} (${commit.subject}) carries Patch: ${slug}, which is not a slug (lower-case words joined by single hyphens); git takes any trailer value, so the value is checked here.`,
      })
      continue
    }
    if (!registered.has(slug)) {
      violations.push({
        kind: 'unregistered-slug',
        subject: commit.id,
        detail: `${commit.id} (${commit.subject}) names Patch: ${slug}, which ${REGISTRY_PATH} does not register.`,
      })
    }
  }
  for (const merge of line.merges) {
    if (merge.mergesRelease || merge.treeUnchanged) continue
    violations.push({
      kind: 'merge-commit',
      subject: merge.id,
      detail: `${merge.id} (${merge.subject}) is a merge that neither brings in exactly one commit a ${RELEASE_TAG_PATTERN} tag points at as its only second parent nor keeps its first parent's tree; commits under such a merge carry no trailer this check can read, so the change lands as direct commits instead.`,
    })
  }
  return violations
}

/**
 * Read why a git command failed, in one line.
 * @param cause - what `execFileSync` threw.
 * @returns git's own first line of standard error, or the thrown message when git printed none.
 */
function failureReason(cause: unknown): string {
  // A non-zero exit gives `Command failed: <the command again>` as the message
  // and the `fatal: …` this check wants on stderr; a git that cannot be spawned
  // gives no stderr and says why in the message.
  const stderr = typeof cause === 'object' && cause !== null ? (cause as { stderr?: unknown }).stderr : undefined
  const text = typeof stderr === 'string' && stderr.trim() !== ''
    ? stderr
    : cause instanceof Error ? cause.message : String(cause)
  const [first = ''] = text.trim().split('\n')
  return first.trim()
}

/** A git command this check runs could not be started, or exited non-zero. */
class GitFailure extends Error {
  /**
   * @param args - the git arguments that failed.
   * @param cause - what `execFileSync` threw.
   */
  constructor(args: readonly string[], cause: unknown) {
    super(`git ${args.join(' ')} failed: ${failureReason(cause)}`)
    this.name = 'GitFailure'
  }
}

/**
 * Run one git command in the repository.
 * @param repoRoot - repository root directory.
 * @param args - the git arguments to run.
 * @returns standard output with its trailing newline removed.
 */
function git(repoRoot: string, args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\n$/u, '')
  } catch (cause) {
    throw new GitFailure(args, cause)
  }
}

/**
 * Read the branch the checkout is on.
 * @param repoRoot - repository root directory.
 * @returns the branch name, or null on a detached HEAD.
 */
export function currentBranch(repoRoot: string): string | null {
  const name = git(repoRoot, ['branch', '--show-current']).trim()
  return name === '' ? null : name
}

/**
 * Read whether the repository's history is truncated.
 * @param repoRoot - repository root directory.
 * @returns true for a shallow clone, which cannot reach the declared base tag.
 */
export function isShallowClone(repoRoot: string): boolean {
  return git(repoRoot, ['rev-parse', '--is-shallow-repository']).trim() === 'true'
}

/**
 * Resolve a tag name to the commit it points at.
 * @param repoRoot - repository root directory.
 * @param tag - the tag name, without `refs/tags/`.
 * @returns the full commit id, or null when no such tag exists.
 */
export function tagCommit(repoRoot: string, tag: string): string | null {
  const ref = `refs/tags/${tag}`
  // `--verify --quiet` exits non-zero without output for a missing ref, so the
  // existence test goes through `for-each-ref`, which lists nothing instead.
  if (git(repoRoot, ['for-each-ref', '--format=%(refname)', ref]) !== ref) return null
  return git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
}

/**
 * Read the commits every release tag points at.
 * @param repoRoot - repository root directory.
 * @returns full commit ids, annotated tags dereferenced to their commit.
 */
export function releaseCommits(repoRoot: string): Set<string> {
  const listed = git(repoRoot, [
    'for-each-ref',
    '--format=%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)',
    RELEASE_TAG_PATTERN,
  ])
  return new Set(listed.split('\n').filter(id => id !== ''))
}

/**
 * Read the non-merge commits on the first-parent chain above the base, with the
 * `Patch:` trailers git reads.
 * @param repoRoot - repository root directory.
 * @param base - the base commit, excluded from the result.
 * @returns one entry per commit, oldest first.
 */
export function lineCommits(repoRoot: string, base: string): LineCommit[] {
  const raw = git(repoRoot, [
    'log',
    '--first-parent',
    '--no-merges',
    '--reverse',
    '--format=%H%x1f%s%x1f%(trailers:key=Patch,valueonly,unfold,separator=%x0c)%x1e',
    `${base}..HEAD`,
  ])
  return raw.split('\x1e').map(entry => entry.replace(/^\n/u, '')).filter(entry => entry !== '')
    .map((entry) => {
      const [id = '', subject = '', trailers = ''] = entry.split('\x1f')
      return {
        id: id.slice(0, 10),
        subject,
        slugs: trailers.split('\x0c').map(slug => slug.trim()).filter(slug => slug !== ''),
      }
    })
}

/**
 * Read the merge commits on the first-parent chain above the base.
 * @param repoRoot - repository root directory.
 * @param base - the base commit, excluded from the result.
 * @param releases - the commits release tags point at.
 * @returns one entry per merge, oldest first.
 */
export function lineMerges(repoRoot: string, base: string, releases: ReadonlySet<string>): LineMerge[] {
  const raw = git(repoRoot, [
    'log',
    '--first-parent',
    '--merges',
    '--reverse',
    '--format=%H%x1f%s%x1f%P%x1f%T',
    `${base}..HEAD`,
  ])
  return raw.split('\n').filter(entry => entry !== '').map((entry) => {
    const [id = '', subject = '', parents = '', tree = ''] = entry.split('\x1f')
    const [first = '', second = '', ...rest] = parents.split(' ')
    return {
      id: id.slice(0, 10),
      subject,
      // An octopus merge that names a release as its second parent still
      // brings every further parent's commits in untrailed, so only a
      // two-parent merge counts as a release merge.
      mergesRelease: rest.length === 0 && releases.has(second),
      treeUnchanged: git(repoRoot, ['rev-parse', `${first}^{tree}`]) === tree,
    }
  })
}

/**
 * List the paths that differ between the base and HEAD and match one pathspec,
 * the generated set excluded.
 * @param repoRoot - repository root directory.
 * @param base - the base commit.
 * @param pathspec - a `:(glob)` pathspec, or null for every path.
 * @returns repository-relative paths, in git's order.
 */
export function changedPaths(repoRoot: string, base: string, pathspec: string | null): string[] {
  const raw = git(repoRoot, [
    'diff',
    '--no-renames',
    '--name-only',
    '-z',
    base,
    'HEAD',
    '--',
    ...pathspec === null ? [] : [`:(glob)${pathspec}`],
    ...GENERATED_PATHSPECS.map(generated => `:(exclude,glob)${generated}`),
  ])
  return raw.split('\0').filter(path => path !== '')
}

/**
 * Read everything this check compares against the registry.
 * @param repoRoot - repository root directory.
 * @param base - the base commit, the declared tag's.
 * @param registry - the parsed registry, whose standing records' pathspecs are matched.
 * @returns the line's commits, merges, changed paths and claims.
 */
export function readPatchLine(repoRoot: string, base: string, registry: Registry): PatchLine {
  const claims: PathspecClaim[] = []
  for (const record of registry.records) {
    if (!isStanding(record)) continue
    for (const pathspec of record.pathspecs ?? []) {
      claims.push({ slug: record.slug, pathspec, paths: changedPaths(repoRoot, base, pathspec) })
    }
  }
  return {
    commits: lineCommits(repoRoot, base),
    merges: lineMerges(repoRoot, base, releaseCommits(repoRoot)),
    changedPaths: changedPaths(repoRoot, base, null),
    claims,
  }
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
  if (registry.unclosedFence !== null) {
    return { status: 'failed', report: `${REGISTRY_PATH} has a code fence opened at line ${String(registry.unclosedFence)} and never closed; everything below it reads as example text, records included.` }
  }
  const [declaredLine] = registry.declaredLines
  if (registry.declaredLines.length !== 1 || declaredLine === undefined) {
    return { status: 'failed', report: `${REGISTRY_PATH} declares 当前补丁线 ${String(registry.declaredLines.length)} time(s) outside its code blocks; exactly one declaration names the branch this check compares against.` }
  }
  const [declaredTag] = registry.declaredBaseTags
  if (registry.declaredBaseTags.length !== 1 || declaredTag === undefined) {
    return { status: 'failed', report: `${REGISTRY_PATH} declares 基座 tag ${String(registry.declaredBaseTags.length)} time(s) outside its code blocks; exactly one declaration names the upstream release this line has merged.` }
  }
  try {
    const branch = currentBranch(repoRoot)
    if (branch !== declaredLine) {
      return {
        status: 'skipped',
        report: `skipped: not on the declared patch line ${declaredLine} (${branch ?? 'detached HEAD'})`,
      }
    }
    if (isShallowClone(repoRoot)) {
      return { status: 'skipped', report: `skipped: shallow clone, whose truncated history cannot reach the declared base tag ${declaredTag}` }
    }
    const base = tagCommit(repoRoot, declaredTag)
    if (base === null) {
      return { status: 'failed', report: `base-tag-missing: ${REGISTRY_PATH} declares base tag ${declaredTag}, which is not a tag in this repository; run \`git fetch upstream --tags\`.` }
    }
    const mergeBase = git(repoRoot, ['merge-base', 'HEAD', base])
    if (mergeBase !== base) {
      return { status: 'failed', report: `base-tag-not-merged: ${REGISTRY_PATH} declares base tag ${declaredTag}, which HEAD has not merged; the declaration names the upstream release this line already contains.` }
    }
    const line = readPatchLine(repoRoot, base, registry)
    const violations = findRegistryViolations(line, registry)
    if (violations.length > 0) {
      return {
        status: 'failed',
        report: ['the patch line and its registry disagree:', ...violations.map(violation => `  ${violation.kind}: ${violation.detail}`)].join('\n'),
      }
    }
    return {
      status: 'ok',
      report: `${String(line.commits.length)} commit(s), ${String(line.merges.length)} merge(s), ${String(line.changedPaths.length)} changed path(s) and ${String(registry.records.length)} registry record(s) agree against ${declaredTag}.`,
    }
  } catch (failure) {
    // Every git command this check runs is wrapped, and a failed one leaves the
    // comparison undecidable; one line naming the command beats a stack trace.
    if (failure instanceof GitFailure) return { status: 'failed', report: failure.message }
    throw failure
  }
}

function main(): void {
  const result = runCheck(root)
  const stream = result.status === 'failed' ? process.stderr : process.stdout
  stream.write(`verify-core-patches: ${result.report}\n`)
  if (result.status === 'failed') process.exitCode = 1
}

if (import.meta.main) main()
