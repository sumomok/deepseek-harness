/**
 * The handoff to electron-updater, checked against electron-updater's own
 * reader: a file this shell staged is accepted by the same
 * `DownloadedUpdateHelper.validateDownloadedPath` that `downloadUpdate()` calls
 * before it opens a socket, loaded from `node_modules` so what is checked is
 * the code the packaged app runs. The second half covers the sweep after an
 * install: which running build confirms one, and what `pending` is allowed to
 * lose.
 * @module
 */

import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UpdateInfo } from 'electron-updater'
import { DownloadedUpdateHelper } from 'electron-updater/out/DownloadedUpdateHelper.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { InstallReceipt } from '../src/desktop-state.ts'
import {
  appCacheDir, discardStaleParts, partFileFor, pendingDir, placeInPendingCache, readStagedArtifact, sweepInstalledBuildPending,
} from '../src/pending-cache.ts'
import { releaseKey, type ReleaseIdentity } from '../src/release-identity.ts'

/** The artifact every case stages. */
const ARTIFACT = randomBytes(4_096)

/** The manifest's base64 sha512 for [[ARTIFACT]]. */
const SHA512 = createHash('sha512').update(ARTIFACT).digest('base64')

/** The artifact's name in the feed, spaces and all, as electron-builder writes it. */
const FILE_NAME = 'DSH Desktop-0.1.0-rc.33-arm64-mac.zip'

/** The version every build in this file publishes under, so only the identity tells them apart. */
const VERSION = '0.1.0-rc.33'

/** A source commit identity for builds that must differ without a version change. */
const REVISION = '0123456789abcdef0123456789abcdef01234567'

/** A logger that answers electron-updater's four channels and keeps nothing. */
const QUIET = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * One build's complete identity.
 * @param sequence - build sequence; the only field that has to differ.
 * @returns the identity of a standard build of [[VERSION]].
 */
function build(sequence: number): ReleaseIdentity {
  return {
    version: VERSION,
    dshRelease: { schemaVersion: 2, runtimeVersion: VERSION, buildSequence: sequence, revision: REVISION, kind: 'standard' },
  }
}

/**
 * A cache directory this case may write into.
 * @returns the directory, removed by the shared teardown.
 */
function cacheDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-updater-cache-'))
  directories.push(directory)
  return directory
}

/**
 * Stage [[ARTIFACT]] the way a finished resumable transfer does.
 * @param cacheDir - the cache directory to stage into.
 * @param identity - the build being staged.
 * @param isAdminRightsRequired - what the manifest says about elevation.
 * @returns the path the artifact now occupies.
 */
function stage(cacheDir: string, identity: ReleaseIdentity = build(101), isAdminRightsRequired = false): string {
  const part = partFileFor(cacheDir, identity, FILE_NAME)
  writeFileSync(part, ARTIFACT)
  return placeInPendingCache({ cacheDir, sourceFile: part, fileName: FILE_NAME, sha512: SHA512, isAdminRightsRequired })
}

/**
 * Ask electron-updater whether it would install what this shell staged.
 * @param cacheDir - the cache directory that was staged into.
 * @param sha512 - the sha512 the manifest publishes at the moment of the check.
 * @returns the path electron-updater would take the update from, or null.
 */
async function validate(cacheDir: string, sha512 = SHA512): Promise<string | null> {
  const helper = new DownloadedUpdateHelper(cacheDir)
  const updateFile = join(pendingDir(cacheDir), FILE_NAME)
  return helper.validateDownloadedPath(
    updateFile,
    // The cache check reads nothing off this argument — it compares the file
    // info's sha512 — so only the version carries anything; the other fields
    // are there because `UpdateInfo` requires them, deprecated or not.
    // oxlint-disable-next-line typescript/no-deprecated -- required by the type, never read by the cache check
    { version: VERSION, files: [], path: FILE_NAME, sha512, releaseDate: '' } satisfies UpdateInfo,
    { info: { url: FILE_NAME, sha512 }, url: new URL(`https://example.invalid/mac/${encodeURI(FILE_NAME)}`) },
    QUIET,
  )
}

describe('the cache directory', () => {
  it('is the one electron-updater derives on each platform', () => {
    expect(appCacheDir('darwin', {})).toBe(join(process.env.HOME ?? '', 'Library', 'Caches'))
    expect(appCacheDir('win32', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })).toBe('C:\\Users\\x\\AppData\\Local')
    expect(appCacheDir('linux', { XDG_CACHE_HOME: '/x/cache' })).toBe('/x/cache')
  })

  it('puts a staged update under `pending`', () => {
    expect(pendingDir('/cache/app')).toBe(join('/cache/app', 'pending'))
  })
})

describe('a staged artifact', () => {
  it('is what electron-updater takes the update from', async () => {
    const cacheDir = cacheDirectory()
    const staged = stage(cacheDir)
    expect(staged).toBe(join(pendingDir(cacheDir), FILE_NAME))
    expect(await validate(cacheDir)).toBe(staged)
  })

  it('is recorded with exactly the three fields electron-updater writes', () => {
    const cacheDir = cacheDirectory()
    stage(cacheDir, build(101), true)
    const record: unknown = JSON.parse(readFileSync(join(pendingDir(cacheDir), 'update-info.json'), 'utf8'))
    expect(record).toEqual({ fileName: FILE_NAME, sha512: SHA512, isAdminRightsRequired: true })
  })

  it('leaves no partial file behind', () => {
    const cacheDir = cacheDirectory()
    const identity = build(101)
    stage(cacheDir, identity)
    expect(existsSync(partFileFor(cacheDir, identity, FILE_NAME))).toBe(false)
  })

  it('is rejected once the feed publishes a different artifact', async () => {
    const cacheDir = cacheDirectory()
    stage(cacheDir)
    expect(await validate(cacheDir, createHash('sha512').update('other').digest('base64'))).toBeNull()
  })

  it('is rejected when the bytes on disk are not the ones it was recorded as', async () => {
    const cacheDir = cacheDirectory()
    const staged = stage(cacheDir)
    writeFileSync(staged, randomBytes(4_096))
    expect(await validate(cacheDir)).toBeNull()
  })
})

describe('partial files', () => {
  it('are keyed by the whole build identity and artifact name, and live outside `pending`', () => {
    const identity = build(101)
    const part = partFileFor('/cache/app', identity, FILE_NAME)
    const key = createHash('sha256').update(releaseKey(identity)).digest('hex').substring(0, 16)
    expect(part).toBe(join('/cache/app', `dsh-resume-${key}-${FILE_NAME}.part`))
    expect(part.includes(join('/cache/app', 'pending'))).toBe(false)
  })

  it('tell two builds of one version apart, because only the identity orders them', () => {
    // A fix shipped as the next build of the same upstream version, and a
    // bridge build that lowers the application version, both publish under a
    // version the other build also carries. A version-keyed file would let
    // one transfer resume into the other build's bytes and would discard the
    // partial file of the candidate this operation still holds.
    const first = partFileFor('/cache/app', build(101), FILE_NAME)
    const second = partFileFor('/cache/app', build(102), FILE_NAME)
    expect(first).not.toBe(second)
    expect(partFileFor('/cache/app', build(101), FILE_NAME)).toBe(first)
  })

  it('reject malicious file names with path separators', () => {
    expect(() => partFileFor('/cache/app', build(101), '../../etc/evil.zip')).toThrow('更新源的文件名不能包含路径分隔符')
    expect(() => partFileFor('/cache/app', build(101), '/etc/passwd')).toThrow('更新源的文件名不能包含路径分隔符')
    expect(() => partFileFor('/cache/app', build(101), 'C:\\Windows\\evil.zip')).toThrow('更新源的文件名不能包含路径分隔符')
  })

  it('are dropped once the feed has moved on, and the current one is not', () => {
    const cacheDir = cacheDirectory()
    const stale = partFileFor(cacheDir, build(100), FILE_NAME)
    const current = partFileFor(cacheDir, build(101), FILE_NAME)
    writeFileSync(stale, 'old')
    writeFileSync(`${stale}.origin.json`, '{}')
    writeFileSync(current, 'new')
    writeFileSync(`${current}.origin.json`, '{}')
    writeFileSync(join(cacheDir, 'update.zip'), 'the differential baseline')
    discardStaleParts(cacheDir, current)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(`${stale}.origin.json`)).toBe(false)
    expect(existsSync(current)).toBe(true)
    expect(existsSync(`${current}.origin.json`)).toBe(true)
    // The differential baselines electron-updater keeps in the same directory
    // are not this shell's to remove.
    expect(existsSync(join(cacheDir, 'update.zip'))).toBe(true)
  })

  it('are nothing to sweep in a cache directory that does not exist yet', () => {
    const cacheDir = join(cacheDirectory(), 'never-created')
    expect(() => { discardStaleParts(cacheDir, partFileFor(cacheDir, build(101), FILE_NAME)) }).not.toThrow()
  })
})

/** The build that started the install every sweep case describes. */
const FROM = build(100)

/** The build the staged artifact installs. */
const TARGET = build(101)

/** The differential baselines electron-updater keeps in the cache directory root. */
const BASELINES = ['update.zip', 'installer.exe', 'package.7z', 'current.blockmap']

/**
 * Stage [[ARTIFACT]] beside the root baselines, as a cache directory looks
 * right after the install click.
 * @param cacheDir - the cache directory to fill.
 * @returns the receipt that install wrote.
 */
function installed(cacheDir: string): InstallReceipt {
  stage(cacheDir, TARGET)
  for (const baseline of BASELINES) writeFileSync(join(cacheDir, baseline), baseline)
  return { schemaVersion: 2, from: FROM, target: TARGET, fileName: FILE_NAME, sha512: SHA512 }
}

describe('the staged record', () => {
  it('names the artifact `pending` holds', () => {
    const cacheDir = cacheDirectory()
    stage(cacheDir)
    expect(readStagedArtifact(cacheDir)).toEqual({ fileName: FILE_NAME, sha512: SHA512 })
  })

  it('is absent when there is no record or it lacks a field', () => {
    const cacheDir = cacheDirectory()
    expect(readStagedArtifact(cacheDir)).toBeUndefined()
    mkdirSync(pendingDir(cacheDir), { recursive: true })
    writeFileSync(join(pendingDir(cacheDir), 'update-info.json'), JSON.stringify({ fileName: FILE_NAME }))
    expect(readStagedArtifact(cacheDir)).toBeUndefined()
    writeFileSync(join(pendingDir(cacheDir), 'update-info.json'), 'not json')
    expect(readStagedArtifact(cacheDir)).toBeUndefined()
  })
})

describe('the sweep after an install', () => {
  it('empties `pending` once the build the receipt names runs, and leaves every root baseline', async () => {
    const cacheDir = cacheDirectory()
    const receipt = installed(cacheDir)
    writeFileSync(join(pendingDir(cacheDir), 'current.blockmap'), 'copied up by the library')

    const sweep = sweepInstalledBuildPending(cacheDir, receipt, TARGET)

    expect(sweep).toEqual({ kind: 'emptied', removed: ['current.blockmap', FILE_NAME, 'update-info.json'].sort(sortRecordLast) })
    expect(readdirSync(pendingDir(cacheDir))).toEqual([])
    for (const baseline of BASELINES) expect(readFileSync(join(cacheDir, baseline), 'utf8')).toBe(baseline)
    // What electron-updater would now take the update from: nothing.
    expect(await validate(cacheDir)).toBeNull()
  })

  it('leaves `pending` alone while the build that started the install still runs', async () => {
    const cacheDir = cacheDirectory()
    const receipt = installed(cacheDir)
    expect(sweepInstalledBuildPending(cacheDir, receipt, FROM)).toEqual({ kind: 'not-landed' })
    expect(await validate(cacheDir)).toBe(join(pendingDir(cacheDir), FILE_NAME))
  })

  it('confirms a build that only a sequence and revision distinguish from the one that started the install', () => {
    // Same application version, different build: version order cannot answer
    // this, which is why the sweep compares identities.
    const cacheDir = cacheDirectory()
    const receipt = installed(cacheDir)
    expect(sweepInstalledBuildPending(cacheDir, receipt, TARGET)).toEqual({ kind: 'emptied', removed: [FILE_NAME, 'update-info.json'] })
  })

  it('sweeps nothing when a build equal to neither identity runs, and claims no success', async () => {
    const cacheDir = cacheDirectory()
    const receipt = installed(cacheDir)
    const later = build(102)
    expect(sweepInstalledBuildPending(cacheDir, receipt, later)).toEqual({ kind: 'unconfirmed' })
    expect(await validate(cacheDir)).toBe(join(pendingDir(cacheDir), FILE_NAME))
    // The same version under another sequence is another build, not target.
    const rebuilt = { ...TARGET, dshRelease: { ...TARGET.dshRelease, revision: 'fedcba9876543210fedcba9876543210fedcba98' } }
    expect(sweepInstalledBuildPending(cacheDir, receipt, rebuilt)).toEqual({ kind: 'unconfirmed' })
    expect(await validate(cacheDir)).toBe(join(pendingDir(cacheDir), FILE_NAME))
  })

  it('keeps a later download that replaced the installed artifact', async () => {
    const cacheDir = cacheDirectory()
    const receipt = installed(cacheDir)
    expect(sweepInstalledBuildPending(cacheDir, { ...receipt, sha512: createHash('sha512').update('the one before').digest('base64') }, TARGET))
      .toEqual({ kind: 'replaced' })
    expect(await validate(cacheDir)).toBe(join(pendingDir(cacheDir), FILE_NAME))
    expect(sweepInstalledBuildPending(cacheDir, { ...receipt, fileName: 'DSH Desktop-0.1.0-rc.32-arm64-mac.zip' }, TARGET))
      .toEqual({ kind: 'replaced' })
    expect(await validate(cacheDir)).toBe(join(pendingDir(cacheDir), FILE_NAME))
  })

  it('finds nothing to do when `pending` holds no record', () => {
    const cacheDir = cacheDirectory()
    const receipt: InstallReceipt = { schemaVersion: 2, from: FROM, target: TARGET, fileName: FILE_NAME, sha512: SHA512 }
    expect(sweepInstalledBuildPending(cacheDir, receipt, TARGET)).toEqual({ kind: 'absent' })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'names what it could not remove and keeps the record, so the next launch sweeps again',
    () => {
      const cacheDir = cacheDirectory()
      const receipt = installed(cacheDir)
      const held = join(pendingDir(cacheDir), 'held')
      mkdirSync(held)
      writeFileSync(join(held, 'inner'), 'x')
      // A directory whose entries cannot be unlinked stands in for the
      // installer file Windows keeps open for a moment after the relaunch.
      chmodSync(held, 0o500)
      try {
        const sweep = sweepInstalledBuildPending(cacheDir, receipt, TARGET)
        expect(sweep).toEqual({ kind: 'incomplete', removed: [FILE_NAME], failed: ['held', 'update-info.json'] })
        expect(readStagedArtifact(cacheDir)).toEqual({ fileName: FILE_NAME, sha512: SHA512 })
      } finally {
        chmodSync(held, 0o700)
      }
      expect(sweepInstalledBuildPending(cacheDir, receipt, TARGET)).toEqual({ kind: 'emptied', removed: ['held', 'update-info.json'] })
    },
  )
})

/** The order the sweep removes entries in: directory order, with the record last. */
function sortRecordLast(left: string, right: string): number {
  return Number(left === 'update-info.json') - Number(right === 'update-info.json') || (left < right ? -1 : left > right ? 1 : 0)
}
