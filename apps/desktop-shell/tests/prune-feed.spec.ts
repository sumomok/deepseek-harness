/**
 * What a publish leaves in an update-feed directory: which builds keep their
 * artifacts, which keep their blockmaps, and what is never a deletion candidate
 * at all.
 *
 * Retention follows builds, not versions: two builds of one upstream version
 * ship as separate releases whose bytes differ, so a version-shaped window
 * cannot tell them apart. A v1 directory predates build sequences and keeps its
 * version ordering, while a v2 directory orders by the sequence its names
 * carry. The two protocols live in separate directories, and a name from the
 * other protocol's naming is never deleted by a rule that does not describe it.
 *
 * The bridge a migration depends on is protected by the caller, not guessed
 * here: the v1 manifest, every artifact it serves, and the blockmap derived
 * from each of those artifact names by appending `.blockmap` — a name the
 * manifest never lists but an old client requests.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { bridgeArtifactNames, standardArtifactNames, type StandardReleaseIdentity } from '../scripts/artifact-names.ts'
import {
  DEFAULT_PRUNE_POLICY,
  KEPT_ARTIFACT_BUILDS,
  KEPT_BLOCKMAP_BUILDS,
  planPrune,
  type PruneDecision,
  type PruneInputs,
} from '../scripts/prune-feed.ts'

const VERSION = '0.2.2-rc.1'
const REVISION = '0123456789abcdef0123456789abcdef01234567'

/**
 * One standard build's identity.
 * @param sequence - the build sequence.
 * @param version - the application version.
 * @returns the identity.
 */
function standardIdentity(sequence: number, version = VERSION): StandardReleaseIdentity {
  return {
    version,
    dshRelease: { schemaVersion: 2, runtimeVersion: version, buildSequence: sequence, revision: REVISION, kind: 'standard' },
  }
}

/**
 * The macOS files of one v2 build.
 * @param sequence - the build sequence.
 * @returns the artifact and blockmap names.
 */
function build(sequence: number): string[] {
  return standardArtifactNames(standardIdentity(sequence), { mac: true, win: false })
}

/**
 * The macOS files of one v1 version.
 * @param version - the version.
 * @returns the artifact and blockmap names.
 */
function version(version: string): string[] {
  return bridgeArtifactNames(version, { mac: true, win: false })
}

/**
 * One channel directory holding each build's files beside the manifest.
 * @param builds - each build's file names, in the order the server listed them.
 * @param manifest - the manifest name the channel serves.
 * @returns every entry the directory holds.
 */
function directory(builds: string[][], manifest = 'latest-mac.yml'): string[] {
  return [manifest, ...builds.flat()]
}

/**
 * The artifacts of a build, without its blockmaps.
 * @param names - the build's file names.
 * @returns the non-blockmap names.
 */
function artifactsOf(names: readonly string[]): string[] {
  return names.filter(name => !name.endsWith('.blockmap'))
}

/**
 * The blockmaps of a build.
 * @param names - the build's file names.
 * @returns the blockmap names.
 */
function blockmapsOf(names: readonly string[]): string[] {
  return names.filter(name => name.endsWith('.blockmap'))
}

/**
 * Every name a decision accounted for, which must be the input exactly once over.
 * @param decision - the decision to flatten.
 * @returns all four groups concatenated.
 */
function accounted(decision: PruneDecision): string[] {
  return [...decision.keep.map(entry => entry.name), ...decision.unparsed, ...decision.deleteArtifacts, ...decision.deleteBlockmaps]
}

/**
 * A v2 prune request whose protection names the manifest.
 * @param names - the directory's entries.
 * @param publishedNames - what this publish uploaded or rewrote.
 * @param overrides - request fields to replace.
 * @returns the request.
 */
function v2(names: string[], publishedNames: string[], overrides: Partial<PruneInputs> = {}): PruneInputs {
  return {
    protocol: 'v2',
    names,
    publishedNames,
    protection: { names: ['latest-mac.yml'], prefixes: [] },
    operation: 'apply',
    ...overrides,
  }
}

/**
 * A v1 prune request whose protection names the manifest.
 * @param names - the directory's entries.
 * @param publishedNames - what this publish uploaded or rewrote.
 * @param overrides - request fields to replace.
 * @returns the request.
 */
function v1(names: string[], publishedNames: string[], overrides: Partial<PruneInputs> = {}): PruneInputs {
  return {
    protocol: 'v1',
    names,
    publishedNames,
    protection: { names: ['latest-mac.yml'], prefixes: [] },
    operation: 'apply',
    ...overrides,
  }
}

/** `0.1.0-rc.N` for each of the given release candidates. */
const rc = (...numbers: number[]): string[] => numbers.map(number => `0.1.0-rc.${String(number)}`)

describe('planPrune over a v2 directory', () => {
  it('keeps the newest two builds\' artifacts and the newest ten builds\' blockmaps', () => {
    const builds = [9, 10, 11, 12, 13, 14]
    const decision = planPrune(v2(directory(builds.map(build)), [...build(14), 'latest-mac.yml']))
    expect(decision.kind).toBe('apply')
    expect(decision.deleteArtifacts).toEqual([9, 10, 11, 12].flatMap(sequence => artifactsOf(build(sequence))))
    expect(decision.deleteBlockmaps).toEqual([])
    expect(decision.keep).toContainEqual({ name: build(13)[0], reason: 'retained' })
    expect(decision.keep).toContainEqual({ name: build(14)[0], reason: 'published' })
    expect(decision.unparsed).toEqual([])
  })

  it('keeps a blockmap whose artifact it deletes', () => {
    // The differential download path asks the feed for the new build's
    // blockmap even when the artifact itself is past the artifact window.
    const builds = Array.from({ length: 12 }, (_, index) => index + 1)
    const decision = planPrune(v2(directory(builds.map(build)), [...build(12), 'latest-mac.yml']))
    expect(decision.deleteBlockmaps).toEqual([...blockmapsOf(build(1)), ...blockmapsOf(build(2))])
    // Build 10 is past the artifact window but inside the blockmap window.
    expect(decision.keep).toContainEqual({ name: build(10)[1], reason: 'retained' })
    expect(decision.deleteArtifacts).toContain(build(10)[0] ?? '')
  })

  it('orders builds by sequence, not by the text of the name', () => {
    // `b10` sorts before `b9` as text, which would keep b9 and delete the build
    // a client is about to update to.
    const decision = planPrune(v2(directory([9, 10, 11].map(build)), [...build(11), 'latest-mac.yml']))
    expect(decision.deleteArtifacts).toEqual(artifactsOf(build(9)))
    expect(decision.keep).toContainEqual({ name: build(10)[0], reason: 'retained' })
  })

  it('never selects a file this publish just wrote, whatever else the directory holds', () => {
    // A publish of an older build while a newer one sits in the directory: the
    // window would drop the older build, but its files are what this publish
    // just uploaded and what its manifest now points at.
    const decision = planPrune(v2(directory([100, 101, 102, 103].map(build)), [...build(100), 'latest-mac.yml']))
    expect(decision.keep).toContainEqual({ name: build(100)[0], reason: 'published' })
    expect(decision.keep).toContainEqual({ name: build(100)[1], reason: 'published' })
    expect(decision.deleteArtifacts).toEqual(artifactsOf(build(101)))
  })

  it('leaves a legacy-named file alone instead of reading it under the v2 rule', () => {
    // A v1 file in a v2 directory belongs to the other protocol. Deleting it
    // would be pruning by a rule that does not describe the file.
    const stranger = version(VERSION)[0] ?? ''
    const decision = planPrune(v2(directory([1, 2, 3, 4].map(build), 'latest-mac.yml').concat(stranger), [...build(4), 'latest-mac.yml']))
    expect(decision.unparsed).toEqual([stranger])
    expect(decision.deleteArtifacts).not.toContain(stranger)
  })
})

describe('planPrune over a v1 directory', () => {
  it('orders versions by semver precedence, so rc.9 goes before rc.10 does', () => {
    const versions = rc(9, 10, 11)
    const decision = planPrune(v1(directory(versions.map(version)), [...version('0.1.0-rc.11'), 'latest-mac.yml']))
    // Lexicographically `0.1.0-rc.9` is the *newest* of the three, which would
    // keep the oldest build and delete the one clients are about to update from.
    expect(decision.deleteArtifacts).toEqual(artifactsOf(version('0.1.0-rc.9')))
    expect(decision.keep).toContainEqual({ name: version('0.1.0-rc.10')[0], reason: 'retained' })
  })

  it('orders the blockmap window by semver precedence too', () => {
    const versions = rc(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12)
    const decision = planPrune(v1(directory(versions.map(version)), [...version('0.1.0-rc.12'), 'latest-mac.yml']))
    // Lexicographic order would drop rc.10's blockmap and keep rc.9's.
    expect(decision.deleteBlockmaps).toEqual([...blockmapsOf(version('0.1.0-rc.1')), ...blockmapsOf(version('0.1.0-rc.2'))])
    expect(decision.keep).toContainEqual({ name: version('0.1.0-rc.10')[1], reason: 'retained' })
  })

  it('reads a version carrying build metadata', () => {
    // The retired rule matched versions with a regular expression that rejected
    // `+metadata`, so such a name would have been neither kept by a window nor
    // recognized at all.
    const versions = ['0.1.0-rc.18', '0.1.0-rc.19', '0.1.0+build.7']
    const decision = planPrune(v1(directory(versions.map(version)), [...version('0.1.0+build.7'), 'latest-mac.yml']))
    expect(decision.unparsed).toEqual([])
    expect(decision.deleteArtifacts).toEqual(artifactsOf(version('0.1.0-rc.18')))
    expect(decision.keep).toContainEqual({ name: version('0.1.0+build.7')[0], reason: 'published' })
  })

  it('leaves a build-addressed file alone instead of reading it under the v1 rule', () => {
    const stranger = build(7)[0] ?? ''
    const names = directory(rc(3, 4, 5, 6).map(version), 'latest-mac.yml').concat(stranger)
    const decision = planPrune(v1(names, [...version('0.1.0-rc.6'), 'latest-mac.yml']))
    expect(decision.unparsed).toEqual([stranger])
    expect(decision.deleteArtifacts).not.toContain(stranger)
  })
})

describe('protection', () => {
  it('keeps the bridge manifest and every file it serves, whatever the windows say', () => {
    // The first bridged release serves a v1 manifest that must keep working for
    // clients that have not updated yet: the installer bytes, the blockmap the
    // client derives from the installer's name, and the manifest itself.
    const bridge = version('0.1.0-rc.3')
    const names = directory(rc(3, 9, 10, 11, 12).map(version), 'latest-mac.yml')
    const decision = planPrune(v1(names, [...version('0.1.0-rc.12'), 'latest-mac.yml'], {
      protection: { names: ['latest-mac.yml', ...bridge], prefixes: [] },
    }))
    for (const name of bridge) {
      expect(decision.keep, name).toContainEqual({ name, reason: 'protected' })
      expect([...decision.deleteArtifacts, ...decision.deleteBlockmaps]).not.toContain(name)
    }
    // The manifest is also in this publish's own file list, which outranks the
    // manifest rule; what matters is that it is kept either way.
    expect(decision.keep.map(entry => entry.name)).toContain('latest-mac.yml')
    expect(decision.deleteArtifacts).toContain(version('0.1.0-rc.9')[0] ?? '')
  })

  it('keeps every entry a protected prefix matches', () => {
    const protectedBuild = version('0.1.0-rc.9')
    const decision = planPrune(v1(directory(rc(9, 10, 11, 12).map(version)), [...version('0.1.0-rc.12'), 'latest-mac.yml'], {
      protection: { names: ['latest-mac.yml'], prefixes: ['DSH Desktop-0.1.0-rc.9'] },
    }))
    for (const name of protectedBuild) {
      expect(decision.keep, name).toContainEqual({ name, reason: 'protected' })
    }
    expect(decision.deleteArtifacts).not.toContain(protectedBuild[0])
  })

  it('reports a protection the directory does not hold', () => {
    // The caller protected a file that is not there, which means either the
    // protection set belongs to another directory or the file is already gone.
    // Either way the plan has to say so instead of looking complete.
    const decision = planPrune(v2(directory([1, 2, 3].map(build)), [...build(3), 'latest-mac.yml'], {
      protection: { names: ['latest-mac.yml', 'bridge-manifest.json'], prefixes: [] },
    }))
    expect(decision.absentProtections).toEqual(['bridge-manifest.json'])
  })

  it('never selects a manifest', () => {
    const decision = planPrune(v2(['latest.yml', 'latest-mac.yml', ...build(1)], [...build(1)]))
    expect(decision.keep).toContainEqual({ name: 'latest.yml', reason: 'manifest' })
    expect(decision.keep).toContainEqual({ name: 'latest-mac.yml', reason: 'manifest' })
    expect(accounted(decision).filter(name => name.endsWith('.yml')).every(name => decision.keep.some(entry => entry.name === name))).toBe(true)
  })
})

describe('what the caller may do with a plan', () => {
  it('applies the plan only when deletion was asked for and protection was stated', () => {
    const request = v2(directory([1, 2, 3, 4].map(build)), [...build(4), 'latest-mac.yml'])
    expect(planPrune(request).kind).toBe('apply')
  })

  it('reports instead of deleting on a dry run, still listing what it would delete', () => {
    const request = v2(directory([1, 2, 3, 4].map(build)), [...build(4), 'latest-mac.yml'], { operation: 'report' })
    const decision = planPrune(request)
    expect(decision.kind).toBe('report')
    expect(decision.kind === 'report' && decision.reason).toContain('dry run')
    expect(decision.deleteArtifacts).toEqual([build(1)[0] ?? '', build(1)[2] ?? '', build(2)[0] ?? '', build(2)[2] ?? ''])
  })

  it('refuses to delete when the caller stated no protection at all', () => {
    // A directory whose protection the caller did not state is one this plan
    // cannot show to be safe: the bridge a first migration depends on lives
    // exactly in such names.
    const request = v2(directory([1, 2, 3, 4].map(build)), [...build(4), 'latest-mac.yml'], {
      protection: { names: [], prefixes: [] },
    })
    const decision = planPrune(request)
    expect(decision.kind).toBe('report')
    expect(decision.kind === 'report' && decision.reason).toContain('protected file')
    expect(decision.deleteArtifacts.length).toBeGreaterThan(0)
  })

  it('defaults its windows to the published policy', () => {
    expect(DEFAULT_PRUNE_POLICY).toEqual({
      artifactGenerations: KEPT_ARTIFACT_BUILDS,
      blockmapGenerations: KEPT_BLOCKMAP_BUILDS,
    })
    expect(KEPT_ARTIFACT_BUILDS).toBe(2)
    expect(KEPT_BLOCKMAP_BUILDS).toBe(10)
  })

  it('applies a policy the caller passes instead', () => {
    const decision = planPrune(v2(directory([1, 2, 3].map(build)), [...build(3), 'latest-mac.yml'], {
      policy: { artifactGenerations: 1, blockmapGenerations: 1 },
    }))
    expect(decision.deleteArtifacts).toEqual([...artifactsOf(build(1)), ...artifactsOf(build(2))])
    expect(decision.deleteBlockmaps).toEqual([...blockmapsOf(build(1)), ...blockmapsOf(build(2))])
  })
})

describe('recognition and accounting', () => {
  it('leaves names no rule reads alone instead of guessing at them', () => {
    const strangers = ['DSH Desktop Setup nightly.exe', 'notes.txt', 'latest-mac.json', 'win-unpacked']
    const decision = planPrune(v2([...strangers, ...directory([1, 2, 3, 4].map(build))], [...build(4), 'latest-mac.yml']))
    expect(decision.unparsed).toEqual(strangers)
    for (const stranger of strangers) {
      expect(decision.deleteArtifacts).not.toContain(stranger)
      expect(decision.deleteBlockmaps).not.toContain(stranger)
    }
  })

  it('deletes nothing from a directory holding fewer builds than either window', () => {
    const names = directory([1, 2].map(build))
    const decision = planPrune(v2(names, [...build(2), 'latest-mac.yml']))
    expect(decision.deleteArtifacts).toEqual([])
    expect(decision.deleteBlockmaps).toEqual([])
    expect(decision.keep.map(entry => entry.name)).toEqual(names)
  })

  it('accounts for every name in the directory exactly once', () => {
    const names = ['notes.txt', ...directory([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(build))]
    const decision = planPrune(v2(names, [...build(13), 'latest-mac.yml']))
    expect([...accounted(decision)].sort()).toEqual([...names].sort())
    expect(decision.deleteArtifacts.length).toBe(11 * 2)
    expect(decision.deleteBlockmaps.length).toBe(3 * 2)
  })
})
