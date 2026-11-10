/**
 * What a publish does about its release tag: which name the tag takes, which
 * repository states let it follow the upload, and which ones stop the publish
 * before it starts.
 *
 * The name is build-scoped — `desktop-v<version>-b<sequence>` — because several
 * builds of one version ship as separate releases whose bytes differ, and a tag
 * must name exactly one of them. Version-only tags from before that rule are
 * still recognized so history can be read, but nothing creates or moves one any
 * more.
 * @module
 */

import { describe, expect, it } from 'vitest'
import {
  legacyReleaseTagName,
  parseReleaseTag,
  planReleaseTag,
  releaseTagName,
  type RepositoryState,
} from '../scripts/release-tag.ts'
import type { ReleaseIdentity } from '../src/release-identity.ts'

const VERSION = '0.1.0-rc.20'
const SEQUENCE = 101
const TAG = `desktop-v${VERSION}-b${String(SEQUENCE)}`
const HEAD = '1'.repeat(40)
const OTHER = '2'.repeat(40)

/**
 * One build's identity, with HEAD as its revision unless overridden.
 * @param overrides - fields to replace.
 * @returns the identity.
 */
function identity(overrides: { version?: string; sequence?: number; revision?: string; kind?: 'standard' | 'bridge' } = {}): ReleaseIdentity {
  const version = overrides.version ?? VERSION
  return {
    version,
    dshRelease: {
      schemaVersion: 2,
      runtimeVersion: overrides.kind === 'bridge' ? VERSION : version,
      buildSequence: overrides.sequence ?? SEQUENCE,
      revision: overrides.revision ?? HEAD,
      kind: overrides.kind ?? 'standard',
    },
  }
}

/**
 * A repository ready to be tagged, with the named facts overridden.
 * @param overrides - what differs from the clean, origin-carrying, untagged case.
 * @returns the repository state to plan against.
 */
function repository(overrides: Partial<RepositoryState> = {}): RepositoryState {
  return { headSha: HEAD, localTagSha: undefined, remoteTagSha: undefined, dirty: false, hasOrigin: true, ...overrides }
}

describe('releaseTagName', () => {
  it('names the tag after the build, not just the version', () => {
    // Two builds of one version differ, so the version alone cannot name the
    // release a tag has to point at.
    expect(releaseTagName(identity())).toBe(TAG)
    expect(releaseTagName(identity({ sequence: 102 }))).toBe(`desktop-v${VERSION}-b102`)
    expect(releaseTagName(identity({ version: '1.0.0' }))).toBe('desktop-v1.0.0-b101')
  })

  it('gives a bridge build the same build-scoped form', () => {
    // The bridge goes through the old feed, but its tag is still read by this
    // tooling and must identify the bytes it shipped.
    expect(releaseTagName(identity({ version: '0.2.2-rc.4', kind: 'bridge' }))).toBe('desktop-v0.2.2-rc.4-b101')
  })

  it('still names the historical version-only tag, for reading only', () => {
    expect(legacyReleaseTagName(VERSION)).toBe(`desktop-v${VERSION}`)
    expect(legacyReleaseTagName('1.0.0')).toBe('desktop-v1.0.0')
    expect(legacyReleaseTagName(VERSION)).not.toBe(releaseTagName(identity()))
  })
})

describe('parseReleaseTag', () => {
  it('reads a build-scoped tag back into its build', () => {
    expect(parseReleaseTag(TAG)).toEqual({ tag: TAG, version: VERSION, buildSequence: SEQUENCE, kind: 'build' })
  })

  it('reads a version-only tag as the historical form, without a sequence', () => {
    // Every tag published before build-scoped tags has this shape. Reading it
    // is what lets the tooling compare history; nothing writes it again.
    expect(parseReleaseTag(`desktop-v${VERSION}`)).toEqual({
      tag: `desktop-v${VERSION}`,
      version: VERSION,
      buildSequence: undefined,
      kind: 'legacy',
    })
    expect(parseReleaseTag('desktop-v1.0.0')?.kind).toBe('legacy')
  })

  it('round-trips every tag this module creates', () => {
    for (const version of ['0.1.0', '0.1.0-rc.20', '1.0.0-rc.9', '0.2.2-b1']) {
      for (const sequence of [1, 100, 101, 9999]) {
        const build = identity({ version, sequence })
        expect(parseReleaseTag(releaseTagName(build))).toEqual({
          tag: releaseTagName(build),
          version,
          buildSequence: sequence,
          kind: 'build',
        })
      }
    }
  })

  it('reads a version that itself ends in -b<digits> before its sequence', () => {
    // The build form is matched first and takes the last separator, so a
    // version shaped like a sequence suffix does not swallow it.
    const build = identity({ version: '0.2.2-rc.1-b3', sequence: 101 })
    expect(releaseTagName(build)).toBe('desktop-v0.2.2-rc.1-b3-b101')
    expect(parseReleaseTag(releaseTagName(build))).toEqual({
      tag: releaseTagName(build),
      version: '0.2.2-rc.1-b3',
      buildSequence: 101,
      kind: 'build',
    })
  })

  it('leaves a name that is not a desktop release tag unrecognized', () => {
    for (const tag of ['v0.1.0-rc.20', 'desktop-0.1.0-rc.20', 'desktop-v', 'desktop-v nightly', 'release-0.1.0']) {
      expect(parseReleaseTag(tag), tag).toBeUndefined()
    }
  })
})

describe('planReleaseTag', () => {
  it('creates the build tag when the tree is clean and nothing carries it yet', () => {
    expect(planReleaseTag({ identity: identity(), repository: repository() })).toEqual({ action: 'create', tag: TAG })
  })

  it('pushes a tag only this repository carries, at HEAD, instead of creating it again', () => {
    // What a --republish repairing a cut-off upload sees in the worktree that
    // tagged first: the tag it made is the one this release wants.
    const plan = planReleaseTag({ identity: identity(), repository: repository({ localTagSha: HEAD }) })
    expect(plan).toEqual({ action: 'push-existing', tag: TAG })
  })

  it('fetches the tag origin already carries at HEAD rather than creating a second one', () => {
    // Another worktree of this repository published the tag. Creating an
    // annotated object here for the same name only produces a push origin
    // rejects, so origin's copy is the one to take.
    const plan = planReleaseTag({ identity: identity(), repository: repository({ remoteTagSha: HEAD }) })
    expect(plan).toEqual({ action: 'fetch-existing', tag: TAG })
  })

  it('runs no git when both sides already carry the tag at HEAD', () => {
    // The two tag objects may differ — one made here, one made through the
    // GitHub API — while both peel to HEAD. Pushing would be rejected and
    // nothing needs doing, so the release is simply already tagged.
    const plan = planReleaseTag({ identity: identity(), repository: repository({ localTagSha: HEAD, remoteTagSha: HEAD }) })
    expect(plan).toEqual({ action: 'already-on-origin', tag: TAG })
  })

  it('skips everything, including preflight, when --no-tag turned the step off', () => {
    const plan = planReleaseTag({ identity: identity(), repository: undefined })
    expect(plan.action).toBe('skip')
    expect(plan.action === 'skip' && plan.reason).toContain('--no-tag')
    expect(plan.action === 'skip' && plan.reason).toContain(TAG)
  })

  it('refuses a dirty working tree, because the tag would not name what was built', () => {
    const plan = planReleaseTag({ identity: identity(), repository: repository({ dirty: true }) })
    expect(plan.action).toBe('refuse')
    expect(plan.action === 'refuse' && plan.reason).toContain('uncommitted changes to tracked files')
    expect(plan.action === 'refuse' && plan.reason).toContain('--no-tag')
  })

  it('refuses a HEAD that is not the revision the artifacts were built from', () => {
    // The build's identity carries the commit its bytes came from; tagging any
    // other commit would publish a tag that disagrees with the feed.
    const plan = planReleaseTag({ identity: identity({ revision: OTHER }), repository: repository() })
    expect(plan.action).toBe('refuse')
    expect(plan.action === 'refuse' && plan.reason).toContain(OTHER.slice(0, 12))
    expect(plan.action === 'refuse' && plan.reason).toContain(HEAD.slice(0, 12))
    expect(plan.action === 'refuse' && plan.reason).toContain(TAG)
  })

  it('is untroubled by untracked files, which the caller excludes from dirty', () => {
    // `dirty` is `git status --porcelain --untracked-files=no`: the release
    // run's own logs and an ignored .env sit in the worktree permanently and
    // change nothing the build compiles.
    expect(planReleaseTag({ identity: identity(), repository: repository({ dirty: false }) })).toEqual({ action: 'create', tag: TAG })
  })

  it('refuses a repository with no origin to push to', () => {
    const plan = planReleaseTag({ identity: identity(), repository: repository({ hasOrigin: false }) })
    expect(plan.action).toBe('refuse')
    expect(plan.action === 'refuse' && plan.reason).toContain('origin')
  })

  it('refuses a local tag that names another commit, naming both', () => {
    const plan = planReleaseTag({ identity: identity(), repository: repository({ localTagSha: OTHER }) })
    expect(plan.action).toBe('refuse')
    expect(plan.action === 'refuse' && plan.reason).toContain(OTHER.slice(0, 12))
    expect(plan.action === 'refuse' && plan.reason).toContain(HEAD.slice(0, 12))
    expect(plan.action === 'refuse' && plan.reason).toContain(`git tag -d ${TAG}`)
  })

  it('refuses a tag origin already carries at another commit', () => {
    const plan = planReleaseTag({ identity: identity(), repository: repository({ remoteTagSha: OTHER }) })
    expect(plan.action).toBe('refuse')
    expect(plan.action === 'refuse' && plan.reason).toContain(`git push origin :refs/tags/${TAG}`)
  })

  it('reports the dirty tree first when the repository is also mistagged', () => {
    // Both are fixed by the operator before re-running, and a stale tag on a
    // tree that is not even committed is the less useful thing to be told.
    const plan = planReleaseTag({
      identity: identity({ revision: OTHER }),
      repository: repository({ dirty: true, localTagSha: OTHER, hasOrigin: false }),
    })
    expect(plan.action === 'refuse' && plan.reason).toContain('uncommitted changes')
  })

  it('reports the revision mismatch before looking at tags of another commit', () => {
    // The tag conflict is a consequence of the mismatch here: the tag names the
    // build's revision, and HEAD is not it.
    const plan = planReleaseTag({
      identity: identity({ revision: OTHER }),
      repository: repository({ localTagSha: HEAD, remoteTagSha: HEAD }),
    })
    expect(plan.action).toBe('refuse')
    expect(plan.action === 'refuse' && plan.reason).toContain('built from')
    expect(plan.action === 'refuse' && plan.reason).not.toContain('git tag -d')
  })
})
