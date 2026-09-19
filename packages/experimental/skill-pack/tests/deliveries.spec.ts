/**
 * The delivery directory: which archive it names, what installing that archive
 * reports, and what it leaves the pack root as when it names none, names two,
 * or names one this deployment will not read.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPackArchive, PACK_ARCHIVE_FORMAT, PACK_ARCHIVE_MANIFEST } from '../src/archive.ts'
import { installDelivery, type DeliveryDirectory } from '../src/deliveries.ts'
import type { DeliveredPack } from '../src/types.ts'

const LIMITS = { maxArchiveBytes: 1_000_000, maxFileBytes: 100_000, maxFiles: 50 }

const SET = { id: 'space-console', version: '2026.9.19' }

let world: string | undefined

afterEach(async () => {
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

/** A pack root, a delivery directory beside it, and the lines one read reported. */
interface Deployment {
  readonly root: string
  readonly delivery: DeliveryDirectory
  readonly reported: string[]
  read(): Promise<boolean>
}

async function deployment(limits = LIMITS, create = true): Promise<Deployment> {
  world = await mkdtemp(join(tmpdir(), 'dsh-skill-pack-deliveries-'))
  const root = join(world, 'packs')
  const directory = join(world, 'deliveries')
  if (create) await mkdir(directory, { recursive: true })
  const reported: string[] = []
  const delivery = { directory, limits }
  return {
    root,
    delivery,
    reported,
    read: () => installDelivery(root, delivery, (level, text) => { reported.push(`${level} ${text}`) }),
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
async function drop(delivery: DeliveryDirectory, name: string, packs: DeliveredPack[]): Promise<void> {
  await writeFile(join(delivery.directory, name), await buildPackArchive({ kind: 'packs', packs }, SET))
}

describe('reading the delivery directory', () => {
  it('says nothing about a directory that does not exist, and nothing about an empty one', async () => {
    const absent = await deployment(LIMITS, false)
    expect(await absent.read()).toBe(false)
    expect(absent.reported).toEqual([])

    const empty = await deployment()
    expect(await empty.read()).toBe(false)
    expect(empty.reported).toEqual([])
    await expect(readdir(empty.root)).rejects.toThrow()
  })

  it('installs the one archive it names, and says what the deployment now holds', async () => {
    const one = await deployment()
    await drop(one.delivery, 'set.dshpack', [pack('a', 'A.'), pack('b', 'B.')])
    expect(await one.read()).toBe(true)
    expect(one.reported).toEqual([
      'info skill-pack: installed space-console 2026.9.19 from set.dshpack: packs [a, b], retired []',
    ])
    expect(await readdir(one.root)).toEqual(['a', 'b'])
  })

  it('says nothing the second time, because the root already holds what the archive carries', async () => {
    const one = await deployment()
    await drop(one.delivery, 'set.dshpack', [pack('a', 'A.')])
    expect(await one.read()).toBe(true)
    one.reported.length = 0
    expect(await one.read()).toBe(false)
    expect(one.reported).toEqual([])
  })

  it('installs nothing while the directory names two deliveries', async () => {
    const two = await deployment()
    await drop(two.delivery, 'v1.dshpack', [pack('a', 'A.')])
    expect(await two.read()).toBe(true)
    await drop(two.delivery, 'v2.dshpack', [pack('b', 'B.')])
    two.reported.length = 0

    expect(await two.read()).toBe(false)
    expect(two.reported).toEqual([
      'error skill-pack: the delivery directory holds 2 archives (v1.dshpack, v2.dshpack); it names one delivery at a time',
    ])
    expect(await readdir(two.root)).toEqual(['a'])
  })

  it('refuses an archive larger than the size it reads one under, without reading it', async () => {
    const small = await deployment({ ...LIMITS, maxArchiveBytes: 64 })
    await drop(small.delivery, 'set.dshpack', [pack('a', 'A.')])
    expect(await small.read()).toBe(false)
    expect(small.reported).toEqual([
      expect.stringContaining('error skill-pack: refused set.dshpack — is '),
    ])
    expect(small.reported[0]).toContain('over the 64 it is read under')
    await expect(readdir(small.root)).rejects.toThrow()
  })

  it('names the archive it could not install, and leaves the root as it was', async () => {
    const one = await deployment()
    await drop(one.delivery, 'v1.dshpack', [pack('a', 'A.')])
    expect(await one.read()).toBe(true)
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
    expect(await one.read()).toBe(false)
    expect(one.reported[0]).toContain('error skill-pack: v2.dshpack was not installed: PackInstallError')
    expect(await readdir(one.root)).toEqual(['a'])
  })

  it('reads only the archives, so a note, a hidden file and a directory beside them say nothing', async () => {
    const one = await deployment()
    await drop(one.delivery, 'set.dshpack', [pack('a', 'A.')])
    await writeFile(join(one.delivery.directory, 'README.txt'), 'the delivery of 2026-09-19\n')
    await writeFile(join(one.delivery.directory, '.partial.dshpack'), 'half a copy')
    await mkdir(join(one.delivery.directory, 'old.dshpack'))

    expect(await one.read()).toBe(true)
    expect(one.reported).toEqual([
      'info skill-pack: installed space-console 2026.9.19 from set.dshpack: packs [a], retired []',
    ])
  })
})
