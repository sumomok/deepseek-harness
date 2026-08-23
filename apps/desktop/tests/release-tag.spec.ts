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

  it('pushes a tag that already names HEAD instead of creating it again', () => {
    // What a --republish repairing a cut-off upload sees: the first run tagged
    // this commit, and that tag is the one this release wants.
    const plan = planReleaseTag({ version: VERSION, repository: repository({ localTagSha: HEAD }) })
    expect(plan).toEqual({ action: 'push-existing', tag: TAG })
  })

  it('pushes an existing tag that origin already carries at the same commit', () => {
    const plan = planReleaseTag({ version: VERSION, repository: repository({ localTagSha: HEAD, remoteTagSha: HEAD }) })
    expect(plan).toEqual({ action: 'push-existing', tag: TAG })
  })

  it('creates the tag locally when only origin carries it, at HEAD', () => {
    const plan = planReleaseTag({ version: VERSION, repository: repository({ remoteTagSha: HEAD }) })
    expect(plan).toEqual({ action: 'create', tag: TAG })
  })

  it('skips everything, including preflight, when --no-tag turned the step off', () => {
    const plan = planReleaseTag({ version: VERSION, repository: undefined })
    expect(plan.action).toBe('skip')
    expect(plan.action === 'skip' && plan.reason).toContain('--no-tag')
  })

  it('refuses a dirty working tree, because the tag would not name what was built', () => {
    const plan = planReleaseTag({ version: VERSION, repository: repository({ dirty: true }) })
    expect(plan.action).toBe('refuse')
    expect(plan.action === 'refuse' && plan.reason).toContain('uncommitted changes')
    expect(plan.action === 'refuse' && plan.reason).toContain('--no-tag')
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
