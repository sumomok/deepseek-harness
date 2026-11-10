/**
 * What a publish decides before it touches a server: which protocol tree a
 * build belongs to, whether the channel may move at all, which red line it
 * writes, which feed manifest it serves, what the served feed must read back
 * as, and what a prune must never delete.
 *
 * Every case here is pure: the upload, ssh, and HTTP faces are off-limits in a
 * unit test, and the decisions they carry out are the part that can be wrong
 * without a network. The bridge cases are the ones that matter most — a bridge
 * build is the only thing standing between the old clients and this protocol,
 * so publishing one into the v2 tree, overwriting a served build's bytes, or
 * letting a prune take its blockmap are all refused here.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { load, dump, CORE_SCHEMA } from 'js-yaml'
import { expectedArtifacts } from '../scripts/artifact-names.ts'
import type { ReleaseIdentity } from '../src/release-identity.ts'
import type { ReleaseManifest, ReleaseManifestArtifact } from '../scripts/release-manifest.ts'
import {
  auditReleaseArtifacts,
  buildFeedManifest,
  channelLocation,
  feedProtocolFor,
  FEED_CHANNELS,
  isCleanArtifactReport,
  liveFingerprint,
  parseLiveFeed,
  planChannelPublish,
  pruneProtectionFor,
  PublishError,
  resolveFeedProtocol,
  servedBytesMismatches,
  verifyFeedReadback,
  type FeedChannel,
  type FeedManifest,
  type LiveRead,
} from '../scripts/publish-update.ts'

const VERSION = '0.2.2-rc.1'
const BRIDGE_VERSION = '0.2.2-rc.4'
const REVISION = '0123456789abcdef0123456789abcdef01234567'
const OTHER_REVISION = 'fedcba9876543210fedcba9876543210fedcba98'
const DIGEST = `${'A'.repeat(86)}==`
const OTHER_DIGEST = `${'B'.repeat(86)}==`

/**
 * The mac channel, as the script publishes it.
 * @returns the mac channel entry.
 */
function mac(): FeedChannel {
  const channel = FEED_CHANNELS.find(entry => entry.name === 'mac')
  if (channel === undefined) throw new Error('fixture: FEED_CHANNELS has no mac channel')
  return channel
}

/**
 * The win channel, as the script publishes it.
 * @returns the win channel entry.
 */
function win(): FeedChannel {
  const channel = FEED_CHANNELS.find(entry => entry.name === 'win')
  if (channel === undefined) throw new Error('fixture: FEED_CHANNELS has no win channel')
  return channel
}

/**
 * One standard build's identity.
 * @param sequence - the build sequence.
 * @param overrides - version or revision to replace.
 * @returns the identity.
 */
function standardIdentity(sequence: number, overrides: { version?: string; revision?: string } = {}): ReleaseIdentity {
  const version = overrides.version ?? VERSION
  return {
    version,
    dshRelease: {
      schemaVersion: 2,
      runtimeVersion: version,
      buildSequence: sequence,
      revision: overrides.revision ?? REVISION,
      kind: 'standard',
    },
  }
}

/**
 * One bridge build's identity.
 * @param sequence - the build sequence.
 * @param overrides - version or revision to replace.
 * @returns the identity.
 */
function bridgeIdentity(sequence: number, overrides: { version?: string; revision?: string } = {}): ReleaseIdentity {
  return {
    version: overrides.version ?? BRIDGE_VERSION,
    dshRelease: {
      schemaVersion: 2,
      runtimeVersion: VERSION,
      buildSequence: sequence,
      revision: overrides.revision ?? REVISION,
      kind: 'bridge',
    },
  }
}

/**
 * The artifact entries (no blockmaps) one mac build's manifest lists.
 * @param identity - the build.
 * @returns the file names.
 */
function macArtifacts(identity: ReleaseIdentity): string[] {
  return expectedArtifacts(identity, { mac: true, win: false }).filter(name => !name.endsWith('.blockmap'))
}

/**
 * A served-mac-manifest fixture for one identity.
 * @param identity - the build the feed serves.
 * @param options - extra entries to add or replace.
 * @returns the YAML text.
 */
function liveV2(identity: ReleaseIdentity, options: { minimumBuildSequence?: number; files?: readonly string[] } = {}): string {
  const files = options.files ?? macArtifacts(identity)
  const minimum = options.minimumBuildSequence === undefined
    ? []
    : [`minimumBuildSequence: ${String(options.minimumBuildSequence)}`]
  return [
    `version: ${identity.version}`,
    'dshRelease:',
    '  schemaVersion: 2',
    `  runtimeVersion: ${identity.dshRelease.runtimeVersion}`,
    `  buildSequence: ${String(identity.dshRelease.buildSequence)}`,
    `  revision: '${identity.dshRelease.revision}'`,
    `  kind: ${identity.dshRelease.kind}`,
    'files:',
    ...files.map(name => `  - url: '${name}'\n    sha512: '${DIGEST}'\n    size: 100`),
    ...minimum,
  ].join('\n')
}

/**
 * A served v1 manifest fixture.
 * @param version - the version the old feed serves.
 * @param files - the artifact entries it lists.
 * @param minimumVersion - its red line, if any.
 * @returns the YAML text.
 */
function liveV1(version: string, files: readonly string[] = [`DSH Desktop-${version}-arm64-mac.zip`], minimumVersion?: string): string {
  return [
    `version: ${version}`,
    'files:',
    ...files.map(name => `  - url: '${name}'\n    sha512: '${DIGEST}'\n    size: 100`),
    ...minimumVersion === undefined ? [] : [`minimumVersion: ${minimumVersion}`],
  ].join('\n')
}

/**
 * A present reading of one served manifest.
 * @param text - the served bytes.
 * @param protocol - the directory they came from.
 * @returns the reading.
 */
function present(text: string, protocol: 'v1' | 'v2'): LiveRead {
  return { kind: 'present', feed: parseLiveFeed(protocol, text) }
}

/**
 * One artifact inventory for a release manifest fixture.
 * @param names - the file names the manifest declares.
 * @param overrides - digest or size to replace for every entry.
 * @returns the artifact entries.
 */
function artifactsOf(
  names: readonly string[],
  overrides: { sha512?: string; size?: number } = {},
): ReleaseManifestArtifact[] {
  return names.map(fileName => ({ fileName, sha512: overrides.sha512 ?? DIGEST, size: overrides.size ?? 100 }))
}

/**
 * A release manifest fixture naming one platform's artifacts.
 * @param identity - the build it describes.
 * @param platformArtifacts - the artifacts the platform produced.
 * @returns the manifest.
 */
function releaseManifestOf(identity: ReleaseIdentity, platformArtifacts: readonly ReleaseManifestArtifact[]): ReleaseManifest {
  return {
    version: identity.version,
    dshRelease: identity.dshRelease,
    platforms: {
      darwin: { arch: 'arm64', artifacts: platformArtifacts },
      win32: { arch: 'x64', artifacts: [] },
    },
  }
}

/**
 * The builder's own mac manifest, as `dist-app` holds it.
 * @param identity - the build.
 * @param overrides - fields to replace.
 * @returns the parsed document.
 */
function builderManifest(
  identity: ReleaseIdentity,
  overrides: { version?: string; files?: readonly { url: string; sha512: string; size: number }[]; path?: string } = {},
): Record<string, unknown> {
  const names = macArtifacts(identity)
  const files = overrides.files ?? names.map(url => ({ url, sha512: DIGEST, size: 100 }))
  return {
    version: overrides.version ?? identity.version,
    files,
    path: overrides.path ?? files[0]?.url,
    sha512: files[0]?.sha512,
    releaseDate: '2026-11-06T15:56:56.396Z',
  }
}

/**
 * Build one channel's feed manifest from fixtures.
 * @param identity - the build.
 * @param overrides - inputs to replace.
 * @returns the manifest.
 */
function manifestFor(
  identity: ReleaseIdentity,
  overrides: {
    protocol?: 'v1' | 'v2'
    source?: Record<string, unknown>
    artifacts?: readonly ReleaseManifestArtifact[]
    minimumBuildSequence?: number
    minimumVersion?: string
  } = {},
): FeedManifest {
  const protocol = overrides.protocol ?? feedProtocolFor(identity)
  const artifacts = overrides.artifacts ?? artifactsOf(expectedArtifacts(identity, { mac: true, win: false }))
  return buildFeedManifest({
    protocol,
    identity,
    source: overrides.source ?? builderManifest(identity),
    artifacts,
    releaseNotes: 'notes',
    ...overrides.minimumBuildSequence === undefined ? {} : { minimumBuildSequence: overrides.minimumBuildSequence },
    ...overrides.minimumVersion === undefined ? {} : { minimumVersion: overrides.minimumVersion },
  })
}

/**
 * Run a planner and require it to refuse.
 * @param run - the call that must refuse.
 * @param pattern - the part of the refusal that names the cause.
 */
function expectRefusal(run: () => unknown, pattern: RegExp): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(PublishError)
    expect(error instanceof PublishError ? error.code : '').toBe('PUBLISH_REFUSED')
    expect(error instanceof Error ? error.message : '').toMatch(pattern)
    return
  }
  throw new Error(`expected a refusal matching ${String(pattern)}`)
}

describe('which tree a build publishes to', () => {
  it('sends a bridge to v1 and a standard build to v2', () => {
    expect(feedProtocolFor(bridgeIdentity(100))).toBe('v1')
    expect(feedProtocolFor(standardIdentity(101))).toBe('v2')
  })

  it('refuses a requested tree the build does not belong to', () => {
    // The two directories serve different clients; a bridge in v2 would be
    // invisible to the old clients it exists for, and a standard build in v1
    // would be read by clients that cannot order it.
    expect(resolveFeedProtocol(standardIdentity(101), undefined)).toBe('v2')
    expect(resolveFeedProtocol(bridgeIdentity(100), undefined)).toBe('v1')
    expect(resolveFeedProtocol(bridgeIdentity(100), 'v1')).toBe('v1')
    expectRefusal(() => resolveFeedProtocol(bridgeIdentity(100), 'v2'), /publishes to v1 only/)
    expectRefusal(() => resolveFeedProtocol(standardIdentity(101), 'v1'), /publishes to v2 only/)
    expectRefusal(() => resolveFeedProtocol(standardIdentity(101), 'v3'), /must be v1 or v2/)
  })

  it('addresses v1 and v2 as separate directories of one feed', () => {
    expect(channelLocation('v1', mac()).relative).toBe('mac')
    expect(channelLocation('v1', mac()).remoteDir).toBe('/var/www/dsh-updates/mac')
    expect(channelLocation('v1', mac()).url).toBe('https://lhr.ink/dsh-updates/mac')
    expect(channelLocation('v2', mac()).relative).toBe('v2/mac')
    expect(channelLocation('v2', win()).url).toBe('https://lhr.ink/dsh-updates/v2/win')
  })
})

describe('ordering one v2 channel', () => {
  it('accepts a larger build sequence', () => {
    const plan = planChannelPublish({
      channel: mac(),
      identity: standardIdentity(102),
      live: present(liveV2(standardIdentity(101)), 'v2'),
      republish: false,
    })
    expect(plan.protocol).toBe('v2')
    expect(plan.alreadyServed).toBe(false)
  })

  it('refuses a sequence that moved backwards', () => {
    expectRefusal(
      () => planChannelPublish({
        channel: mac(),
        identity: standardIdentity(100),
        live: present(liveV2(standardIdentity(101)), 'v2'),
        republish: true,
      }),
      /never moves backwards/,
    )
  })

  it('refuses one sequence naming two different builds', () => {
    // A different revision under the same sequence is a publisher error, not a
    // higher build: the clients would disagree about which bytes the sequence
    // means depending on which feed answered first.
    expectRefusal(
      () => planChannelPublish({
        channel: mac(),
        identity: standardIdentity(101, { revision: OTHER_REVISION }),
        live: present(liveV2(standardIdentity(101)), 'v2'),
        republish: true,
      }),
      /one sequence may not name two builds/,
    )
  })

  it('finishes an identical build only when --republish asked for it', () => {
    const live = present(liveV2(standardIdentity(101)), 'v2')
    expectRefusal(
      () => planChannelPublish({ channel: mac(), identity: standardIdentity(101), live, republish: false }),
      /--republish/,
    )
    const plan = planChannelPublish({ channel: mac(), identity: standardIdentity(101), live, republish: true })
    expect(plan.alreadyServed).toBe(true)
    expect(plan.republish).toBe(true)
  })

  it('reads the served identity, not just the served version', () => {
    const live = present(liveV2(standardIdentity(101)), 'v2')
    const plan = planChannelPublish({ channel: mac(), identity: standardIdentity(101), live, republish: true })
    expect(plan.live?.identity?.dshRelease.buildSequence).toBe(101)
  })
})

describe('ordering one v1 channel', () => {
  it('keeps the version comparison the old feed always used', () => {
    const live = present(liveV1('0.2.2-rc.3'), 'v1')
    expectRefusal(
      () => planChannelPublish({ channel: mac(), identity: bridgeIdentity(100, { version: '0.2.2-rc.2' }), live, republish: true }),
      /newer than the 0\.2\.2-rc\.2/,
    )
    expectRefusal(
      () => planChannelPublish({ channel: mac(), identity: bridgeIdentity(100, { version: '0.2.2-rc.3' }), live, republish: false }),
      /--republish/,
    )
    const plan = planChannelPublish({ channel: mac(), identity: bridgeIdentity(100, { version: '0.2.2-rc.3' }), live, republish: true })
    expect(plan.protocol).toBe('v1')
    expect(plan.alreadyServed).toBe(true)
  })

  it('inherits the served minimumVersion when the run sets none', () => {
    const plan = planChannelPublish({
      channel: mac(),
      identity: bridgeIdentity(100, { version: '0.2.2-rc.4' }),
      live: present(liveV1('0.2.2-rc.3', undefined, '0.2.2-rc.2'), 'v1'),
      republish: false,
    })
    expect(plan.minimumVersion).toBe('0.2.2-rc.2')
  })

  it('refuses the v1 red line on a v2 publish', () => {
    expectRefusal(
      () => planChannelPublish({
        channel: mac(),
        identity: standardIdentity(101),
        live: { kind: 'absent' },
        republish: false,
        minimumVersion: '0.2.2-rc.0',
      }),
      /v1 red line/,
    )
  })

  it('refuses the v2 red line on a bridge publish', () => {
    expectRefusal(
      () => planChannelPublish({
        channel: mac(),
        identity: bridgeIdentity(100),
        live: { kind: 'absent' },
        republish: false,
        minimumBuildSequence: 50,
      }),
      /v2 red line/,
    )
  })
})

describe('minimumBuildSequence', () => {
  it('inherits the served line when the run sets none', () => {
    // Omitting the flag must never drop the line: a publish that forgets it
    // would stop forcing the updates the publisher already required.
    const plan = planChannelPublish({
      channel: mac(),
      identity: standardIdentity(102),
      live: present(liveV2(standardIdentity(101), { minimumBuildSequence: 100 }), 'v2'),
      republish: false,
    })
    expect(plan.minimumBuildSequence).toBe(100)
  })

  it('takes an explicit line that stays at or below the target build', () => {
    const plan = planChannelPublish({
      channel: mac(),
      identity: standardIdentity(102),
      live: present(liveV2(standardIdentity(101), { minimumBuildSequence: 100 }), 'v2'),
      republish: false,
      minimumBuildSequence: 101,
    })
    expect(plan.minimumBuildSequence).toBe(101)
  })

  it('refuses a line above the build being published', () => {
    // A line above its own build leaves every client unable to reach it.
    expectRefusal(
      () => planChannelPublish({
        channel: mac(),
        identity: standardIdentity(102),
        live: present(liveV2(standardIdentity(101)), 'v2'),
        republish: false,
        minimumBuildSequence: 103,
      }),
      /above the 102/,
    )
  })

  it('refuses a line that is not a positive safe integer', () => {
    for (const value of [0, -1, 1.5, Number.NaN]) {
      expectRefusal(
        () => planChannelPublish({
          channel: mac(),
          identity: standardIdentity(102),
          live: { kind: 'absent' },
          republish: false,
          minimumBuildSequence: value,
        }),
        /positive safe integer/,
      )
    }
  })

  it('inherits nothing on a first publish without the flag', () => {
    const plan = planChannelPublish({
      channel: mac(),
      identity: standardIdentity(101),
      live: { kind: 'absent' },
      republish: false,
    })
    expect(plan.minimumBuildSequence).toBeUndefined()
  })

  it('reports a deliberate lowering instead of hiding it', () => {
    // An explicit lower line is a decision the operator may make; silently
    // lowering one by inheriting is not.
    const plan = planChannelPublish({
      channel: mac(),
      identity: standardIdentity(102),
      live: present(liveV2(standardIdentity(101), { minimumBuildSequence: 100 }), 'v2'),
      republish: false,
      minimumBuildSequence: 90,
    })
    expect(plan.minimumBuildSequence).toBe(90)
    expect(plan.loweredBuildSequence).toBe(100)
  })
})

describe('the three live-feed outcomes', () => {
  it('allows a first publish when the feed is absent', () => {
    const plan = planChannelPublish({ channel: mac(), identity: standardIdentity(101), live: { kind: 'absent' }, republish: false })
    expect(plan.live).toBeUndefined()
  })

  it('stops when the server could not be read, instead of treating it as empty', () => {
    // An unreadable feed may hold any ordering; publishing over it is how a
    // sequence collision or a rollback gets through.
    expectRefusal(
      () => planChannelPublish({
        channel: mac(),
        identity: standardIdentity(101),
        live: { kind: 'unreadable', reason: 'ssh exited 255' },
        republish: false,
      }),
      /unreadable feed is not an empty one/,
    )
  })

  it('stops when the served manifest is damaged', () => {
    expectRefusal(
      () => planChannelPublish({
        channel: mac(),
        identity: standardIdentity(101),
        live: { kind: 'damaged', reason: 'files[] is missing' },
        republish: false,
      }),
      /not a usable feed manifest/,
    )
  })

  it('refuses bytes that do not parse instead of reading them as absent', () => {
    expectRefusal(() => parseLiveFeed('v2', 'version: [unclosed'), /does not parse/)
    expectRefusal(() => parseLiveFeed('v2', 'version: 0.2.2-rc.1\nfiles: []'), /files\[\]/)
  })

  it('refuses a v2 manifest without a build identity', () => {
    const text = [`version: ${VERSION}`, 'files:', `  - url: '${macArtifacts(standardIdentity(101))[0] ?? ''}'`, `    sha512: '${DIGEST}'`, '    size: 100'].join('\n')
    expectRefusal(() => parseLiveFeed('v2', text), /dshRelease/)
  })

  it('distinguishes the outcomes in the CAS fingerprint', () => {
    const absent = liveFingerprint({ kind: 'absent' })
    const unreadable = liveFingerprint({ kind: 'unreadable', reason: 'timeout' })
    const damaged = liveFingerprint({ kind: 'damaged', reason: 'bad yaml' })
    const first = liveFingerprint(present(liveV2(standardIdentity(101)), 'v2'))
    const second = liveFingerprint(present(liveV2(standardIdentity(101, { revision: OTHER_REVISION })), 'v2'))
    expect(new Set([absent, unreadable, damaged, first, second]).size).toBe(5)
    expect(liveFingerprint(present(liveV2(standardIdentity(101)), 'v2'))).toBe(first)
  })
})

describe('the manifest a publish writes', () => {
  it('repeats the build identity in v2 and sets its red line', () => {
    const identity = standardIdentity(101)
    const manifest = manifestFor(identity, { minimumBuildSequence: 100 })
    expect(manifest.document.dshRelease).toEqual(identity.dshRelease)
    expect(manifest.document.minimumBuildSequence).toBe(100)
    expect(manifest.document.minimumVersion).toBeUndefined()
    expect(manifest.files.map(file => file.url)).toEqual(macArtifacts(identity))
  })

  it('writes only old fields in v1 and strips the v2-only ones', () => {
    // Old clients ignore dshRelease and minimumBuildSequence; a later reader
    // must not mistake either for this build's identity or red line.
    const identity = bridgeIdentity(100)
    const source = { ...builderManifest(identity), dshRelease: identity.dshRelease, minimumBuildSequence: 90 }
    const manifest = manifestFor(identity, { protocol: 'v1', source, minimumVersion: '0.2.2-rc.2' })
    expect(manifest.document.dshRelease).toBeUndefined()
    expect(manifest.document.minimumBuildSequence).toBeUndefined()
    expect(manifest.document.minimumVersion).toBe('0.2.2-rc.2')
    expect(manifest.document.releaseNotes).toBe('notes')
  })

  it('refuses a builder manifest that describes another version', () => {
    expectRefusal(
      () => manifestFor(standardIdentity(101), { source: builderManifest(standardIdentity(101), { version: '0.2.2-rc.0' }) }),
      /not this release/,
    )
  })

  it('refuses files[] bytes that disagree with the release manifest', () => {
    // The release manifest is the record of what was built; a builder manifest
    // that points at other bytes would publish a feed nobody verified.
    const identity = standardIdentity(101)
    const source = builderManifest(identity, {
      files: [{ url: macArtifacts(identity)[0] ?? '', sha512: OTHER_DIGEST, size: 100 }],
    })
    expectRefusal(() => manifestFor(identity, { source }), /release manifest records/)
  })

  it('refuses a files[] entry the release manifest does not declare', () => {
    const identity = standardIdentity(101)
    const source = builderManifest(identity, {
      files: [{ url: 'DSH Desktop-0.2.2-rc.1-b101-ffffffffffff-arm64-mac.zip', sha512: DIGEST, size: 100 }],
    })
    expectRefusal(() => manifestFor(identity, { source }), /does not declare/)
  })

  it('refuses a blockmap listed as a downloadable artifact', () => {
    const identity = standardIdentity(101)
    const source = builderManifest(identity, {
      files: [{ url: `${macArtifacts(identity)[0] ?? ''}.blockmap`, sha512: DIGEST, size: 100 }],
    })
    expectRefusal(() => manifestFor(identity, { source }), /derived by the client/)
  })

  it('refuses a build whose naming and identity disagree', () => {
    // The manifest's names come from the identity's sequence and short
    // revision; a mismatch means the artifact in dist-app belongs to another
    // build, whatever its version says.
    const identity = standardIdentity(101)
    const artifacts = artifactsOf(expectedArtifacts(standardIdentity(101, { revision: OTHER_REVISION }), { mac: true, win: false }))
    const report = auditReleaseArtifacts(identity, releaseManifestOf(identity, artifacts), 'darwin', new Map())
    expect(report.undeclaredExpected.length).toBeGreaterThan(0)
    expect(isCleanArtifactReport(report)).toBe(false)
  })
})

describe('the local artifact audit', () => {
  const identity = standardIdentity(101)
  const declared = artifactsOf(expectedArtifacts(identity, { mac: true, win: false }))
  const good = new Map(declared.map(artifact => [artifact.fileName, { sha512: DIGEST, size: 100 }]))

  it('passes when every declared artifact matches its recorded digest', () => {
    const report = auditReleaseArtifacts(identity, releaseManifestOf(identity, declared), 'darwin', good)
    expect(isCleanArtifactReport(report)).toBe(true)
  })

  it('reports a file whose bytes carry another digest', () => {
    const files = new Map(good)
    const name = declared[0]?.fileName
    if (name === undefined) throw new Error('fixture: no declared artifact')
    files.set(name, { sha512: OTHER_DIGEST, size: 100 })
    const report = auditReleaseArtifacts(identity, releaseManifestOf(identity, declared), 'darwin', files)
    expect(report.mismatched.map(entry => entry.fileName)).toEqual([name])
    expect(isCleanArtifactReport(report)).toBe(false)
  })

  it('reports a missing file and a size mismatch', () => {
    const files = new Map(good)
    const missing = declared[0]?.fileName
    const wrongSize = declared[1]?.fileName
    if (missing === undefined || wrongSize === undefined) throw new Error('fixture: too few declared artifacts')
    files.delete(missing)
    files.set(wrongSize, { sha512: DIGEST, size: 99 })
    const report = auditReleaseArtifacts(identity, releaseManifestOf(identity, declared), 'darwin', files)
    expect(report.missing).toEqual([missing])
    expect(report.sizeMismatches.map(entry => entry.fileName)).toEqual([wrongSize])
  })
})

describe('a file name the feed already serves', () => {
  it('accepts identical bytes', () => {
    const identity = bridgeIdentity(100)
    const artifacts = artifactsOf(expectedArtifacts(identity, { mac: true, win: false }))
    const live = parseLiveFeed('v1', liveV1(BRIDGE_VERSION))
    expect(servedBytesMismatches(live, artifacts)).toEqual([])
  })

  it('refuses different bytes even when the served file was pruned away', () => {
    // The live manifest records what old clients may already have downloaded.
    // A missing file on the server must not let a different build reuse the
    // version-only bridge name.
    const identity = bridgeIdentity(100)
    const artifacts = artifactsOf(expectedArtifacts(identity, { mac: true, win: false }), { sha512: OTHER_DIGEST })
    const live = parseLiveFeed('v1', liveV1(BRIDGE_VERSION))
    const mismatches = servedBytesMismatches(live, artifacts)
    expect(mismatches.length).toBe(1)
    expect(mismatches.join('\n')).toMatch(/the feed records sha512/)
  })

  it('has nothing to compare on a first publish', () => {
    expect(servedBytesMismatches(undefined, [])).toEqual([])
  })
})

describe('readback from the served URL', () => {
  it('accepts exactly the manifest this publish wrote', () => {
    const manifest = manifestFor(standardIdentity(101), { minimumBuildSequence: 100 })
    const served = load(dump(manifest.document), { schema: CORE_SCHEMA })
    expect(verifyFeedReadback(manifest, served)).toEqual([])
  })

  it('refuses a feed that points at other bytes', () => {
    // Version alone is not confirmation: these are the failures a version
    // comparison would call a success.
    const manifest = manifestFor(standardIdentity(101))
    const served = structuredClone(manifest.document) as Record<string, unknown>
    const files = served.files
    if (!Array.isArray(files)) throw new Error('fixture: no files[]')
    const first: unknown = files[0]
    if (typeof first !== 'object' || first === null) throw new Error('fixture: no first entry')
    Reflect.set(first, 'sha512', OTHER_DIGEST)
    expect(verifyFeedReadback(manifest, served).join('\n')).toMatch(/sha512/)
  })

  it('refuses a v2 feed whose identity differs from the build', () => {
    const manifest = manifestFor(standardIdentity(101))
    const served = structuredClone(manifest.document) as Record<string, unknown>
    const metadata = served.dshRelease
    if (typeof metadata !== 'object' || metadata === null) throw new Error('fixture: no dshRelease')
    Reflect.set(metadata, 'buildSequence', 102)
    expect(verifyFeedReadback(manifest, served).join('\n')).toMatch(/dshRelease differs/)
  })

  it('refuses a missing or changed red line', () => {
    const manifest = manifestFor(standardIdentity(101), { minimumBuildSequence: 100 })
    const withoutLine = structuredClone(manifest.document) as Record<string, unknown>
    delete withoutLine.minimumBuildSequence
    expect(verifyFeedReadback(manifest, withoutLine).join('\n')).toMatch(/minimumBuildSequence is nothing/)

    const otherLine = structuredClone(manifest.document) as Record<string, unknown>
    otherLine.minimumBuildSequence = 99
    expect(verifyFeedReadback(manifest, otherLine).join('\n')).toMatch(/minimumBuildSequence is 99/)
  })

  it('refuses a v1 manifest that carries v2-only fields', () => {
    const identity = bridgeIdentity(100)
    const manifest = manifestFor(identity, { protocol: 'v1', minimumVersion: '0.2.2-rc.2' })
    const served = structuredClone(manifest.document) as Record<string, unknown>
    served.dshRelease = identity.dshRelease
    served.minimumBuildSequence = 90
    const mismatches = verifyFeedReadback(manifest, served).join('\n')
    expect(mismatches).toMatch(/must not carry dshRelease/)
    expect(mismatches).toMatch(/must not carry minimumBuildSequence/)
  })

  it('refuses an extra files[] entry this publish did not write', () => {
    const manifest = manifestFor(standardIdentity(101))
    const served = structuredClone(manifest.document) as Record<string, unknown>
    const files = served.files
    if (!Array.isArray(files)) throw new Error('fixture: no files[]')
    files.push({ url: 'DSH Desktop-0.2.2-rc.1-b101-ffffffffffff-arm64.dmg', sha512: DIGEST, size: 100 })
    expect(verifyFeedReadback(manifest, served).join('\n')).toMatch(/which this publish did not write/)
  })
})

describe('the prune protection set', () => {
  it('protects the blockmap a manifest never lists', () => {
    // An old client derives `<artifact>.blockmap` by substituting versions;
    // the file is not in files[] and a prune that only protected files[] would
    // take it away from the clients that still update.
    const bridgeFeed = parseLiveFeed('v1', liveV1(BRIDGE_VERSION))
    const target = manifestFor(standardIdentity(101))
    const protection = pruneProtectionFor({
      channel: mac(),
      targetFiles: target.files,
      targetArtifacts: macArtifacts(standardIdentity(101)),
      bridge: bridgeFeed,
      served: undefined,
    })
    const bridgeFile = bridgeFeed.files[0]?.url
    if (bridgeFile === undefined) throw new Error('fixture: no bridge file')
    expect(bridgeFile).toBe(`DSH Desktop-${BRIDGE_VERSION}-arm64-mac.zip`)
    expect(protection.names).toContain('latest-mac.yml')
    expect(protection.names).toContain(bridgeFile)
    expect(protection.names).toContain(`${bridgeFile}.blockmap`)
    for (const file of target.files) {
      expect(protection.names).toContain(file.url)
      expect(protection.names).toContain(`${file.url}.blockmap`)
    }
    expect(protection.prefixes).toContain(`DSH Desktop-${BRIDGE_VERSION}`)
  })

  it('keeps each protocol\u2019s names out of the other directory\u2019s set', () => {
    // The two directories hold different names. A set spanning both reports the
    // other directory's files as missing protections on every run, and that
    // warning is what is supposed to mean the set and the directory disagree.
    const bridgeFeed = parseLiveFeed('v1', liveV1(BRIDGE_VERSION))
    const served = parseLiveFeed('v2', liveV2(standardIdentity(101)))
    const target = manifestFor(standardIdentity(102))
    const inputs = {
      channel: mac(),
      targetFiles: target.files,
      targetArtifacts: macArtifacts(standardIdentity(102)),
      bridge: bridgeFeed,
      served,
    } as const
    const bridgeFile = bridgeFeed.files[0]?.url
    const servedFile = served.files[0]?.url
    if (bridgeFile === undefined || servedFile === undefined) throw new Error('fixture: no files')
    const v1 = pruneProtectionFor({ ...inputs, directory: 'v1' })
    const v2 = pruneProtectionFor({ ...inputs, directory: 'v2' })
    expect(v1.names).toContain(bridgeFile)
    expect(v1.names).not.toContain(servedFile)
    expect(v2.names).toContain(servedFile)
    expect(v2.names).not.toContain(bridgeFile)
    // Both still protect this publish's own artifacts: those live in whichever
    // directory the run writes.
    for (const directory of [v1, v2]) {
      for (const file of target.files) expect(directory.names).toContain(file.url)
    }
  })

  it('protects every build being served by its name prefix', () => {
    const served = parseLiveFeed('v2', liveV2(standardIdentity(101)))
    const target = manifestFor(standardIdentity(102))
    const protection = pruneProtectionFor({
      channel: mac(),
      targetFiles: target.files,
      targetArtifacts: macArtifacts(standardIdentity(102)),
      bridge: undefined,
      served,
    })
    const short = REVISION.slice(0, 12)
    expect(protection.prefixes.some(prefix => prefix.includes(`b101-${short}`))).toBe(true)
    expect(protection.prefixes.some(prefix => prefix.includes(`b102-${short}`))).toBe(true)
  })

  it('keeps the manifest even when no feed was read', () => {
    const protection = pruneProtectionFor({
      channel: win(),
      targetFiles: [],
      targetArtifacts: [],
      bridge: undefined,
      served: undefined,
    })
    expect(protection.names).toEqual(['latest.yml'])
  })
})
