/**
 * The form configured directories are compared in, per platform: names folded
 * to NFC and lower case where the platform's file systems ignore letter case,
 * and compared as written where they do not, whichever platform runs the test.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { refuseSharedDirectories } from '../src/directories.ts'

let world: string | undefined

afterEach(async () => {
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

/** A fresh directory holding an existing `packs` directory, and the pair of names compared with it. */
async function newWorld(): Promise<string> {
  world = await mkdtemp(join(tmpdir(), 'dsh-skill-pack-directories-'))
  await mkdir(join(world, 'packs'))
  return world
}

describe('configured directories compared per platform', () => {
  it.each(['darwin', 'win32'] as const)('refuses two names differing only in letter case or normalization on %s', async (platform) => {
    const base = await newWorld()
    for (const other of ['PACKS', 'Packs']) {
      expect(() => refuseSharedDirectories([
        { field: 'organizationRoot', path: join(base, other) },
        { field: 'root', path: join(base, 'packs') },
      ], platform)).toThrow(`skill-pack: organizationRoot ${JSON.stringify(join(base, other))} and root ${JSON.stringify(join(base, 'packs'))}`)
    }
    expect(() => refuseSharedDirectories([
      { field: 'organizationRoot', path: join(base, 'vé') },
      { field: 'root', path: join(base, 'vé', 'packs') },
    ], platform)).toThrow('must be separate directories, neither inside the other, because replacing one would write into the other')
  })

  // Under a directory that does not exist, so the host's own file system,
  // which may ignore case, never reads either name back.
  it('compares names as written on linux, where letter case and normalization tell directories apart', async () => {
    const missing = join(await newWorld(), 'missing')
    expect(() => refuseSharedDirectories([
      { field: 'organizationRoot', path: join(missing, 'PACKS') },
      { field: 'root', path: join(missing, 'packs') },
      { field: 'deliveries.directory', path: join(missing, 'vé') },
      { field: 'other', path: join(missing, 'vé') },
    ], 'linux')).not.toThrow()
  })
})
