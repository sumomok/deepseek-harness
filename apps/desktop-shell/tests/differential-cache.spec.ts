/**
 * The one artifact this shell keeps for a differential download, and what it
 * refuses.
 *
 * Everything here is real files under a per-case temporary directory: the record
 * format, the digest checks and the atomic replacement are the behaviour being
 * checked, and a stand-in filesystem would not answer what a torn write leaves
 * behind. The blockmap request is injected, so a case can answer one, refuse
 * one, or answer something that is not a blockmap without a socket.
 * @module
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  differentialCacheDir, prepareDifferentialBase, saveDifferentialBaseline, MAX_BLOCKMAP_BYTES,
  type PrepareDifferentialBaseInput, type SaveBaselineInput,
} from '../src/differential-cache.ts'
import type { ReleaseIdentity, UpdateOffer } from '../src/release-identity.ts'

/** The version every build here publishes under, so only the sequence tells them apart. */
const VERSION = '0.2.2-rc.1'

/** The running build's sequence. */
const RUNNING_BUILD = 101

/** The candidate's sequence. */
const NEXT_BUILD = 104

/** The source commit both builds name; only the identity's other fields differ. */
const REVISION = 'a'.repeat(40)

/** The artifact of the build that is running. */
const OLD_ARTIFACT = `DSH Desktop-${VERSION}-b101-aaaaaaaaaaaa-arm64-mac.zip`

/** The candidate's artifact. */
const NEXT_ARTIFACT = `DSH Desktop-${VERSION}-b104-aaaaaaaaaaaa-arm64-mac.zip`

/** One build's artifact bytes, which differ per build so a mix-up is detectable. */
const OLD_BYTES = Buffer.from('the installed artifact these cases difference against\n')

/** The candidate's bytes; nothing here downloads them. */
const NEXT_BYTES = Buffer.from('the candidate artifact\n')

/** Directories one case created, removed by the shared teardown. */
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * The updater cache directory this case owns.
 * @returns a fresh directory, removed by the shared teardown.
 */
function cacheDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-differential-'))
  directories.push(directory)
  return directory
}

/**
 * One build's complete identity.
 * @param build - its build sequence.
 * @returns a standard build of [[VERSION]].
 */
function build(buildSequence: number): ReleaseIdentity {
  return {
    version: VERSION,
    dshRelease: { schemaVersion: 2, runtimeVersion: VERSION, buildSequence, revision: REVISION, kind: 'standard' },
  }
}

/**
 * The base64 SHA-512 of some bytes.
 * @param bytes - the bytes to hash.
 * @returns the digest, as a manifest states it.
 */
function digest(bytes: Buffer): string {
  return createHash('sha512').update(bytes).digest('base64')
}

/**
 * The candidate a transfer would download.
 * @param art - the artifact name to publish.
 * @param bytes - the bytes behind it.
 * @returns the parsed offer.
 */
function offerFor(art: string, bytes: Buffer): UpdateOffer {
  return {
    identity: build(NEXT_BUILD),
    artifact: { fileName: art, sha512: digest(bytes), size: bytes.byteLength, isAdminRightsRequired: false },
    platform: 'darwin',
    arch: 'arm64',
  }
}

/**
 * Keep [[OLD_BYTES]] as the running build's baseline.
 * @param directory - the updater cache directory.
 * @param identity - the build the artifact installs; the running one by default.
 * @returns what the save reported.
 */
async function saveOld(directory: string, identity: ReleaseIdentity = build(RUNNING_BUILD)): Promise<void> {
  const source = join(directory, 'downloaded.zip')
  writeFileSync(source, OLD_BYTES)
  const result = await saveDifferentialBaseline({
    cacheDir: directory,
    platform: 'darwin',
    arch: 'arm64',
    identity,
    artifact: { fileName: OLD_ARTIFACT, sha512: digest(OLD_BYTES), size: OLD_BYTES.byteLength },
    sourceFile: source,
  })
  expect(result.kind).toBe('saved')
}

/**
 * The record as this case's directory holds it.
 * @param directory - the updater cache directory.
 * @returns the parsed record.
 */
function recordOf(directory: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(differentialCacheDir(directory), 'baseline.json'), 'utf8')) as Record<string, unknown>
}

/**
 * Write the record back, which is how these cases stand in for a blockmap that
 * a previous transfer already kept.
 * @param directory - the updater cache directory.
 * @param record - the record to write.
 */
function writeRecord(directory: string, record: Record<string, unknown>): void {
  writeFileSync(join(differentialCacheDir(directory), 'baseline.json'), JSON.stringify(record))
}

/**
 * Add a usable blockmap beside a saved baseline, as a transfer that fetched one
 * would have left it.
 * @param directory - the updater cache directory.
 * @returns the blockmap file's absolute path.
 */
function keepBlockmap(directory: string): string {
  const record = recordOf(directory)
  const key = record.key as string
  const bytes = gzipSync(JSON.stringify({ version: '2', files: [] }))
  const path = join(differentialCacheDir(directory), `${key}.blockmap`)
  writeFileSync(path, bytes)
  writeRecord(directory, { ...record, blockmap: { sha512: digest(bytes), size: bytes.byteLength } })
  return path
}

/**
 * Everything one preparation needs, with a fetch that fails the case if it is used.
 * @param directory - the updater cache directory.
 * @param running - the build running now.
 * @returns the input.
 */
function prepareInput(directory: string, running: ReleaseIdentity = build(RUNNING_BUILD)): PrepareDifferentialBaseInput {
  return {
    cacheDir: directory,
    running,
    offer: offerFor(NEXT_ARTIFACT, NEXT_BYTES),
    blockMapUrlFor: fileName => `https://feed.invalid/v2/mac/${fileName}.blockmap`,
    fetch: vi.fn(async () => { throw new Error('this case must not request a blockmap') }),
  }
}

describe('a kept baseline', () => {
  it('answers the pair only when the running build is the one recorded', async () => {
    const directory = cacheDir()
    await saveOld(directory)
    keepBlockmap(directory)

    const prepared = await prepareDifferentialBase(prepareInput(directory))

    expect(prepared.kind).toBe('prepared')
    if (prepared.kind !== 'prepared') return
    expect(prepared.base.oldFile).toBe(join(differentialCacheDir(directory), `${recordOf(directory).key as string}.artifact`))
    expect(readFileSync(prepared.base.oldFile)).toEqual(OLD_BYTES)
    expect(existsSync(prepared.base.oldBlockMapFile)).toBe(true)
  })

  it('refuses a baseline that belongs to another build of the same version', async () => {
    const directory = cacheDir()
    await saveOld(directory, build(RUNNING_BUILD - 1))
    keepBlockmap(directory)

    const prepared = await prepareDifferentialBase(prepareInput(directory))

    expect(prepared).toMatchObject({ kind: 'unavailable', reason: 'no-baseline' })
  })

  it('refuses when no artifact was ever kept', async () => {
    const prepared = await prepareDifferentialBase(prepareInput(cacheDir()))

    expect(prepared).toMatchObject({ kind: 'unavailable', reason: 'no-baseline' })
  })

  it('refuses an artifact whose bytes changed after it was recorded', async () => {
    const directory = cacheDir()
    await saveOld(directory)
    keepBlockmap(directory)
    const record = recordOf(directory)
    writeFileSync(join(differentialCacheDir(directory), `${record.key as string}.artifact`), 'tampered bytes\n')

    const prepared = await prepareDifferentialBase(prepareInput(directory))

    expect(prepared).toMatchObject({ kind: 'unavailable', reason: 'baseline-invalid' })
  })

  it('refuses a record that names a key other than the one its fields derive', async () => {
    const directory = cacheDir()
    await saveOld(directory)
    keepBlockmap(directory)
    writeRecord(directory, { ...recordOf(directory), key: 'b'.repeat(32) })

    const prepared = await prepareDifferentialBase(prepareInput(directory))

    expect(prepared).toMatchObject({ kind: 'unavailable', reason: 'no-baseline' })
  })

  it('refuses a record naming a file this shell would never publish', async () => {
    const directory = cacheDir()
    await saveOld(directory)
    const record = recordOf(directory)
    writeRecord(directory, { ...record, artifact: { ...record.artifact as object, fileName: '../../escape.zip' } })

    const prepared = await prepareDifferentialBase(prepareInput(directory))

    expect(prepared).toMatchObject({ kind: 'unavailable', reason: 'no-baseline' })
  })

  it('refuses a baseline kept for another platform or architecture', async () => {
    const directory = cacheDir()
    await saveOld(directory)
    keepBlockmap(directory)
    const input = prepareInput(directory)
    const prepared = await prepareDifferentialBase({
      ...input,
      offer: { ...input.offer, arch: 'x64' },
    })

    expect(prepared).toMatchObject({ kind: 'unavailable', reason: 'no-baseline' })
  })
})

describe('the blockmap a baseline needs', () => {
  it('fetches the installed build’s own blockmap and keeps it for the next transfer', async () => {
    const directory = cacheDir()
    await saveOld(directory)
    const bytes = gzipSync(JSON.stringify({ version: '2', files: [] }))
    const urls: string[] = []
    const fetch = vi.fn(async (url: string | URL | Request) => {
      urls.push(url instanceof URL ? url.href : typeof url === 'string' ? url : url.url)
      return new Response(bytes, { status: 200 })
    })
    const input = prepareInput(directory)

    const first = await prepareDifferentialBase({ ...input, fetch })
    const second = await prepareDifferentialBase({ ...input, fetch })

    expect(first.kind).toBe('prepared')
    expect(second.kind).toBe('prepared')
    expect(urls).toEqual([`https://feed.invalid/v2/mac/${OLD_ARTIFACT}.blockmap`])
    expect(recordOf(directory).blockmap).toMatchObject({ sha512: digest(bytes), size: bytes.byteLength })
  })

  it('refuses when the feed has no blockmap for the installed build', async () => {
    const directory = cacheDir()
    await saveOld(directory)

    const prepared = await prepareDifferentialBase({
      ...prepareInput(directory),
      fetch: vi.fn(async () => new Response('missing', { status: 404 })),
    })

    expect(prepared).toMatchObject({ kind: 'unavailable', reason: 'blockmap-unavailable' })
  })

  it('refuses an answer that is not a gzipped blockmap', async () => {
    const directory = cacheDir()
    await saveOld(directory)

    const prepared = await prepareDifferentialBase({
      ...prepareInput(directory),
      fetch: vi.fn(async () => new Response('<html>not a blockmap</html>', { status: 200 })),
    })

    expect(prepared).toMatchObject({ kind: 'unavailable', reason: 'blockmap-unavailable' })
  })

  it('refuses an answer larger than the limit', async () => {
    const directory = cacheDir()
    await saveOld(directory)

    const prepared = await prepareDifferentialBase({
      ...prepareInput(directory),
      fetch: vi.fn(async () => new Response(new Uint8Array(MAX_BLOCKMAP_BYTES + 1), {
        status: 200,
        headers: { 'content-length': String(MAX_BLOCKMAP_BYTES + 1) },
      })),
    })

    expect(prepared).toMatchObject({ kind: 'unavailable', reason: 'blockmap-unavailable' })
  })

  it('fetches again when the kept blockmap no longer matches its record', async () => {
    const directory = cacheDir()
    await saveOld(directory)
    const path = keepBlockmap(directory)
    rmSync(path)
    const fetch = vi.fn(async () => new Response(gzipSync(JSON.stringify({ version: '2', files: [] })), { status: 200 }))

    const prepared = await prepareDifferentialBase({
      ...prepareInput(directory),
      fetch,
    })

    expect(prepared.kind).toBe('prepared')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('saving a baseline', () => {
  it('refuses a source file that does not match the published digest', async () => {
    const directory = cacheDir()
    const source = join(directory, 'downloaded.zip')
    writeFileSync(source, 'not the artifact\n')

    const saved = await saveDifferentialBaseline(saveInput(directory, source))

    expect(saved).toMatchObject({ kind: 'failed' })
    expect(readdirSync(differentialCacheDir(directory))).toEqual([])
  })

  it('replaces the previous artifact instead of keeping both', async () => {
    const directory = cacheDir()
    await saveOld(directory, build(RUNNING_BUILD - 1))
    const first = recordOf(directory).key as string

    await saveOld(directory, build(RUNNING_BUILD))

    const entries = readdirSync(differentialCacheDir(directory))
    expect(entries).toContain('baseline.json')
    expect(entries.some(entry => entry.startsWith(`${first}.`))).toBe(false)
    expect(entries.filter(entry => entry.endsWith('.artifact')).length).toBe(1)
  })

  it('does not copy the same artifact twice', async () => {
    const directory = cacheDir()
    await saveOld(directory)
    const artifact = join(differentialCacheDir(directory), `${recordOf(directory).key as string}.artifact`)
    const written = statSync(artifact).mtimeMs
    const record = recordOf(directory)

    await saveOld(directory)

    expect(statSync(artifact).mtimeMs).toBe(written)
    expect(recordOf(directory)).toEqual(record)
  })
})

/**
 * The input one save uses for [[OLD_BYTES]].
 * @param directory - the updater cache directory.
 * @param source - the file to keep.
 * @returns the save input.
 */
function saveInput(directory: string, source: string): SaveBaselineInput {
  mkdirSync(differentialCacheDir(directory), { recursive: true })
  return {
    cacheDir: directory,
    platform: 'darwin',
    arch: 'arm64',
    identity: build(RUNNING_BUILD),
    artifact: { fileName: OLD_ARTIFACT, sha512: digest(OLD_BYTES), size: OLD_BYTES.byteLength },
    sourceFile: source,
  }
}
