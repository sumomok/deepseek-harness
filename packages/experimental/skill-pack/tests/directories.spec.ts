/**
 * The form configured directories are compared in, per platform: names folded
 * by `collisionKey` where the platform's file systems ignore letter case, and
 * compared as written where they do not, whichever platform runs the test;
 * and the refusal of a directory reached through a symbolic link whose target
 * does not exist, on every platform.
 */

import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
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
      expect(() => {
        refuseSharedDirectories([
          { field: 'organizationRoot', path: join(base, other) },
          { field: 'root', path: join(base, 'packs') },
        ], platform)
      }).toThrow(`skill-pack: organizationRoot ${JSON.stringify(join(base, other))} and root ${JSON.stringify(join(base, 'packs'))}`)
    }
    expect(() => {
      refuseSharedDirectories([
        { field: 'organizationRoot', path: join(base, 'v\u00e9') },
        { field: 'root', path: join(base, 've\u0301', 'packs') },
      ], platform)
    }).toThrow('must be separate directories, neither inside the other, because replacing one would write into the other')
  })

  // The cases below compare names under a directory that does not exist, so
  // the host's own file system, which may ignore case, never reads either
  // name back.
  it.each(['darwin', 'win32'] as const)('refuses two names under a missing directory that differ only in letter case on %s', async (platform) => {
    const missing = join(await newWorld(), 'missing')
    expect(() => {
      refuseSharedDirectories([
        { field: 'organizationRoot', path: join(missing, 'PACKS') },
        { field: 'root', path: join(missing, 'packs') },
      ], platform)
    }).toThrow(`skill-pack: organizationRoot ${JSON.stringify(join(missing, 'PACKS'))} and root ${JSON.stringify(join(missing, 'packs'))}`)
  })

  it.each(['darwin', 'win32'] as const)('refuses two names under a missing directory that lower case alone tells apart and APFS reads as one on %s', async (platform) => {
    const missing = join(await newWorld(), 'missing')
    for (const [left, right] of [['stra\u00dfe', 'strasse'], ['\u03c3', '\u03c2'], ['\u00b5', '\u03bc'], ['\u017f', 's']] as const) {
      expect(() => {
        refuseSharedDirectories([
          { field: 'organizationRoot', path: join(missing, left) },
          { field: 'root', path: join(missing, right) },
        ], platform)
      }).toThrow(`skill-pack: organizationRoot ${JSON.stringify(join(missing, left))} and root ${JSON.stringify(join(missing, right))}`)
    }
  })

  it('compares names as written on linux, where letter case and normalization tell directories apart', async () => {
    const missing = join(await newWorld(), 'missing')
    expect(() => {
      refuseSharedDirectories([
        { field: 'organizationRoot', path: join(missing, 'PACKS') },
        { field: 'root', path: join(missing, 'packs') },
        { field: 'deliveries.directory', path: join(missing, 'v\u00e9') },
        { field: 'other', path: join(missing, 've\u0301') },
        { field: 'sharp', path: join(missing, 'stra\u00dfe') },
        { field: 'double', path: join(missing, 'strasse') },
      ], 'linux')
    }).not.toThrow()
  })
})

// Creating a symbolic link on Windows needs the create-symbolic-link
// privilege or Developer Mode, which a test cannot count on.
describe.skipIf(process.platform === 'win32')('configured directories reached through a symbolic link whose target does not exist', () => {
  /** The refusal naming one configured directory and the link it is reached through. */
  const dangling = (field: string, path: string, link: string): string =>
    `skill-pack: ${field} ${JSON.stringify(path)} resolves through the symbolic link ${JSON.stringify(link)}, whose target does not exist`

  it.each(['darwin', 'linux', 'win32'] as const)('refuses a directory under a link to a missing directory inside the pack root on %s', async (platform) => {
    const base = await newWorld()
    const link = join(base, 'later-link')
    await symlink(join(base, 'packs', 'later'), link)
    const organizationRoot = join(link, 'org')
    expect(() => {
      refuseSharedDirectories([
        { field: 'organizationRoot', path: organizationRoot },
        { field: 'root', path: join(base, 'packs') },
      ], platform)
    }).toThrow(dangling('organizationRoot', organizationRoot, link))
  })

  it.each(['darwin', 'linux', 'win32'] as const)('refuses a directory that is itself a link to the missing pack root on %s', async (platform) => {
    const base = await newWorld()
    const root = join(base, 'absent-packs')
    const organizationRoot = join(base, 'organization-link')
    await symlink(root, organizationRoot)
    expect(() => {
      refuseSharedDirectories([
        { field: 'organizationRoot', path: organizationRoot },
        { field: 'root', path: root },
      ], platform)
    }).toThrow(dangling('organizationRoot', organizationRoot, organizationRoot))
  })

  it('refuses a directory under a link that points at itself', async () => {
    const base = await newWorld()
    const loop = join(base, 'loop')
    await symlink(loop, loop)
    const root = join(loop, 'packs')
    expect(() => {
      refuseSharedDirectories([{ field: 'root', path: root }], 'linux')
    }).toThrow(dangling('root', root, loop))
  })
})
