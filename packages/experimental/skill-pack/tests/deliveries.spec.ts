/**
 * The delivery directory: which archive it names, what installing that archive
 * reports and records, and what it leaves the pack root as when it names none,
 * names two, names one this deployment will not read or will not draw, or
 * names one while the pack root or the archive cannot be read; how a refusal
 * record names the pack root and the delivery directory; and which record the
 * status route keeps as reads follow one another.
 */

import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPackArchive, PACK_ARCHIVE_FORMAT, PACK_ARCHIVE_MANIFEST } from '../src/archive.ts'
import { installDelivery, keepDelivery, type DeliveryDirectory } from '../src/deliveries.ts'
import type { VerifyStagedPacks } from '../src/install.ts'
import type { DeliveredPack, DeliveryRecord } from '../src/types.ts'

const LIMITS = { maxArchiveBytes: 1_000_000, maxFileBytes: 100_000, maxFiles: 50 }

const SET = { id: 'space-console', version: '2026.9.19' }

/** Every directory a case made, removed after it, however many deployments the case set up. */
const worlds: string[] = []

afterEach(async () => {
  for (const world of worlds.splice(0)) await rm(world, { recursive: true, force: true })
})

/** A pack root, a delivery directory beside it, the directory both are in, and the lines one read reported. */
interface Deployment {
  readonly world: string
  readonly root: string
  readonly delivery: DeliveryDirectory
  readonly reported: string[]
  read(verify?: VerifyStagedPacks): Promise<DeliveryRecord | undefined>
}

/** How one case's deployment is configured. */
interface DeploymentOptions {
  readonly limits?: typeof LIMITS
  /** Whether the delivery directory exists before the first read. */
  readonly create?: boolean
  /** The delivery directory's name beside the pack root `packs`. */
  readonly deliveries?: string
  /** Configure both directories through a symbolic link to the directory they are in, so neither path is its real path. */
  readonly linked?: boolean
}

async function deployment({ limits = LIMITS, create = true, deliveries = 'deliveries', linked = false }: DeploymentOptions = {}): Promise<Deployment> {
  const world = await mkdtemp(join(tmpdir(), 'dsh-skill-pack-deliveries-'))
  worlds.push(world)
  let base = world
  if (linked) {
    base = join(world, 'via')
    await symlink(world, base, 'junction')
  }
  const root = join(base, 'packs')
  const directory = join(base, deliveries)
  if (create) await mkdir(directory, { recursive: true })
  const reported: string[] = []
  const delivery = { directory, limits }
  return {
    world,
    root,
    delivery,
    reported,
    read: verify => installDelivery(root, delivery, (level, text) => { reported.push(`${level} ${text}`) }, verify),
  }
}

function pack(name: string, body: string): DeliveredPack {
  return {
    name,
    files: [{
      path: 'SKILL.md',
      content: `---\nname: ${name}\ndescription: d\nmetadata:\n  pack:\n    version: 1.0.0\n---\n${body}`,
    }],
  }
}

/** Copy one archive into the delivery directory under the given name. */
async function drop(delivery: DeliveryDirectory, name: string, packs: DeliveredPack[], set = SET): Promise<void> {
  await writeFile(join(delivery.directory, name), await buildPackArchive({ kind: 'packs', packs }, set))
}

/**
 * Read once and hold the record's time to the moment of the read.
 * @returns the record, with its time checked and then replaced by `'<at>'` so a case compares the rest whole.
 */
async function readAt(one: Deployment, verify?: VerifyStagedPacks): Promise<unknown> {
  const before = Date.now()
  const record = await one.read(verify)
  const after = Date.now()
  if (record === undefined) return undefined
  expect(new Date(record.at).toISOString()).toBe(record.at)
  expect(Date.parse(record.at)).toBeGreaterThanOrEqual(before)
  expect(Date.parse(record.at)).toBeLessThanOrEqual(after)
  return { ...record, at: '<at>' }
}

/** The line one read reported, without the level it was reported at. */
function lineOf(reported: readonly string[]): string {
  expect(reported).toHaveLength(1)
  return reported[0]!.replace(/^(?:info|error) /, '')
}

describe('reading the delivery directory', () => {
  it('says nothing about a directory that does not exist, and nothing about an empty one', async () => {
    const absent = await deployment({ create: false })
    expect(await absent.read()).toBeUndefined()
    expect(absent.reported).toEqual([])

    const empty = await deployment()
    expect(await empty.read()).toBeUndefined()
    expect(empty.reported).toEqual([])
    await expect(readdir(empty.root)).rejects.toThrow()
  })

  it('installs the one archive it names, and says what the deployment now holds', async () => {
    const one = await deployment()
    await drop(one.delivery, 'set.dshpack', [pack('a', 'A.'), pack('b', 'B.')])
    expect(await readAt(one)).toEqual({ result: 'installed', archives: ['set.dshpack'], set: SET, at: '<at>' })
    expect(one.reported).toEqual([
      'info skill-pack: installed space-console 2026.9.19 from set.dshpack: packs [a, b], retired []',
    ])
    expect(await readdir(one.root)).toEqual(['a', 'b'])
  })

  it('says nothing the second time, and records it unchanged, because the root already holds what the archive carries', async () => {
    const one = await deployment()
    await drop(one.delivery, 'set.dshpack', [pack('a', 'A.')])
    expect((await one.read())?.result).toBe('installed')
    one.reported.length = 0
    expect(await readAt(one)).toEqual({ result: 'unchanged', archives: ['set.dshpack'], set: SET, at: '<at>' })
    expect(one.reported).toEqual([])
  })

  it('records an archive carrying what the root already holds as unchanged, under its own name and set', async () => {
    const one = await deployment()
    await drop(one.delivery, 'v1.dshpack', [pack('a', 'A.')])
    expect((await one.read())?.result).toBe('installed')
    await rm(join(one.delivery.directory, 'v1.dshpack'))
    const again = { id: 'space-console', version: '2026.9.20' }
    await drop(one.delivery, 'v1-again.dshpack', [pack('a', 'A.')], again)
    one.reported.length = 0

    expect(await readAt(one)).toEqual({ result: 'unchanged', archives: ['v1-again.dshpack'], set: again, at: '<at>' })
    expect(one.reported).toEqual([])
    expect(await readdir(one.root)).toEqual(['a'])
  })

  it('installs nothing while the directory names two deliveries', async () => {
    const two = await deployment()
    await drop(two.delivery, 'v1.dshpack', [pack('a', 'A.')])
    expect((await two.read())?.result).toBe('installed')
    await drop(two.delivery, 'v2.dshpack', [pack('b', 'B.')])
    two.reported.length = 0

    expect(await readAt(two)).toEqual({
      result: 'refused',
      archives: ['v1.dshpack', 'v2.dshpack'],
      reason: 'skill-pack: the delivery directory holds 2 archives (v1.dshpack, v2.dshpack); it names one delivery at a time',
      at: '<at>',
    })
    expect(two.reported).toEqual([
      'error skill-pack: the delivery directory holds 2 archives (v1.dshpack, v2.dshpack); it names one delivery at a time',
    ])
    expect(await readdir(two.root)).toEqual(['a'])
  })

  it('refuses an archive larger than the size it reads one under, without reading it', async () => {
    const small = await deployment({ limits: { ...LIMITS, maxArchiveBytes: 64 } })
    await drop(small.delivery, 'set.dshpack', [pack('a', 'A.')])
    const record = await readAt(small)
    expect(small.reported).toEqual([
      expect.stringContaining('error skill-pack: refused set.dshpack — is '),
    ])
    expect(small.reported[0]).toContain('over the 64 it is read under')
    // Nothing of the archive was read, so it names no set.
    expect(record).toEqual({ result: 'refused', archives: ['set.dshpack'], reason: lineOf(small.reported), at: '<at>' })
    await expect(readdir(small.root)).rejects.toThrow()
  })

  it('names the archive it could not install, and leaves the root as it was', async () => {
    const one = await deployment()
    await drop(one.delivery, 'v1.dshpack', [pack('a', 'A.')])
    expect((await one.read())?.result).toBe('installed')
    await rm(join(one.delivery.directory, 'v1.dshpack'))
    one.reported.length = 0

    await writeFile(join(one.delivery.directory, 'v2.dshpack'), Buffer.from(zipSync({
      [PACK_ARCHIVE_MANIFEST]: Buffer.from(JSON.stringify({
        format: PACK_ARCHIVE_FORMAT,
        set: SET,
        files: [{ path: 'b/SKILL.md', sha256: createHash('sha256').update('signed').digest('hex') }],
      })),
      'packs/b/SKILL.md': Buffer.from('edited between the console and the box'),
    })))
    const record = await readAt(one)
    expect(one.reported[0]).toContain('error skill-pack: v2.dshpack was not installed: PackInstallError')
    // A manifest the archive does not verify against states no set worth naming.
    expect(record).toEqual({ result: 'refused', archives: ['v2.dshpack'], reason: lineOf(one.reported), at: '<at>' })
    expect(await readdir(one.root)).toEqual(['a'])
  })

  // Mode 000 denies a directory read only to a non-root owner on POSIX:
  // Windows has no directory permission bits for readdir, and root bypasses
  // them, so there the pack root stays readable and the archive installs.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('names the archive it could not install into a pack root it cannot read, and leaves the root as it was', async () => {
    const one = await deployment()
    await drop(one.delivery, 'v1.dshpack', [pack('a', 'A.')])
    expect((await one.read())?.result).toBe('installed')
    await rm(join(one.delivery.directory, 'v1.dshpack'))
    await drop(one.delivery, 'v2.dshpack', [pack('b', 'B.')])
    one.reported.length = 0

    await chmod(one.root, 0o000)
    let record: unknown
    try {
      record = await readAt(one)
    } finally {
      await chmod(one.root, 0o755)
    }
    // The log names the pack root by its path; the record names it by placeholder.
    expect(lineOf(one.reported)).toBe(`skill-pack: v2.dshpack was not installed: Error: EACCES: permission denied, scandir '${one.root}'`)
    // The archive verified before the root was read, so the refusal names its set.
    expect(record).toEqual({
      result: 'refused',
      archives: ['v2.dshpack'],
      set: SET,
      reason: 'skill-pack: v2.dshpack was not installed: Error: EACCES: permission denied, scandir \'<pack root>\'',
      at: '<at>',
    })
    expect(JSON.stringify(record)).not.toContain(one.world)
    expect(await readdir(one.root)).toEqual(['a'])
    expect(await readFile(join(one.root, 'a', 'SKILL.md'), 'utf8')).toContain('A.')
  })

  // Mode 000 denies a file read to a non-root owner on POSIX; Windows has no
  // such permission bits, and root bypasses them.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('names an archive it cannot read by its name in the delivery directory, whose path begins with the pack root\'s', async () => {
    const one = await deployment({ deliveries: 'packs-deliveries' })
    await drop(one.delivery, 'v1.dshpack', [pack('a', 'A.')])
    const archive = join(one.delivery.directory, 'v1.dshpack')
    await chmod(archive, 0o000)
    let record: unknown
    try {
      record = await readAt(one)
    } finally {
      await chmod(archive, 0o644)
    }
    expect(lineOf(one.reported)).toBe(`skill-pack: v1.dshpack was not installed: Error: EACCES: permission denied, open '${archive}'`)
    // Nothing of the archive was read, so it names no set.
    expect(record).toEqual({
      result: 'refused',
      archives: ['v1.dshpack'],
      reason: `skill-pack: v1.dshpack was not installed: Error: EACCES: permission denied, open '${join('<delivery directory>', 'v1.dshpack')}'`,
      at: '<at>',
    })
    expect(JSON.stringify(record)).not.toContain(one.world)
    await expect(readdir(one.root)).rejects.toThrow()
  })

  it('names the pack root and the delivery directory by placeholder where a refusal spells them as their real paths', async () => {
    const one = await deployment({ linked: true })
    await drop(one.delivery, 'v1.dshpack', [pack('a', 'A.')])
    expect((await one.read())?.result).toBe('installed')
    await rm(join(one.delivery.directory, 'v1.dshpack'))
    await drop(one.delivery, 'v2.dshpack', [pack('b', 'B.')])
    one.reported.length = 0
    const world = await realpath(one.world)
    const realRoot = join(world, 'packs')
    const realDirectory = join(world, 'deliveries')
    expect(realRoot).not.toBe(one.root)

    const record = await readAt(one, () => ({
      pack: 'b',
      file: 'SKILL.md',
      reason: `staged from ${join(realDirectory, 'v2.dshpack')} beside ${realRoot}`,
    }))
    expect(lineOf(one.reported)).toBe('skill-pack: v2.dshpack was not installed: PackInstallError: skill-pack: refused '
      + `b/SKILL.md — staged from ${join(realDirectory, 'v2.dshpack')} beside ${realRoot}`)
    expect(record).toEqual({
      result: 'refused',
      archives: ['v2.dshpack'],
      set: SET,
      reason: 'skill-pack: v2.dshpack was not installed: PackInstallError: skill-pack: refused '
        + `b/SKILL.md — staged from ${join('<delivery directory>', 'v2.dshpack')} beside <pack root>`,
      at: '<at>',
    })
    expect(await readdir(one.root)).toEqual(['a'])
  })

  it('reads only the archives, so a note, a hidden file and a directory beside them say nothing', async () => {
    const one = await deployment()
    await drop(one.delivery, 'set.dshpack', [pack('a', 'A.')])
    await writeFile(join(one.delivery.directory, 'README.txt'), 'the delivery of 2026-09-19\n')
    await writeFile(join(one.delivery.directory, '.partial.dshpack'), 'half a copy')
    await mkdir(join(one.delivery.directory, 'old.dshpack'))

    expect((await one.read())?.result).toBe('installed')
    expect(one.reported).toEqual([
      'info skill-pack: installed space-console 2026.9.19 from set.dshpack: packs [a], retired []',
    ])
  })

  it('refuses an archive whose view the caller\'s surface will not draw, naming the set, the file and the reason', async () => {
    const one = await deployment()
    await drop(one.delivery, 'v1.dshpack', [pack('a', 'A.')])
    expect((await one.read())?.result).toBe('installed')
    await rm(join(one.delivery.directory, 'v1.dshpack'))
    await drop(one.delivery, 'v2.dshpack', [{
      name: 'b',
      files: [
        {
          path: 'SKILL.md',
          content: '---\nname: b\ndescription: d\nmetadata:\n  pack:\n    version: 1.0.0\n    viewFormat: 1\n  views: [views/b.yml]\n---\nB.',
        },
        { path: 'views/b.yml', content: 'id: b\ntitle: B\nspec: []\nparams: {}\n' },
      ],
    }])
    one.reported.length = 0

    const record = await readAt(one, packs => packs.length === 1 && packs[0]!.name === 'b'
      ? { pack: 'b', file: 'views/b.yml', reason: 'spec.nodes[0].component: names no component of this deployment' }
      : undefined)
    expect(lineOf(one.reported)).toBe('skill-pack: v2.dshpack was not installed: PackInstallError: skill-pack: refused '
      + 'b/views/b.yml — spec.nodes[0].component: names no component of this deployment')
    expect(record).toEqual({ result: 'refused', archives: ['v2.dshpack'], set: SET, reason: lineOf(one.reported), at: '<at>' })
    expect(await readdir(one.root)).toEqual(['a'])
  })
})

describe('the delivery record the status route keeps', () => {
  const AT = '2026-10-09T00:00:00.000Z'
  const LATER = '2026-10-09T00:00:01.000Z'
  const installed: DeliveryRecord = { result: 'installed', archives: ['v1.dshpack'], set: SET, at: AT }
  const refused: DeliveryRecord = { result: 'refused', archives: ['v1.dshpack'], set: SET, reason: 'r', at: AT }

  it('keeps nothing until a read finds an archive, and keeps the record through a read that finds none', () => {
    expect(keepDelivery(undefined, undefined)).toBeUndefined()
    expect(keepDelivery(installed, undefined)).toBe(installed)
  })

  it('keeps an install through the unchanged read of the same archive that follows it', () => {
    expect(keepDelivery(installed, { ...installed, result: 'unchanged', at: LATER })).toBe(installed)
    const unchanged: DeliveryRecord = { ...installed, result: 'unchanged' }
    expect(keepDelivery(unchanged, { ...unchanged, at: LATER })).toBe(unchanged)
  })

  it('replaces the record with an unchanged read of another archive name or another set', () => {
    const renamed: DeliveryRecord = { result: 'unchanged', archives: ['v1-again.dshpack'], set: SET, at: LATER }
    expect(keepDelivery(installed, renamed)).toBe(renamed)
    const reversioned: DeliveryRecord = { result: 'unchanged', archives: ['v1.dshpack'], set: { ...SET, version: '2' }, at: LATER }
    expect(keepDelivery(installed, reversioned)).toBe(reversioned)
    const renumbered: DeliveryRecord = { result: 'unchanged', archives: ['v1.dshpack'], set: { ...SET, id: 'other' }, at: LATER }
    expect(keepDelivery(installed, renumbered)).toBe(renumbered)
  })

  it('replaces a refusal with whatever follows it, and any record with a refusal or an install', () => {
    const unchanged: DeliveryRecord = { ...installed, result: 'unchanged', at: LATER }
    expect(keepDelivery(refused, unchanged)).toBe(unchanged)
    const again: DeliveryRecord = { ...refused, at: LATER }
    expect(keepDelivery(refused, again)).toBe(again)
    expect(keepDelivery(installed, again)).toBe(again)
    const reinstalled: DeliveryRecord = { ...installed, at: LATER }
    expect(keepDelivery(installed, reinstalled)).toBe(reinstalled)
  })
})
