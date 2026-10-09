/**
 * The vendored point-anchor against the console's own readers: the anchor
 * formats a pack may state are the ones point-anchor reads, at the metadata
 * path it writes them under; an archive point-anchor writes is the archive
 * skill-pack writes for the same packs, byte for byte, and skill-pack reads it
 * back whole, edge names included; and the two refuse the same pack names and
 * paths, but for a backslash, which point-anchor refuses on every platform and
 * skill-pack only where it separates paths: what point-anchor writes, skill-pack
 * reads.
 */

import { describe, expect, it } from 'vitest'
import { ANCHOR_FORMAT, ANCHOR_FORMAT_METADATA_PATH, ANCHOR_FORMATS_READ } from '@haoran/dsh-point-anchor'
import { DshpackError, DSHPACK_DEFAULT_LIMITS, PACK_FILE_EXTENSIONS as WRITER_EXTENSIONS, writeDshpack } from '@haoran/dsh-point-anchor/pack'
import type { DshpackPack } from '@haoran/dsh-point-anchor/pack'
import { buildPackArchive, PACK_ANCHOR_FORMATS, PACK_FILE_EXTENSIONS, PACK_MANIFEST_FIELDS, parsePackManifest } from '@deepseek-ai/dsh-experimental-skill-pack'
import { readPackArchive } from '@deepseek-ai/dsh-experimental-skill-pack/src/archive.ts'
import { DEFAULT_PACK_ARCHIVE_LIMITS } from '@deepseek-ai/dsh-experimental-skill-pack'
import { PackInstallError } from '@deepseek-ai/dsh-experimental-skill-pack'

const SET = { id: 'site-a', version: '1.2.0' }

/** A pack name of 255 UTF-8 bytes, all of it CJK. */
const LONGEST_NAME = '图'.repeat(85)

/** Packs whose names and paths sit at the edges both sides allow. */
const EDGE_PACKS: readonly DshpackPack[] = [
  {
    name: LONGEST_NAME,
    files: [
      { path: 'SKILL.md', content: `---\nname: ${LONGEST_NAME}\ndescription: 边缘\nmetadata:\n  pack:\n    version: 1.0.0\n    anchorFormat: ${String(ANCHOR_FORMAT)}\n---\n正文\n` },
      { path: `views/${'径'.repeat(83)}.yml`, content: 'id: v\n' },
      { path: 'a/b/c/d/图.PNG', content: new Uint8Array([137, 80, 78, 71]) },
      { path: 'ß.md', content: 'x' },
    ],
  },
  {
    name: 'pack.with-dots_and-dashes',
    files: [
      { path: 'SKILL.md', content: '---\nname: p\ndescription: d\nmetadata:\n  pack:\n    version: 2.0.0\n---\n' },
      { path: 'notes/z.yaml', content: 'a: 1\n' },
      { path: 'notes/Z.jpeg', content: new Uint8Array([255, 216]) },
    ],
  },
]

describe('the anchor formats', () => {
  it('a pack may state are the ones point-anchor reads', () => {
    expect([...PACK_ANCHOR_FORMATS]).toEqual([...ANCHOR_FORMATS_READ])
    expect(PACK_ANCHOR_FORMATS).toContain(ANCHOR_FORMAT)
  })

  it('are read from the metadata path point-anchor writes them under', () => {
    expect(PACK_MANIFEST_FIELDS.map(field => field.path)).toContain(ANCHOR_FORMAT_METADATA_PATH.join('.'))
    const [outer, inner] = ANCHOR_FORMAT_METADATA_PATH
    const stated = parsePackManifest({ [outer]: { version: '1.0.0', [inner]: ANCHOR_FORMAT } })
    expect(stated.ok && stated.manifest.pack.anchorFormat).toBe(ANCHOR_FORMAT)
  })
})

describe('an archive point-anchor writes', () => {
  it('is the archive skill-pack writes for the same packs, and skill-pack reads it back whole', async () => {
    const written = await writeDshpack(EDGE_PACKS, SET)
    expect(Buffer.from(written).equals(Buffer.from(await buildPackArchive({ kind: 'packs', packs: EDGE_PACKS }, SET)))).toBe(true)
    const read = readPackArchive('edge.dshpack', written, DEFAULT_PACK_ARCHIVE_LIMITS)
    expect(read.set).toEqual(SET)
    const files = (packs: readonly DshpackPack[]) => packs.flatMap(pack => pack.files.map(file => `${pack.name}/${file.path}`)).sort()
    expect(files(read.packs)).toEqual(files(EDGE_PACKS))
  })

  it('is read under the limits point-anchor writes against', () => {
    expect({ ...DSHPACK_DEFAULT_LIMITS }).toEqual({ ...DEFAULT_PACK_ARCHIVE_LIMITS })
    expect([...WRITER_EXTENSIONS].sort()).toEqual([...PACK_FILE_EXTENSIONS].sort())
  })

  it.each([
    ['a pack name of 256 UTF-8 bytes', [{ name: `${LONGEST_NAME}a`, files: [{ path: 'SKILL.md', content: 'x' }] }]],
    ['a pack name holding a slash', [{ name: 'a/b', files: [{ path: 'SKILL.md', content: 'x' }] }]],
    ['a path leaving its pack', [{ name: 'p', files: [{ path: '../x.md', content: 'x' }] }]],
    ['a code file', [{ name: 'p', files: [{ path: 'run.js', content: 'x' }] }]],
    ['two paths one once folded', [{ name: 'p', files: [{ path: 'ss.md', content: 'x' }, { path: 'ß.md', content: 'y' }] }]],
    ['two pack names one once folded', [{ name: 'P', files: [{ path: 'a.md', content: 'x' }] }, { name: 'p', files: [{ path: 'b.md', content: 'y' }] }]],
    ['a path segment of 256 UTF-8 bytes', [{ name: 'p', files: [{ path: `${'径'.repeat(84)}abcd.md`, content: 'x' }] }]],
    ['a file and a directory one once folded', [{ name: 'p', files: [{ path: 'a.md', content: 'x' }, { path: 'A.md/b.md', content: 'y' }] }]],
  ] as const)('is refused by both writers for %s', async (_name, packs) => {
    await expect(writeDshpack(packs, SET)).rejects.toBeInstanceOf(DshpackError)
    await expect(buildPackArchive({ kind: 'packs', packs }, SET)).rejects.toBeInstanceOf(PackInstallError)
  })

  it('is never written with a backslash in a pack name or a path, which skill-pack refuses only on a host that separates paths with one', async () => {
    for (const packs of [[{ name: 'a\\b', files: [{ path: 'SKILL.md', content: 'x' }] }], [{ name: 'p', files: [{ path: 'a\\b.md', content: 'x' }] }]]) {
      await expect(writeDshpack(packs, SET)).rejects.toBeInstanceOf(DshpackError)
    }
  })
})
