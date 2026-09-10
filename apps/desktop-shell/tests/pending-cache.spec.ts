/**
 * The handoff to electron-updater, checked against electron-updater's own
 * reader: a file this shell staged is accepted by the same
 * `DownloadedUpdateHelper.validateDownloadedPath` that `downloadUpdate()` calls
 * before it opens a socket, loaded from `node_modules` so what is checked is
 * the code the packaged app runs.
 * @module
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UpdateInfo } from 'electron-updater'
import { DownloadedUpdateHelper } from 'electron-updater/out/DownloadedUpdateHelper.js'
import { afterEach, describe, expect, it } from 'vitest'
import { appCacheDir, discardStaleParts, partFileFor, pendingDir, placeInPendingCache } from '../src/pending-cache.ts'

/** The artifact every case stages. */
const ARTIFACT = randomBytes(4_096)

/** The manifest's base64 sha512 for [[ARTIFACT]]. */
const SHA512 = createHash('sha512').update(ARTIFACT).digest('base64')

/** The artifact's name in the feed, spaces and all, as electron-builder writes it. */
const FILE_NAME = 'DSH Desktop-0.1.0-rc.33-arm64-mac.zip'

/** The version being staged. */
const VERSION = '0.1.0-rc.33'

/** A logger that answers electron-updater's four channels and keeps nothing. */
const QUIET = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

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
 * @param isAdminRightsRequired - what the manifest says about elevation.
 * @returns the path the artifact now occupies.
 */
function stage(cacheDir: string, isAdminRightsRequired = false): string {
  const part = partFileFor(cacheDir, VERSION, FILE_NAME)
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
    // info's sha512 — so the version is all a case has to state, and the rest of
    // `UpdateInfo` is two deprecated fields it would otherwise have to name.
    { version: VERSION } as unknown as UpdateInfo,
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
    stage(cacheDir, true)
    const record = JSON.parse(readFileSync(join(pendingDir(cacheDir), 'update-info.json'), 'utf8')) as unknown
    expect(record).toEqual({ fileName: FILE_NAME, sha512: SHA512, isAdminRightsRequired: true })
  })

  it('leaves no partial file behind', () => {
    const cacheDir = cacheDirectory()
    stage(cacheDir)
    expect(existsSync(partFileFor(cacheDir, VERSION, FILE_NAME))).toBe(false)
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
  it('are keyed by version and artifact name, and live outside `pending`', () => {
    const part = partFileFor('/cache/app', VERSION, FILE_NAME)
    expect(part).toBe(join('/cache/app', `dsh-resume-${VERSION}-${FILE_NAME}.part`))
    expect(part.includes(join('/cache/app', 'pending'))).toBe(false)
  })

  it('name the artifact by its basename, so a manifest path cannot escape the directory', () => {
    expect(partFileFor('/cache/app', VERSION, '../../etc/evil.zip'))
      .toBe(join('/cache/app', `dsh-resume-${VERSION}-evil.zip.part`))
  })

  it('are dropped once the feed has moved on, and the current one is not', () => {
    const cacheDir = cacheDirectory()
    const stale = partFileFor(cacheDir, '0.1.0-rc.30', FILE_NAME)
    const current = partFileFor(cacheDir, VERSION, FILE_NAME)
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
    expect(() => { discardStaleParts(cacheDir, partFileFor(cacheDir, VERSION, FILE_NAME)) }).not.toThrow()
  })
})
