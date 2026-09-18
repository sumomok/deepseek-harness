/**
 * Replacing a pack root: what the root holds afterwards, what it costs to run
 * the same delivery twice, and what the delivery is refused for.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PackInstallError, syncPackRoot, type DeliveredPack } from '../src/install.ts'

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
