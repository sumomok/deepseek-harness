/**
 * What a pack root on disk answers: which directories are packs, what their
 * frontmatter says, and which of their declared view files came back.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readFrontmatter, readPack, readPackRoot } from '../src/scan.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function packRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-skill-pack-scan-'))
  return root
}

async function writePack(directory: string, frontmatter: string, body = 'Placeholder.\n'): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`)
}

describe('SKILL.md frontmatter', () => {
  it('splits the mapping from the body', () => {
    expect(readFrontmatter('---\nname: a\n---\nBody line.\n')).toEqual({ data: { name: 'a' }, body: 'Body line.\n' })
  })

  it('reads nothing from a file that opens or closes no frontmatter block, or carries no mapping', () => {
    expect(readFrontmatter('Body only.\n')).toBeUndefined()
    expect(readFrontmatter('---\nname: a\n')).toBeUndefined()
    expect(readFrontmatter('---\n- a\n---\nBody.\n')).toBeUndefined()
    expect(readFrontmatter('---\nname: [unclosed\n---\nBody.\n')).toBeUndefined()
    expect(readFrontmatter('')).toBeUndefined()
  })

  it('tolerates carriage returns on both fences', () => {
    expect(readFrontmatter('---\r\nname: a\r\n---\r\nBody.\n')).toMatchObject({ data: { name: 'a' } })
  })
})

describe('reading a pack root', () => {
  it('reads each pack\'s name, description, routing guidance, manifest and declared views', async () => {
    const base = await packRoot()
    const directory = join(base, 'space-data-page')
    await writePack(directory, [
      'name: space-data-page',
      'description: The layer table.',
      'whenToUse: When the user asks about layers.',
      'metadata:',
      '  pack:',
      '    version: 1.0.0',
      '  views:',
      '    - views/space-layer.yml',
    ].join('\n'))
    await mkdir(join(directory, 'views'))
    await writeFile(join(directory, 'views', 'space-layer.yml'), 'id: space-layer\ntitle: A\nspec: []\n')

    const [source] = await readPackRoot(base)
    expect(source).toMatchObject({
      skill: 'space-data-page',
      description: 'The layer table.',
      whenToUse: 'When the user asks about layers.',
      directory,
      path: join(directory, 'SKILL.md'),
    })
    expect(source?.manifest).toMatchObject({ ok: true })
    expect(source?.views).toEqual([{ ok: true, path: 'views/space-layer.yml', view: { id: 'space-layer', title: 'A', spec: [], params: {} } }])
  })

  it('reports a declared view that is missing or unparseable without hiding the pack', async () => {
    const base = await packRoot()
    const directory = join(base, 'space-data-page')
    await writePack(directory, [
      'name: space-data-page',
      'description: The layer table.',
      'metadata:',
      '  pack:',
      '    version: 1.0.0',
      '  views:',
      '    - views/gone.yml',
      '    - views/bad.yml',
    ].join('\n'))
    await mkdir(join(directory, 'views'))
    await writeFile(join(directory, 'views', 'bad.yml'), '- a\n')

    const [source] = await readPackRoot(base)
    expect(source?.views[0]).toMatchObject({ ok: false, path: 'views/gone.yml' })
    expect(source?.views[1]).toEqual({ ok: false, path: 'views/bad.yml', reason: 'is not a YAML mapping' })
  })

  it('refuses a declared view that leaves the pack directory rather than following it', async () => {
    const base = await packRoot()
    const directory = join(base, 'space-data-page')
    await writePack(directory, [
      'name: space-data-page',
      'description: The layer table.',
      'metadata:',
      '  pack:',
      '    version: 1.0.0',
      '  views:',
      '    - ../elsewhere.yml',
    ].join('\n'))
    await writeFile(join(base, 'elsewhere.yml'), 'id: a\ntitle: A\nspec: []\n')

    const [source] = await readPackRoot(base)
    expect(source?.views).toEqual([{ ok: false, path: '../elsewhere.yml', reason: 'leaves the pack directory' }])
  })

  it('reads no views at all when the manifest itself did not parse', async () => {
    const base = await packRoot()
    await writePack(join(base, 'broken'), [
      'name: broken',
      'description: Broken.',
      'metadata:',
      '  pack:',
      '    version: one',
    ].join('\n'))
    const [source] = await readPackRoot(base)
    expect(source?.manifest).toMatchObject({ ok: false, field: 'metadata.pack.version' })
    expect(source?.views).toEqual([])
  })

  it('skips a root entry that is not a pack, and reports an absent root as holding none', async () => {
    const base = await packRoot()
    await writeFile(join(base, 'README.md'), 'not a pack\n')
    await mkdir(join(base, 'empty'))
    await writePack(join(base, 'no-frontmatter'), '', 'body')
    await writePack(join(base, 'no-name'), 'description: d')
    await writePack(join(base, 'bad-name'), 'name: Not Kebab\ndescription: d')
    await writePack(join(base, 'good'), 'name: good\ndescription: d\nmetadata:\n  pack:\n    version: 1.0.0')

    expect((await readPackRoot(base)).map(source => source.skill)).toEqual(['good'])
    expect(await readPackRoot(join(base, 'nowhere'))).toEqual([])
    expect(await readPack(base, 'empty')).toBeUndefined()
  })

  it('sorts packs by directory name', async () => {
    const base = await packRoot()
    for (const name of ['zulu', 'alpha', 'mike']) {
      await writePack(join(base, name), `name: ${name}\ndescription: d\nmetadata:\n  pack:\n    version: 1.0.0`)
    }
    expect((await readPackRoot(base)).map(source => source.skill)).toEqual(['alpha', 'mike', 'zulu'])
  })

  it('reads a pack whose SKILL.md is reached through a link, because a link is not what withholds a pack', async () => {
    const base = await packRoot()
    const directory = join(base, 'linked')
    await mkdir(directory)
    const target = join(base, 'body.md')
    await writeFile(target, '---\nname: linked\ndescription: d\nmetadata:\n  pack:\n    version: 1.0.0\n---\nBody.\n')
    await symlink(target, join(directory, 'SKILL.md'))
    expect((await readPackRoot(base)).map(source => source.skill)).toEqual(['linked'])
  })
})
