/**
 * Replacing a pack root: what the root holds afterwards, what it costs to run
 * the same delivery twice, and what the delivery is refused for.
 */

import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { syncPackRoot } from '../src/install.ts'
import { PackInstallError } from '../src/refusal.ts'
import type { DeliveredPack } from '../src/types.ts'

let world: string | undefined

afterEach(async () => {
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

async function workspace(): Promise<string> {
  world = await mkdtemp(join(tmpdir(), 'dsh-skill-pack-install-'))
  return world
}

/** One pack a delivery carries: the manifest a pack root reads it by, and the one view it declares. */
function pack(name: string, body: string, view = 'id: v\ntitle: V\nspec: []\n'): DeliveredPack {
  return {
    name,
    files: [
      {
        path: 'SKILL.md',
        content: [
          '---',
          `name: ${name}`,
          'description: d',
          'metadata:',
          '  pack:',
          '    version: 1.0.0',
          '    viewFormat: 1',
          '  views: [views/v.yml]',
          '---',
          body,
        ].join('\n'),
      },
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
    for (const file of pack('a', 'A.').files) {
      await writeFile(join(source, 'a', ...file.path.split('/')), file.content)
    }
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

  it('refuses a pack name or a path segment holding a lone UTF-16 surrogate or longer than 255 bytes of UTF-8, and leaves the root as it was', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    await syncPackRoot(root, { kind: 'packs', packs: [pack('a', 'A.')] })
    for (const name of ['b\ud800', 'x'.repeat(256), '\u00e9'.repeat(128)]) {
      await expect(syncPackRoot(root, { kind: 'packs', packs: [pack(name, 'B.')] }))
        .rejects.toMatchObject({ refusal: 'path-escape', entry: name })
    }
    for (const path of ['notes/\udc00.md', `notes/${'n'.repeat(253)}.md`, `${'d'.repeat(256)}/n.md`]) {
      await expect(syncPackRoot(root, { kind: 'packs', packs: [{ name: 'b', files: [{ path, content: 'x' }] }] }))
        .rejects.toMatchObject({ refusal: 'path-escape', entry: `b/${path}` })
    }
    expect(await tree(root)).toEqual(['a/SKILL.md', 'a/views/v.yml'])
    expect(await readdir(base)).toEqual(['packs'])
  })

  it('installs a path segment of exactly 255 bytes of UTF-8', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    const fits = `notes/${'n'.repeat(252)}.md`
    const a = pack('a', 'A.')
    await syncPackRoot(root, { kind: 'packs', packs: [{ name: 'a', files: [...a.files, { path: fits, content: 'x' }] }] })
    expect(await tree(root)).toEqual(['a/SKILL.md', `a/${fits}`, 'a/views/v.yml'])
  })

  it('refuses two packs, or two paths of one pack, that differ only in letter case or Unicode normalization, and leaves the root as it was', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    await syncPackRoot(root, { kind: 'packs', packs: [pack('a', 'A.')] })
    const nfc = 'v\u00e9'
    const nfd = 've\u0301'
    for (const [first, second] of [['a-guide@RC', 'a-guide@rc'], [`a-guide@${nfc}`, `a-guide@${nfd}`], ['a-guide@stra\u00dfe', 'a-guide@strasse']] as const) {
      await expect(syncPackRoot(root, { kind: 'packs', packs: [pack(first, 'One.'), pack(second, 'Two.')] }))
        .rejects.toMatchObject({
          refusal: 'duplicate-entry',
          entry: second,
          message: `skill-pack: refused ${second} \u2014 a delivery names each pack once when names are folded the way skill-pack compares them`,
        })
    }
    for (const [first, second] of [['views/a.yml', 'views/A.yml'], [`views/${nfc}.yml`, `views/${nfd}.yml`], ['views/stra\u00dfe.yml', 'views/strasse.yml']] as const) {
      const files = [{ path: first, content: 'id: one\n' }, { path: second, content: 'id: two\n' }]
      await expect(syncPackRoot(root, { kind: 'packs', packs: [{ name: 'b', files }] }))
        .rejects.toMatchObject({
          refusal: 'duplicate-entry',
          entry: `b/${second}`,
          message: `skill-pack: refused b/${second} \u2014 a pack carries each path once when paths are folded the way skill-pack compares them`,
        })
    }
    expect(await tree(root)).toEqual(['a/SKILL.md', 'a/views/v.yml'])
    expect(await readdir(base)).toEqual(['packs'])
  })

  it('refuses a path one pack uses both as a file and as the directory of another, in either order and once folded, and leaves the root as it was', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    await syncPackRoot(root, { kind: 'packs', packs: [pack('a', 'A.')] })
    for (const [first, second] of [
      ['notes/x.md', 'notes/x.md/y.md'],
      ['notes/x.md', 'notes/X.md/y.md'],
      ['notes/x.md', 'notes/x.md/deeper/y.md'],
      ['notes/x.md/y.md', 'notes/x.md'],
      ['notes/X.md/y.md', 'notes/x.md'],
      ['notes/stra\u00dfe.md', 'notes/strasse.md/y.md'],
    ] as const) {
      const files = [...pack('b', 'B.').files, { path: first, content: 'x' }, { path: second, content: 'y' }]
      await expect(syncPackRoot(root, { kind: 'packs', packs: [{ name: 'b', files }] }))
        .rejects.toMatchObject({
          refusal: 'duplicate-entry',
          entry: `b/${second}`,
          message: `skill-pack: refused b/${second} \u2014 a pack uses no path as both a file and a directory when paths are folded the way skill-pack compares them`,
        })
    }
    expect(await tree(root)).toEqual(['a/SKILL.md', 'a/views/v.yml'])
    expect(await readdir(base)).toEqual(['packs'])
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

  // Mode 000 denies a directory read only to a non-root owner on POSIX:
  // Windows has no directory permission bits for readdir, and root bypasses
  // them, so there the root stays readable and the delivery installs.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses to replace a root it cannot read, and leaves the root as it was', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    await syncPackRoot(root, { kind: 'packs', packs: [pack('a', 'A.')] })
    const before = await digests(root)
    await chmod(root, 0o000)
    try {
      await expect(syncPackRoot(root, { kind: 'packs', packs: [pack('b', 'B.')] })).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(root, 0o755)
    }
    expect(await digests(root)).toEqual(before)
    expect(await readdir(base)).toEqual(['packs'])
  })

  it('refuses to replace a root that is a file, and leaves the file as it was', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    await writeFile(root, 'not a pack root\n')
    await expect(syncPackRoot(root, { kind: 'packs', packs: [pack('a', 'A.')] })).rejects.toMatchObject({ code: 'ENOTDIR' })
    expect(await readFile(root, 'utf8')).toBe('not a pack root\n')
    expect(await readdir(base)).toEqual(['packs'])
  })
})

/** One pack whose SKILL.md carries exactly the manifest lines a case is about, and the view files beside it. */
function packWith(name: string, pack: string[], views: Record<string, string>): DeliveredPack {
  return {
    name,
    files: [
      {
        path: 'SKILL.md',
        content: ['---', `name: ${name}`, 'description: d', 'metadata:', '  pack:', ...pack, '---', 'Instructions.'].join('\n'),
      },
      ...Object.entries(views).map(([file, body]) => ({ path: `views/${file}`, content: body })),
    ],
  }
}

describe('the views a delivery carries, checked before the root is replaced', () => {
  it('refuses a delivery carrying a pack whose metadata is not a manifest, and writes nothing', async () => {
    const base = await workspace()
    const broken = [{ name: 'a', files: [{ path: 'SKILL.md', content: '---\nname: a\ndescription: d\n---\nA.' }] }]
    await expect(syncPackRoot(join(base, 'packs'), { kind: 'packs', packs: broken }))
      .rejects.toMatchObject({ refusal: 'pack-manifest', entry: 'a/SKILL.md' })
    expect(await readdir(base)).toEqual([])
  })

  it('refuses a delivery declaring a view file it does not carry, and leaves the root byte-identical', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    await syncPackRoot(root, { kind: 'packs', packs: [pack('a', 'A.')] })
    const before = await digests(root)

    const attempt = syncPackRoot(root, {
      kind: 'packs',
      packs: [packWith('b', ['    version: 1.0.0', '    viewFormat: 1', '  views: [views/gone.yml]'], {})],
    })
    await expect(attempt).rejects.toBeInstanceOf(PackInstallError)
    await expect(attempt).rejects.toMatchObject({ refusal: 'pack-view', entry: 'b/views/gone.yml' })
    expect(await digests(root)).toEqual(before)
    expect(await readdir(base)).toEqual(['packs'])
  })

  it('refuses a delivery whose view file is not a view, naming the file and what it lacks', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    const attempt = syncPackRoot(root, {
      kind: 'packs',
      packs: [packWith('b', ['    version: 1.0.0', '    viewFormat: 1', '  views: [views/v.yml]'], {
        'v.yml': 'id: layers\nspec: []\n',
      })],
    })
    await expect(attempt).rejects.toMatchObject({ refusal: 'pack-view', entry: 'b/views/v.yml' })
    await expect(attempt).rejects.toThrow('has no title')
    await expect(stat(root)).rejects.toThrow()
  })

  it('refuses a delivery whose views are written in a format this build does not read', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    for (const stated of [['    viewFormat: 7'], []]) {
      const attempt = syncPackRoot(root, {
        kind: 'packs',
        packs: [packWith('b', ['    version: 1.0.0', ...stated, '  views: [views/v.yml]'], {
          'v.yml': 'id: layers\ntitle: 图层\nspec: []\n',
        })],
      })
      await expect(attempt).rejects.toMatchObject({ refusal: 'pack-view-format', entry: 'b/SKILL.md' })
      await expect(attempt).rejects.toThrow('this build reads 1')
    }
    await expect(stat(root)).rejects.toThrow()
  })

  it('refuses a delivery carrying a pack whose anchor format this build does not read, and leaves the root byte-identical', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    await syncPackRoot(root, { kind: 'packs', packs: [pack('a', 'A.')] })
    const before = await digests(root)

    const attempt = syncPackRoot(root, {
      kind: 'packs',
      packs: [pack('a', 'A.'), packWith('b', ['    version: 1.0.0', '    anchorFormat: 2', '    viewFormat: 1', '  views: [views/v.yml]'], {
        'v.yml': 'id: layers\ntitle: 图层\nspec: []\n',
      })],
    })
    await expect(attempt).rejects.toMatchObject({ refusal: 'pack-anchor-format', entry: 'b/SKILL.md' })
    await expect(attempt).rejects.toThrow('states anchor format 2; this build reads 1')
    expect(await digests(root)).toEqual(before)
    expect(await readdir(base)).toEqual(['packs'])
  })

  it('installs a pack whose required part nothing here registers, because that pack is waiting rather than wrong', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    const waiting = packWith('b', [
      '    version: 1.0.0',
      '    viewFormat: 1',
      '  requires:',
      '    parts: [toy.data-page]',
      '  views: [views/v.yml]',
    ], { 'v.yml': 'id: layers\ntitle: 图层\nspec: []\n' })
    expect(await syncPackRoot(root, { kind: 'packs', packs: [waiting] }))
      .toEqual({ changed: true, packs: ['b'], retired: [] })
    expect(await tree(root)).toEqual(['b/SKILL.md', 'b/views/v.yml'])
  })

  it('hands every delivered pack to the caller\'s own surface, and installs what it does not refuse', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    const seen: string[][] = []
    const result = await syncPackRoot(root, { kind: 'packs', packs: [pack('a', 'A.'), pack('b', 'B.')] }, (packs) => {
      seen.push(packs.map(staged => `${staged.name}:${staged.skill}:${String(staged.views.length)}`))
      return undefined
    })
    expect(result).toEqual({ changed: true, packs: ['a', 'b'], retired: [] })
    expect(seen).toEqual([['a:a:1', 'b:b:1']])
  })

  it('refuses the whole delivery for one view that surface will not draw, naming the pack, the file and the reason', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    await syncPackRoot(root, { kind: 'packs', packs: [pack('a', 'A.')] })
    const before = await digests(root)

    const attempt = syncPackRoot(root, { kind: 'packs', packs: [pack('a', 'A.'), pack('b', 'B.')] }, packs => packs
      .filter(staged => staged.name === 'b')
      .map(staged => ({ pack: staged.name, file: 'views/v.yml', reason: 'spec — names no component of this deployment' }))[0])
    await expect(attempt).rejects.toMatchObject({ refusal: 'pack-view-refused', entry: 'b/views/v.yml' })
    await expect(attempt).rejects.toThrow('names no component of this deployment')
    expect(await digests(root)).toEqual(before)
    expect(await readdir(base)).toEqual(['packs'])
  })

  it('asks that surface nothing when the root already holds what the delivery carries', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    const packs = [pack('a', 'A.')]
    await syncPackRoot(root, { kind: 'packs', packs })
    let asked = 0
    const result = await syncPackRoot(root, { kind: 'packs', packs }, () => {
      asked += 1
      return undefined
    })
    expect(result.changed).toBe(false)
    expect(asked).toBe(0)
  })

  it('judges a directory that carries no SKILL.md as the non-pack it is, and installs it', async () => {
    const base = await workspace()
    const root = join(base, 'packs')
    const result = await syncPackRoot(root, {
      kind: 'packs',
      packs: [pack('a', 'A.'), { name: 'shared', files: [{ path: 'logo.png', content: 'png' }] }],
    })
    expect(result).toEqual({ changed: true, packs: ['a', 'shared'], retired: [] })
    expect(await tree(root)).toEqual(['a/SKILL.md', 'a/views/v.yml', 'shared/logo.png'])
  })
})
