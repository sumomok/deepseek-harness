/**
 * Decide whether a publish tags the commit it shipped.
 *
 * The decision is separated from the git that carries it out so it can be
 * exercised without a repository: `publish-update.ts` reads HEAD, the working
 * tree, and both copies of the tag, hands them here before the first upload,
 * and runs the git commands the plan names only after the feed serves the new
 * version.
 *
 * Refusing early is the point. A tag is only worth anything if it names the
 * source the artifacts were built from, and every condition that would break
 * that — a dirty tree, a tag already pointing somewhere else, no remote to
 * push to — is readable before a single byte goes up. Discovering one after
 * the upload leaves a published release nothing points at.
 * @module
 */

/** Prefix every desktop release tag carries ahead of the published version. */
const TAG_PREFIX = 'desktop-v'

/**
 * The release tag for one desktop version.
 * @param version - the version being published.
 * @returns the tag name, `desktop-v<version>`.
 */
export function releaseTagName(version: string): string {
  return `${TAG_PREFIX}${version}`
}

/** What git reports about the repository the publish runs in. */
export interface RepositoryState {
  /** Commit the tag would name. */
  headSha: string
  /** What the tag resolves to in this repository, or undefined when it does not exist here. */
  localTagSha: string | undefined
  /** What the tag resolves to on `origin`, or undefined when it is not published there. */
  remoteTagSha: string | undefined
  /** Whether `git status --porcelain` reported anything at all. */
  dirty: boolean
  /** Whether an `origin` remote exists to push the tag to. */
  hasOrigin: boolean
}

/** One publish's tagging inputs. */
export interface ReleaseTagInputs {
  /** The version being published, which names the tag. */
  version: string
  /** Repository state read at preflight, or undefined when `--no-tag` skipped reading it. */
  repository: RepositoryState | undefined
}

/** What the publish does about the release tag. */
export type ReleaseTagPlan =
  /** Create the annotated tag at HEAD, then push it. */
  | { action: 'create'; tag: string }
  /** The tag already names HEAD in this repository; push it without touching it. */
  | { action: 'push-existing'; tag: string }
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
 * rather than to salvage a half-finished release.
 *
 * A tag that already names HEAD is not an error: a `--republish` repairing a
 * cut-off upload runs the whole publish again, and the tag it created the
 * first time is the one this release wants. It is pushed again, which is a
 * no-op once `origin` holds it.
 * @param inputs - the version being published and what git reports, if it was read.
 * @returns the tagging action, or the refusal that stops the publish.
 */
export function planReleaseTag(inputs: ReleaseTagInputs): ReleaseTagPlan {
  const tag = releaseTagName(inputs.version)
  const repository = inputs.repository
  if (repository === undefined) {
    return { action: 'skip', reason: `--no-tag — no ${tag} tag is created or pushed; tag the release by hand if you want one.` }
  }
  if (repository.dirty) {
    return {
      action: 'refuse',
      reason: `the working tree has uncommitted changes, so ${tag} would not name the source this build came from — commit or stash them, or pass --no-tag.`,
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
  if (repository.localTagSha === undefined) return { action: 'create', tag }
  return { action: 'push-existing', tag }
}
