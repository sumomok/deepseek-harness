/**
 * Replacing a pack root: what the root holds afterwards, what it costs to run
 * the same delivery twice, and what the delivery is refused for.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPackArchive, PACK_ARCHIVE_FORMAT, PACK_ARCHIVE_MANIFEST } from '../src/archive.ts'
import { syncPackRoot } from '../src/install.ts'
import { PackInstallError } from '../src/refusal.ts'
import type { DeliveredPack, PackArchiveLimits } from '../src/types.ts'

/** Limits a test archive is read under, far above anything these packs carry. */
const LIMITS: PackArchiveLimits = { maxArchiveBytes: 1_000_000, maxFileBytes: 100_000, maxFiles: 50 }

/** The set identity every archive here is written under. */
const SET = { id: 'space-console', version: '2026.9.19' }

let world: string | undefined

afterEach(async () => {
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

async function workspace(): Promise<string> {
  world = await mkdtemp(join(tmpdir(), 'dsh-skill-pack-install-'))
  return world
}

function pack(name: string, body: string, view = 'id: v\ntitle: V\nspec: []\n'): DeliveredPack {
  return {
    name,
    files: [
      { path: 'SKILL.md', content: `---\nname: ${name}\ndescription: d\n---\n${body}` },
      { path: 'views/v.yml', content: view },
    ],
  }
}

/** Every path under a root, root-relative and sorted, so a whole tree is one assertion. */
async function tree(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const paths: string[] = []
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) paths.push(...await tree(join(root, entry.name), relative))
    else paths.push(relative)
  }
  return paths.sort()
}

/** Every path under a root with the digest of its bytes, so "unchanged" is a byte-for-byte assertion. */
async function digests(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {}
  for (const path of await tree(root)) {
    entries[path] = createHash('sha256').update(await readFile(join(root, path))).digest('hex')
  }
  return entries
}

describe('replacing a pack root', () => {
  it('writes the delivered packs into a root that does not exist yet', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    const result = await syncPackRoot(root, { kind: 'packs', packs: [pack('a', 'A.'), pack('b', 'B.')] })
    expect(result).toEqual({ changed: true, packs: ['a', 'b'], retired: [] })
    expect(await tree(root)).toEqual(['a/SKILL.md', 'a/views/v.yml', 'b/SKILL.md', 'b/views/v.yml'])
    expect(await readFile(join(root, 'a', 'SKILL.md'), 'utf8')).toContain('A.')
  })

  it('adds, replaces and retires in one delivery, so the root equals the delivered set', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    await syncPackRoot(root, { kind: 'packs', packs: [pack('keep', 'v1.'), pack('retire', 'gone.')] })
    const result = await syncPackRoot(root, { kind: 'packs', packs: [pack('keep', 'v2.'), pack('add', 'new.')] })
    expect(result).toEqual({ changed: true, packs: ['add', 'keep'], retired: ['retire'] })
    expect(await readFile(join(root, 'keep', 'SKILL.md'), 'utf8')).toContain('v2.')
    expect(await readdir(root)).toEqual(expect.arrayContaining(['add', 'keep']))
    expect(await readdir(root)).not.toContain('retire')
  })

  it('writes nothing the second time the same delivery runs', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    const packs = [pack('a', 'A.'), pack('b', 'B.')]
    await syncPackRoot(root, { kind: 'packs', packs })
    const before = (await stat(join(root, 'a', 'SKILL.md'))).mtimeMs
    const result = await syncPackRoot(root, { kind: 'packs', packs })
    expect(result).toEqual({ changed: false, packs: ['a', 'b'], retired: [] })
    expect((await stat(join(root, 'a', 'SKILL.md'))).mtimeMs).toBe(before)
  })

  it('removes a pack, a loose file and a link somebody left in the root', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    const packs = [pack('a', 'A.')]
    await syncPackRoot(root, { kind: 'packs', packs })

    await mkdir(join(root, 'stray'))
    await writeFile(join(root, 'stray', 'SKILL.md'), 'hand-written\n')
    expect((await syncPackRoot(root, { kind: 'packs', packs })).retired).toEqual(['stray'])
    expect(await tree(root)).toEqual(['a/SKILL.md', 'a/views/v.yml'])

    await writeFile(join(root, 'notes.txt'), 'loose\n')
    expect((await syncPackRoot(root, { kind: 'packs', packs })).changed).toBe(true)
    expect(await tree(root)).toEqual(['a/SKILL.md', 'a/views/v.yml'])

    await symlink(join(base, 'outside'), join(root, 'a', 'link.md'))
    expect((await syncPackRoot(root, { kind: 'packs', packs })).changed).toBe(true)
    expect(await tree(root)).toEqual(['a/SKILL.md', 'a/views/v.yml'])
  })

  it('reads a delivered set out of a source directory, and refuses a source entry that is not a pack', async () => {
    const base = await workspace()
    const source = join(base, 'delivery')
    await mkdir(join(source, 'a', 'views'), { recursive: true })
    await writeFile(join(source, 'a', 'SKILL.md'), '---\nname: a\ndescription: d\n---\nA.\n')
    await writeFile(join(source, 'a', 'views', 'v.yml'), 'id: v\ntitle: V\nspec: []\n')
    const root = join(base, 'packs')
    expect(await syncPackRoot(root, { kind: 'directory', path: source }))
      .toEqual({ changed: true, packs: ['a'], retired: [] })
    expect(await tree(root)).toEqual(['a/SKILL.md', 'a/views/v.yml'])

    await writeFile(join(source, 'loose.md'), 'not a pack\n')
    await expect(syncPackRoot(root, { kind: 'directory', path: source }))
      .rejects.toMatchObject({ refusal: 'not-a-pack', entry: 'loose.md' })
  })

  it('refuses a file a pack may not carry, and leaves the root as it was', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    const installed = [pack('a', 'A.')]
    await syncPackRoot(root, { kind: 'packs', packs: installed })

    for (const path of ['setup.js', 'setup.mjs', 'setup.cjs', 'mod.ts', 'Panel.vue', 'addon.node', 'run.sh', 'logo.svg', 'LICENSE']) {
      const attempt = syncPackRoot(root, {
        kind: 'packs',
        packs: [{ name: 'evil', files: [{ path, content: 'x' }] }],
      })
      await expect(attempt).rejects.toBeInstanceOf(PackInstallError)
      await expect(attempt).rejects.toMatchObject({ refusal: 'code-file', entry: `evil/${path}` })
    }
    expect(await tree(root)).toEqual(['a/SKILL.md', 'a/views/v.yml'])
    expect(await readdir(base)).toEqual(['packs'])
  })

  it('refuses a path that leaves its pack, and a pack name that is not one directory name', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    const escapes = ['../outside.md', '/etc/passwd.md', 'views/../../outside.md', './v.md', '', 'a//b.md']
    for (const path of escapes) {
      await expect(syncPackRoot(root, { kind: 'packs', packs: [{ name: 'a', files: [{ path, content: 'x' }] }] }))
        .rejects.toMatchObject({ refusal: 'path-escape' })
    }
    for (const name of ['..', '.', '', 'a/b']) {
      await expect(syncPackRoot(root, { kind: 'packs', packs: [{ name, files: [] }] }))
        .rejects.toMatchObject({ refusal: 'path-escape', entry: name })
    }
    await expect(stat(root)).rejects.toThrow()
  })

  it('refuses a link inside a delivered pack rather than copying what it points at', async () => {
    const base = await workspace()
    const source = join(base, 'delivery')
    await mkdir(join(source, 'a'), { recursive: true })
    await writeFile(join(base, 'secret.md'), 'secret\n')
    await symlink(join(base, 'secret.md'), join(source, 'a', 'SKILL.md'))
    await expect(syncPackRoot(join(base, 'packs'), { kind: 'directory', path: source }))
      .rejects.toMatchObject({ refusal: 'symlink', entry: 'SKILL.md' })
  })

  it('refuses a link standing where a pack directory should be', async () => {
    const base = await workspace()
    const source = join(base, 'delivery')
    await mkdir(source, { recursive: true })
    await writeFile(join(base, 'secret.md'), 'secret\n')
    await symlink(join(base, 'secret.md'), join(source, 'linked.md'))
    await expect(syncPackRoot(join(base, 'packs'), { kind: 'directory', path: source }))
      .rejects.toMatchObject({ refusal: 'symlink', entry: 'linked.md' })
  })

  it('replaces the root when the delivered set has the same count but different names', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    await syncPackRoot(root, { kind: 'packs', packs: [pack('a', 'A.')] })
    expect(await syncPackRoot(root, { kind: 'packs', packs: [pack('b', 'B.')] }))
      .toEqual({ changed: true, packs: ['b'], retired: ['a'] })
    expect(await tree(root)).toEqual(['b/SKILL.md', 'b/views/v.yml'])
  })

  it('leaves the root and the staging sibling behind when writing the delivered set fails', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    const installed = [pack('a', 'A.')]
    await syncPackRoot(root, { kind: 'packs', packs: installed })
    // A file and a directory cannot both be `notes.md`; the second write fails
    // after the first has been staged, which is the partial state the swap
    // exists to keep out of the live root.
    await expect(syncPackRoot(root, {
      kind: 'packs',
      packs: [{ name: 'a', files: [{ path: 'notes.md', content: 'x' }, { path: 'notes.md/inner.md', content: 'y' }] }],
    })).rejects.toThrow()
    expect(await tree(root)).toEqual(['a/SKILL.md', 'a/views/v.yml'])
    expect(await readdir(base)).toEqual(['packs'])
  })
})

describe('installing a pack root from one archive', () => {
  it('leaves the root exactly as the same packs delivered directly would have', async () => {
    const base = await workspace()
    const packs = [pack('a', 'A.'), pack('b', 'B.')]
    const direct = join(base, 'direct')
    await syncPackRoot(direct, { kind: 'packs', packs })

    const packed = join(base, 'packed')
    const result = await syncPackRoot(packed, {
      kind: 'archive',
      name: 'delivery.dshpack',
      bytes: await buildPackArchive({ kind: 'packs', packs }, SET),
      limits: LIMITS,
    })
    expect(result).toEqual({ changed: true, packs: ['a', 'b'], retired: [], set: SET })
    expect(await digests(packed)).toEqual(await digests(direct))
  })

  it('writes nothing the second time the same archive is installed', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    const delivery = {
      kind: 'archive',
      name: 'delivery.dshpack',
      bytes: await buildPackArchive({ kind: 'packs', packs: [pack('a', 'A.')] }, SET),
      limits: LIMITS,
    } as const
    await syncPackRoot(root, delivery)
    const before = (await stat(join(root, 'a', 'SKILL.md'))).mtimeMs
    expect(await syncPackRoot(root, delivery)).toEqual({ changed: false, packs: ['a'], retired: [], set: SET })
    expect((await stat(join(root, 'a', 'SKILL.md'))).mtimeMs).toBe(before)
  })

  it('adds and replaces a pack on an upgrade, and retires one on a downgrade', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    await syncPackRoot(root, {
      kind: 'archive',
      name: 'v1.dshpack',
      bytes: await buildPackArchive({ kind: 'packs', packs: [pack('keep', 'v1.'), pack('retire', 'gone.')] }, SET),
      limits: LIMITS,
    })

    const upgrade = await syncPackRoot(root, {
      kind: 'archive',
      name: 'v2.dshpack',
      bytes: await buildPackArchive({ kind: 'packs', packs: [pack('keep', 'v2.'), pack('retire', 'gone.'), pack('add', 'new.')] }, { ...SET, version: '2026.9.20' }),
      limits: LIMITS,
    })
    expect(upgrade).toEqual({ changed: true, packs: ['add', 'keep', 'retire'], retired: [], set: { ...SET, version: '2026.9.20' } })
    expect(await readFile(join(root, 'keep', 'SKILL.md'), 'utf8')).toContain('v2.')

    const downgrade = await syncPackRoot(root, {
      kind: 'archive',
      name: 'v1.dshpack',
      bytes: await buildPackArchive({ kind: 'packs', packs: [pack('keep', 'v1.')] }, SET),
      limits: LIMITS,
    })
    expect(downgrade).toEqual({ changed: true, packs: ['keep'], retired: ['add', 'retire'], set: SET })
    expect(await tree(root)).toEqual(['keep/SKILL.md', 'keep/views/v.yml'])
    expect(await readFile(join(root, 'keep', 'SKILL.md'), 'utf8')).toContain('v1.')
  })

  it('leaves the root byte-identical when the archive it was handed does not verify', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    await syncPackRoot(root, {
      kind: 'archive',
      name: 'v1.dshpack',
      bytes: await buildPackArchive({ kind: 'packs', packs: [pack('a', 'A.')] }, SET),
      limits: LIMITS,
    })
    const before = await digests(root)

    const content = 'edited between the console and the box'
    const tampered = zipSync({
      [PACK_ARCHIVE_MANIFEST]: Buffer.from(JSON.stringify({
        format: PACK_ARCHIVE_FORMAT,
        set: SET,
        files: [{ path: 'a/SKILL.md', sha256: createHash('sha256').update('A.').digest('hex') }],
      })),
      'packs/a/SKILL.md': Buffer.from(content),
    })
    await expect(syncPackRoot(root, { kind: 'archive', name: 'v2.dshpack', bytes: tampered, limits: LIMITS }))
      .rejects.toMatchObject({ refusal: 'archive-digest', entry: 'a/SKILL.md' })
    expect(await digests(root)).toEqual(before)
    expect(await readdir(base)).toEqual(['packs'])
  })

  it('refuses an archive whose manifest declares a file a pack may not carry, or a path leaving its pack', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    for (const path of ['a/setup.js', 'a/../outside.md']) {
      const content = 'x'
      const attempt = syncPackRoot(root, {
        kind: 'archive',
        name: 'delivery.dshpack',
        bytes: zipSync({
          [PACK_ARCHIVE_MANIFEST]: Buffer.from(JSON.stringify({
            format: PACK_ARCHIVE_FORMAT,
            set: SET,
            files: [{ path, sha256: createHash('sha256').update(content).digest('hex') }],
          })),
          [`packs/${path}`]: Buffer.from(content),
        }),
        limits: LIMITS,
      })
      await expect(attempt).rejects.toBeInstanceOf(PackInstallError)
    }
    await expect(stat(root)).rejects.toThrow()
  })
})
