/**
 * The packed file a delivery hands over: what writing one twice produces, what
 * reading one gives back, and every way an archive is refused before a
 * deployment holds anything it carried.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Zip, ZipPassThrough, unzipSync, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildPackArchive,
  PACK_ARCHIVE_FORMAT,
  PACK_ARCHIVE_MANIFEST,
  readPackArchive,
} from '../src/archive.ts'
import type { DeliveredPack, PackArchiveLimits } from '../src/types.ts'

const LIMITS: PackArchiveLimits = { maxArchiveBytes: 1_000_000, maxFileBytes: 100_000, maxFiles: 50 }

const SET = { id: 'space-console', version: '2026.9.19' }

const encoder = new TextEncoder()

let world: string | undefined

afterEach(async () => {
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

function bytes(text: string): Uint8Array {
  return encoder.encode(text)
}

function digest(text: string): string {
  return createHash('sha256').update(bytes(text)).digest('hex')
}

function pack(name: string, body: string): DeliveredPack {
  return {
    name,
    files: [
      { path: 'SKILL.md', content: `---\nname: ${name}\ndescription: d\n---\n${body}` },
      { path: 'views/v.yml', content: 'id: v\ntitle: V\nspec: []\n' },
    ],
  }
}

/** One archive assembled entry by entry, so a manifest can disagree with what is beside it. */
function archiveOf(manifest: unknown, files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = { [PACK_ARCHIVE_MANIFEST]: bytes(JSON.stringify(manifest)) }
  for (const [path, content] of Object.entries(files)) entries[path] = bytes(content)
  return zipSync(entries)
}

/** The manifest a one-file set states, with the digest that file actually has. */
function manifestFor(path: string, content: string): unknown {
  return { format: PACK_ARCHIVE_FORMAT, set: SET, files: [{ path, sha256: digest(content) }] }
}

describe('writing an archive', () => {
  it('gives back the packs it was written from, and the set it was written under', async () => {
    const written = await buildPackArchive({ kind: 'packs', packs: [pack('a', 'A.'), pack('b', 'B.')] }, SET)
    const read = readPackArchive('delivery.dshpack', written, LIMITS)
    expect(read.set).toEqual(SET)
    expect(read.packs.map(({ name }) => name)).toEqual(['a', 'b'])
    expect(read.packs[0]?.files.map(file => file.path)).toEqual(['SKILL.md', 'views/v.yml'])
    expect(new TextDecoder().decode(read.packs[0]?.files[0]?.content as Uint8Array)).toContain('A.')
  })

  it('writes the same bytes for the same packs, whatever order they arrive in', async () => {
    const once = await buildPackArchive({ kind: 'packs', packs: [pack('a', 'A.'), pack('b', 'B.')] }, SET)
    const again = await buildPackArchive({ kind: 'packs', packs: [pack('b', 'B.'), pack('a', 'A.')] }, SET)
    expect(Buffer.from(again)).toEqual(Buffer.from(once))
  })

  it('writes what a source directory holds, manifest first and files in path order', async () => {
    world = await mkdtemp(join(tmpdir(), 'dsh-skill-pack-archive-'))
    const source = join(world, 'delivery')
    await mkdir(join(source, 'a', 'views'), { recursive: true })
    await writeFile(join(source, 'a', 'SKILL.md'), '---\nname: a\ndescription: d\n---\nA.')
    await writeFile(join(source, 'a', 'views', 'v.yml'), 'id: v\ntitle: V\nspec: []\n')
    const written = await buildPackArchive({ kind: 'directory', path: source }, SET)
    expect(Object.keys(unzipSync(written)))
      .toEqual([PACK_ARCHIVE_MANIFEST, 'packs/a/SKILL.md', 'packs/a/views/v.yml'])
    expect(readPackArchive('delivery.dshpack', written, LIMITS).packs.map(({ name }) => name)).toEqual(['a'])
  })

  it('refuses to write a pack that carries a file a pack may not carry', async () => {
    await expect(buildPackArchive({ kind: 'packs', packs: [{ name: 'a', files: [{ path: 'setup.js', content: 'x' }] }] }, SET))
      .rejects.toMatchObject({ refusal: 'code-file', entry: 'a/setup.js' })
  })

  it('refuses to write one pack twice, or one path twice inside a pack', async () => {
    await expect(buildPackArchive({ kind: 'packs', packs: [pack('a', 'A.'), pack('a', 'again.')] }, SET))
      .rejects.toMatchObject({ refusal: 'duplicate-entry', entry: 'a' })
    await expect(buildPackArchive({
      kind: 'packs',
      packs: [{ name: 'a', files: [{ path: 'SKILL.md', content: 'x' }, { path: 'SKILL.md', content: 'y' }] }],
    }, SET)).rejects.toMatchObject({ refusal: 'duplicate-entry', entry: 'a/SKILL.md' })
  })
})

describe('reading an archive', () => {
  it('refuses bytes that are not an archive at all', () => {
    expect(() => readPackArchive('delivery.dshpack', bytes('not an archive'), LIMITS))
      .toThrow(expect.objectContaining({ refusal: 'archive-unreadable', entry: 'delivery.dshpack' }))
  })

  it('refuses an archive carrying no manifest', () => {
    const written = zipSync({ 'packs/a/SKILL.md': bytes('A.') })
    expect(() => readPackArchive('delivery.dshpack', written, LIMITS))
      .toThrow(expect.objectContaining({ refusal: 'archive-manifest', entry: 'delivery.dshpack' }))
  })

  it('refuses a manifest that is not JSON, and one that is not a manifest object', () => {
    for (const raw of ['{', '[]', '"a set"']) {
      const written = zipSync({ [PACK_ARCHIVE_MANIFEST]: bytes(raw) })
      expect(() => readPackArchive('delivery.dshpack', written, LIMITS))
        .toThrow(expect.objectContaining({ refusal: 'archive-manifest' }))
    }
  })

  it('refuses a format version this build does not know, and a manifest that states none', () => {
    for (const format of [PACK_ARCHIVE_FORMAT + 1, undefined]) {
      const written = archiveOf({ format, set: SET, files: [] }, {})
      expect(() => readPackArchive('delivery.dshpack', written, LIMITS))
        .toThrow(expect.objectContaining({ refusal: 'archive-format', entry: PACK_ARCHIVE_MANIFEST }))
    }
  })

  it('refuses a manifest field the format does not allow, naming the field', () => {
    const written = archiveOf({ format: PACK_ARCHIVE_FORMAT, set: { id: 'a' }, files: [] }, {})
    expect(() => readPackArchive('delivery.dshpack', written, LIMITS))
      .toThrow(expect.objectContaining({ refusal: 'archive-manifest', entry: `${PACK_ARCHIVE_MANIFEST}.set.version` }))
  })

  it('refuses a digest that is not a SHA-256 digest, and bytes that are not the ones it states', () => {
    const shaped = archiveOf(
      { format: PACK_ARCHIVE_FORMAT, set: SET, files: [{ path: 'a/SKILL.md', sha256: 'nope' }] },
      { 'packs/a/SKILL.md': 'A.' },
    )
    expect(() => readPackArchive('delivery.dshpack', shaped, LIMITS))
      .toThrow(expect.objectContaining({ refusal: 'archive-manifest', entry: `${PACK_ARCHIVE_MANIFEST}.files.0.sha256` }))

    const tampered = archiveOf(manifestFor('a/SKILL.md', 'A.'), { 'packs/a/SKILL.md': 'edited on the box' })
    expect(() => readPackArchive('delivery.dshpack', tampered, LIMITS))
      .toThrow(expect.objectContaining({ refusal: 'archive-digest', entry: 'a/SKILL.md' }))
  })

  it('refuses an archive that disagrees with its manifest about which entries exist', () => {
    const missing = archiveOf(manifestFor('a/SKILL.md', 'A.'), {})
    expect(() => readPackArchive('delivery.dshpack', missing, LIMITS))
      .toThrow(expect.objectContaining({ refusal: 'archive-entry', entry: 'a/SKILL.md' }))

    const extra = archiveOf(manifestFor('a/SKILL.md', 'A.'), { 'packs/a/SKILL.md': 'A.', 'packs/a/notes.md': 'loose' })
    expect(() => readPackArchive('delivery.dshpack', extra, LIMITS))
      .toThrow(expect.objectContaining({ refusal: 'archive-entry', entry: 'packs/a/notes.md' }))

    const directoryEntry = zipSync({
      [PACK_ARCHIVE_MANIFEST]: bytes(JSON.stringify(manifestFor('a/SKILL.md', 'A.'))),
      'packs/a/': bytes(''),
      'packs/a/SKILL.md': bytes('A.'),
    })
    expect(() => readPackArchive('delivery.dshpack', directoryEntry, LIMITS))
      .toThrow(expect.objectContaining({ refusal: 'archive-entry', entry: 'packs/a/' }))
  })

  it('refuses a manifest that declares one path twice', () => {
    const written = archiveOf(
      { format: PACK_ARCHIVE_FORMAT, set: SET, files: [{ path: 'a/SKILL.md', sha256: digest('A.') }, { path: 'a/SKILL.md', sha256: digest('A.') }] },
      { 'packs/a/SKILL.md': 'A.' },
    )
    expect(() => readPackArchive('delivery.dshpack', written, LIMITS))
      .toThrow(expect.objectContaining({ refusal: 'duplicate-entry', entry: 'a/SKILL.md' }))
  })

  it('refuses an archive that carries one entry name twice', () => {
    const chunks: Uint8Array[] = []
    const zip = new Zip((error, data) => {
      /* v8 ignore next -- fflate reports an error only from a compressor this archive does not use. */
      if (error !== null) throw error
      chunks.push(data)
    })
    for (const [name, content] of [
      [PACK_ARCHIVE_MANIFEST, JSON.stringify(manifestFor('a/SKILL.md', 'A.'))],
      ['packs/a/SKILL.md', 'A.'],
      ['packs/a/SKILL.md', 'the other one'],
    ] as const) {
      const entry = new ZipPassThrough(name)
      zip.add(entry)
      entry.push(bytes(content), true)
    }
    zip.end()
    expect(() => readPackArchive('delivery.dshpack', Buffer.concat(chunks), LIMITS))
      .toThrow(expect.objectContaining({ refusal: 'duplicate-entry', entry: 'delivery.dshpack' }))
  })

  it('refuses a declared path that names no pack directory', () => {
    for (const path of ['SKILL.md', 'a/']) {
      const written = archiveOf(manifestFor(path, 'A.'), { [`packs/${path}`]: 'A.' })
      expect(() => readPackArchive('delivery.dshpack', written, LIMITS))
        .toThrow(expect.objectContaining({ refusal: 'path-escape', entry: path }))
    }
  })

  it('refuses an archive, a file or an entry count over the limits it is read under', async () => {
    const written = await buildPackArchive({ kind: 'packs', packs: [pack('a', 'A.'), pack('b', 'B.')] }, SET)
    expect(() => readPackArchive('delivery.dshpack', written, { ...LIMITS, maxArchiveBytes: 10 }))
      .toThrow(expect.objectContaining({ refusal: 'archive-oversize', entry: 'delivery.dshpack' }))
    expect(() => readPackArchive('delivery.dshpack', written, { ...LIMITS, maxFiles: 2 }))
      .toThrow(expect.objectContaining({ refusal: 'archive-oversize', entry: 'delivery.dshpack' }))
    expect(() => readPackArchive('delivery.dshpack', written, { ...LIMITS, maxFileBytes: 8 }))
      .toThrow(expect.objectContaining({ refusal: 'archive-oversize', entry: PACK_ARCHIVE_MANIFEST }))
  })
})
