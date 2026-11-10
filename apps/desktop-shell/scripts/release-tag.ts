/**
 * Decide whether a publish tags the commit it shipped, and under which name.
 *
 * The decision is separated from the git that carries it out so it can be
 * exercised without a repository: `publish-update.ts` reads HEAD, the working
 * tree, and both copies of the tag, hands them here before the first upload,
 * and runs the git commands the plan names only after the feed serves the new
 * version.
 *
 * A tag names one build, not one version. Several builds of an upstream version
 * ship as separate releases whose bytes differ, so `desktop-v<version>` stopped
 * being unique; the tag now carries the build sequence, `desktop-v<version>-b<sequence>`,
 * for bridge and standard builds alike. Historical version-only tags are
 * recognised, never moved: a published tag is a fact about bytes that already
 * exist, and rewriting one would make history disagree with the feed.
 *
 * Refusing early is the point. A tag is only worth anything if it names the
 * source the artifacts were built from, and every condition that would break
 * that — a dirty tree, a HEAD that is not the build's revision, a tag already
 * pointing somewhere else, no remote to push to — is readable before a single
 * byte goes up. Discovering one after the upload leaves a published release
 * nothing points at.
 * @module
 */

import semver from 'semver'
import type { ReleaseIdentity } from '../src/release-identity.ts'

/** Prefix every desktop release tag carries ahead of the published version. */
const TAG_PREFIX = 'desktop-v'

/** Separates the application version from the build sequence in a build-scoped tag. */
const SEQUENCE_SEPARATOR = '-b'

/** A build sequence as this product allocates it: a positive integer with no leading zero. */
const SEQUENCE_PATTERN = /^[1-9]\d*$/u

/** What kind of tag a release tag name is. */
export type ReleaseTagKind =
  /** A build-scoped tag, `desktop-v<version>-b<sequence>`; every publish creates one of these. */
  | 'build'
  /** A historical version-only tag, `desktop-v<version>`; recognised, never created or moved again. */
  | 'legacy'

/** One release tag name, read back. */
export interface ParsedReleaseTag {
  /** The tag name as given. */
  readonly tag: string
  /** The application version the tag names. */
  readonly version: string
  /** The build sequence a build-scoped tag carries, absent from a historical one. */
  readonly buildSequence: number | undefined
  /** Which naming protocol the tag belongs to. */
  readonly kind: ReleaseTagKind
}

/**
 * The release tag for one build.
 *
 * The sequence is what makes the name unique: two builds of one version have
 * different sequences, and a tag cannot be reused for different bytes.
 * @param identity - the build being published.
 * @returns the tag name, `desktop-v<version>-b<sequence>`.
 */
export function releaseTagName(identity: ReleaseIdentity): string {
  return `${TAG_PREFIX}${identity.version}${SEQUENCE_SEPARATOR}${String(identity.dshRelease.buildSequence)}`
}

/**
 * The historical tag a version was published under before build-scoped tags.
 *
 * Only reading uses this name. Nothing creates it again: a new publish always
 * takes the build-scoped name, so a version-only tag can only be a fact about
 * an earlier release.
 * @param version - the version the historical tag names.
 * @returns the tag name, `desktop-v<version>`.
 */
export function legacyReleaseTagName(version: string): string {
  return `${TAG_PREFIX}${version}`
}

/**
 * Read one release tag name back into the build it names.
 *
 * The build-scoped form is tried first because it is the more specific one: it
 * requires `-b<sequence>` after a version, so a tag that carries no sequence
 * cannot match it. A suffix that is a version and ends in `-b<digits>` reads as
 * a build tag; this product's versions end in `-rc.N`, so no historical tag has
 * that shape.
 * @param tag - the tag name to read.
 * @returns the version, the sequence when the tag carries one, and the kind;
 * undefined when the name is not a desktop release tag.
 */
export function parseReleaseTag(tag: string): ParsedReleaseTag | undefined {
  if (!tag.startsWith(TAG_PREFIX)) return undefined
  const suffix = tag.slice(TAG_PREFIX.length)
  if (suffix.length === 0) return undefined
  const at = suffix.lastIndexOf(SEQUENCE_SEPARATOR)
  if (at > 0) {
    const version = suffix.slice(0, at)
    const sequence = suffix.slice(at + SEQUENCE_SEPARATOR.length)
    if (SEQUENCE_PATTERN.test(sequence) && semver.valid(version) !== null) {
      return { tag, version, buildSequence: Number.parseInt(sequence, 10), kind: 'build' }
    }
  }
  if (semver.valid(suffix) !== null) {
    return { tag, version: suffix, buildSequence: undefined, kind: 'legacy' }
  }
  return undefined
}

/** What git reports about the repository the publish runs in. */
export interface RepositoryState {
  /** Commit the tag would name. */
  headSha: string
  /** What the tag resolves to in this repository, or undefined when it does not exist here. */
  localTagSha: string | undefined
  /** What the tag resolves to on `origin`, or undefined when it is not published there. */
  remoteTagSha: string | undefined
  /**
   * Whether any tracked file differs from HEAD (`git status --porcelain --untracked-files=no`,
   * the definition `git describe --dirty` uses). Untracked files are excluded: a release run
   * writes its own logs into the worktree and an ignored `.env` sits there permanently, and
   * neither can change what the build compiles.
   */
  dirty: boolean
  /** Whether an `origin` remote exists to push the tag to. */
  hasOrigin: boolean
}

/** One publish's tagging inputs. */
export interface ReleaseTagInputs {
  /**
   * The build being published.
   *
   * Its version and sequence name the tag, and its revision is the commit the
   * artifacts were built from: the tag may only be created at that commit.
   */
  readonly identity: ReleaseIdentity
  /** Repository state read at preflight, or undefined when `--no-tag` skipped reading it. */
  readonly repository: RepositoryState | undefined
}

/** What the publish does about the release tag. */
export type ReleaseTagPlan =
  /** Nobody carries the tag yet: create the annotated tag at HEAD, then push it. */
  | { action: 'create'; tag: string }
  /** Only this repository carries the tag, at HEAD: push it without touching it. */
  | { action: 'push-existing'; tag: string }
  /** Only `origin` carries the tag, at HEAD: copy it here, with nothing to push. */
  | { action: 'fetch-existing'; tag: string }
  /** Both sides carry the tag at HEAD: the release is already tagged, and no git runs. */
  | { action: 'already-on-origin'; tag: string }
  /** Tagging is off; the publish neither creates nor pushes anything. */
  | { action: 'skip'; reason: string }
  /** Tagging cannot follow this publish, so the publish must not start. */
  | { action: 'refuse'; reason: string }

/**
 * Abbreviate a commit for a one-line diagnostic.
 * @param sha - the full object name git reported.
 * @returns its first twelve characters.
 */
function short(sha: string): string {
  return sha.slice(0, 12)
}

/**
 * Decide what one publish does about its release tag.
 *
 * Every refusal names both what is wrong and how to get past it, because it
 * fires before the upload and the operator's next move is to fix it and re-run
 * rather than to salvage a half-finished release. The order is the order an
 * operator fixes things in: commit the work, run the build that HEAD describes,
 * configure a remote, then deal with a tag that already names another commit.
 *
 * A tag that already names HEAD is not an error: a `--republish` repairing a
 * cut-off upload runs the whole publish again, and the tag the first run made
 * is the one this release wants. Which side already carries it decides the
 * action, and `origin` is authoritative — it is the copy every other clone
 * reads. Creating a second annotated tag object for a name `origin` already
 * publishes only produces a push git rejects, which is the state several
 * worktrees of one repository reach routinely: one of them tagged and pushed,
 * the others have never seen the tag.
 * @param inputs - the build being published and what git reports, if it was read.
 * @returns the tagging action, or the refusal that stops the publish.
 */
export function planReleaseTag(inputs: ReleaseTagInputs): ReleaseTagPlan {
  const tag = releaseTagName(inputs.identity)
  const expectedRevision = inputs.identity.dshRelease.revision
  const repository = inputs.repository
  if (repository === undefined) {
    return { action: 'skip', reason: `--no-tag — no ${tag} tag is created or pushed; tag the release by hand if you want one.` }
  }
  if (repository.dirty) {
    return {
      action: 'refuse',
      reason: `the working tree has uncommitted changes to tracked files, so ${tag} would not name the source this build came from — commit or stash them, or pass --no-tag.`,
    }
  }
  if (repository.headSha !== expectedRevision) {
    return {
      action: 'refuse',
      reason: `HEAD is ${short(repository.headSha)} but these artifacts were built from ${short(expectedRevision)}, so ${tag} would name a different commit — publish from ${short(expectedRevision)}, or rebuild from HEAD; --no-tag skips only this tag step.`,
    }
  }
  if (!repository.hasOrigin) {
    return {
      action: 'refuse',
      reason: `this repository has no 'origin' remote, so ${tag} could not be pushed — add one with git remote add origin <url>, or pass --no-tag.`,
    }
  }
  if (repository.localTagSha !== undefined && repository.localTagSha !== repository.headSha) {
    return {
      action: 'refuse',
      reason: `${tag} already exists here at ${short(repository.localTagSha)} but HEAD is ${short(repository.headSha)} — publish from that commit, or delete the tag with git tag -d ${tag}, or pass --no-tag.`,
    }
  }
  if (repository.remoteTagSha !== undefined && repository.remoteTagSha !== repository.headSha) {
    return {
      action: 'refuse',
      reason: `${tag} already exists on origin at ${short(repository.remoteTagSha)} but HEAD is ${short(repository.headSha)} — publish from that commit, or delete the tag with git push origin :refs/tags/${tag}, or pass --no-tag.`,
    }
  }
  // Past the refusals both copies either name HEAD or do not exist, so the two
  // presences alone decide the action.
  const onOrigin = repository.remoteTagSha !== undefined
  const here = repository.localTagSha !== undefined
  if (onOrigin) return here ? { action: 'already-on-origin', tag } : { action: 'fetch-existing', tag }
  return here ? { action: 'push-existing', tag } : { action: 'create', tag }
}
