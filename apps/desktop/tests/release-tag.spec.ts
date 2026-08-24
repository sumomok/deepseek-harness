/**
 * What a publish does about its release tag: which repository states let the
 * tag follow the upload, and which ones stop the publish before it starts.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { planReleaseTag, releaseTagName, type RepositoryState } from '../scripts/release-tag.ts'

const VERSION = '0.1.0-rc.20'
const TAG = 'desktop-v0.1.0-rc.20'
const HEAD = '1111111111111111111111111111111111111111'
const OTHER = '2222222222222222222222222222222222222222'

/**
 * A repository ready to be tagged, with the named facts overridden.
 * @param overrides - what differs from the clean, origin-carrying, untagged case.
 * @returns the repository state to plan against.
 */
function repository(overrides: Partial<RepositoryState> = {}): RepositoryState {
  return { headSha: HEAD, localTagSha: undefined, remoteTagSha: undefined, dirty: false, hasOrigin: true, ...overrides }
}

describe('releaseTagName', () => {
  it('names the tag after the version being published', () => {
    expect(releaseTagName(VERSION)).toBe(TAG)
    expect(releaseTagName('1.0.0')).toBe('desktop-v1.0.0')
  })
})

describe('planReleaseTag', () => {
  it('creates the tag when the tree is clean and nothing carries it yet', () => {
    expect(planReleaseTag({ version: VERSION, repository: repository() })).toEqual({ action: 'create', tag: TAG })
  })

  it('pushes a tag only this repository carries, at HEAD, instead of creating it again', () => {
    // What a --republish repairing a cut-off upload sees in the worktree that
    // tagged first: the tag it made is the one this release wants.
    const plan = planReleaseTag({ version: VERSION, repository: repository({ localTagSha: HEAD }) })
    expect(plan).toEqual({ action: 'push-existing', tag: TAG })
  })

  it('fetches the tag origin already carries at HEAD rather than creating a second one', () => {
    // Another worktree of this repository published the tag. Creating an
    // annotated object here for the same name only produces a push origin
    // rejects, so origin's copy is the one to take.
    const plan = planReleaseTag({ version: VERSION, repository: repository({ remoteTagSha: HEAD }) })
    expect(plan).toEqual({ action: 'fetch-existing', tag: TAG })
  })

  it('runs no git when both sides already carry the tag at HEAD', () => {
    // The two tag objects may differ — one made here, one made through the
    // GitHub API — while both peel to HEAD. Pushing would be rejected and
    // nothing needs doing, so the release is simply already tagged.
    const plan = planReleaseTag({ version: VERSION, repository: repository({ localTagSha: HEAD, remoteTagSha: HEAD }) })
    expect(plan).toEqual({ action: 'already-on-origin', tag: TAG })
  })

  it('skips everything, including preflight, when --no-tag turned the step off', () => {
    const plan = planReleaseTag({ version: VERSION, repository: undefined })
    expect(plan.action).toBe('skip')
    expect(plan.action === 'skip' && plan.reason).toContain('--no-tag')
  })

  it('refuses a dirty working tree, because the tag would not name what was built', () => {
    const plan = planReleaseTag({ version: VERSION, repository: repository({ dirty: true }) })
    expect(plan.action).toBe('refuse')
    expect(plan.action === 'refuse' && plan.reason).toContain('uncommitted changes to tracked files')
    expect(plan.action === 'refuse' && plan.reason).toContain('--no-tag')
  })

  it('is untroubled by untracked files, which the caller excludes from dirty', () => {
    // `dirty` is `git status --porcelain --untracked-files=no`: the release
    // run's own logs and an ignored .env sit in the worktree permanently and
    // change nothing the build compiles.
    expect(planReleaseTag({ version: VERSION, repository: repository({ dirty: false }) })).toEqual({ action: 'create', tag: TAG })
  })

  it('refuses a repository with no origin to push to', () => {
    const plan = planReleaseTag({ version: VERSION, repository: repository({ hasOrigin: false }) })
    expect(plan.action).toBe('refuse')
    expect(plan.action === 'refuse' && plan.reason).toContain('origin')
  })

  it('refuses a local tag that names another commit, naming both', () => {
    const plan = planReleaseTag({ version: VERSION, repository: repository({ localTagSha: OTHER }) })
    expect(plan.action).toBe('refuse')
    expect(plan.action === 'refuse' && plan.reason).toContain(OTHER.slice(0, 12))
    expect(plan.action === 'refuse' && plan.reason).toContain(HEAD.slice(0, 12))
    expect(plan.action === 'refuse' && plan.reason).toContain(`git tag -d ${TAG}`)
  })

  it('refuses a tag origin already carries at another commit', () => {
    const plan = planReleaseTag({ version: VERSION, repository: repository({ remoteTagSha: OTHER }) })
    expect(plan.action).toBe('refuse')
    expect(plan.action === 'refuse' && plan.reason).toContain(`git push origin :refs/tags/${TAG}`)
  })

  it('reports the dirty tree first when the repository is also mistagged', () => {
    // Both are fixed by the operator before re-running, and a stale tag on a
    // tree that is not even committed is the less useful thing to be told.
    const plan = planReleaseTag({ version: VERSION, repository: repository({ dirty: true, localTagSha: OTHER, hasOrigin: false }) })
    expect(plan.action === 'refuse' && plan.reason).toContain('uncommitted changes')
  })
})
