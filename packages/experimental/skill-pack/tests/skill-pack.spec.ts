/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the skill registry, the web server and this package
 * over a real pack root, and every assertion reads what the composition
 * actually offers — the merged skill catalog a model-facing consumer reads,
 * the body a load returns, the status route, the views of the active packs,
 * and what all four answer as the parts source arrives and goes away.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Logger, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SkillRegistry, { isModelInvocable, isUserInvocable } from '@deepseek-ai/dsh-skill'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import { PACK_ARCHIVE_MANIFEST } from '../src/archive.ts'
import SkillPackRegistry, { buildPackArchive, SKILL_PACK_STATUS_ROUTE } from '../src/index.ts'
import type {
  DeliveredPack,
  PackStatusDocument,
  PackView,
  PackViewRefusal,
  ProvidedPart,
} from '../src/types.ts'

const PLATFORM_VERSION = '0.5.2'
const KIT = '@deepseek-ai/dsh-experimental-component-kit'
const CRUD: ProvidedPart = { id: 'toy.crud', plugin: KIT, version: '0.4.0' }

/** A parts source standing in for the component catalog's registered parts. */
class TestParts extends Service {
  private readonly listeners = new Set<() => void>()
  private parts: readonly ProvidedPart[]

  constructor(ctx: Context, config: { parts: readonly ProvidedPart[] }) {
    super(ctx, 'skillPackParts')
    this.parts = config.parts
  }

  list(): readonly ProvidedPart[] {
    return this.parts
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Every view this stand-in refuses, by the id the view declares. */
  refused = new Set<string>()

  judgeView(view: PackView): PackViewRefusal | undefined {
    return this.refused.has(view.id) ? { path: 'spec.nodes[0].component', reason: 'names no component of this deployment' } : undefined
  }

  /** Register or withdraw parts without remounting, the way a component plugin's catalog changes. */
  replace(parts: readonly ProvidedPart[]): void {
    this.parts = parts
    for (const listener of this.listeners) listener()
  }
}

let world: string | undefined
let context: Context | undefined

/** Every withholding report the composition wrote, with the level it was written at. */
let logLines: { type: string; text: string }[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
  logLines = []
})

/** The withholding reports written at one level, in order. */
function reportsAt(type: string): string[] {
  return logLines.filter(line => line.type === type && line.text.includes('withholding')).map(line => line.text)
}

/** One pack's SKILL.md: the frontmatter a pack is read from, the manifest inside it, and the instructions. */
function skillText(name: string, metadata: string, whenToUse?: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${name} description.`,
    ...whenToUse === undefined ? [] : [`whenToUse: ${whenToUse}`],
    'metadata:',
    metadata,
    '---',
    `Instructions for ${name}.`,
    '',
  ].join('\n')
}

/** Write one pack into a root: a SKILL.md carrying the manifest, and the views it declares. */
async function writePack(
  root: string,
  name: string,
  metadata: string,
  views: Record<string, string> = {},
  whenToUse?: string,
): Promise<void> {
  const directory = join(root, name)
  await mkdir(join(directory, 'views'), { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), skillText(name, metadata, whenToUse))
  for (const [file, body] of Object.entries(views)) await writeFile(join(directory, 'views', file), body)
}

/** The same pack as a delivery carries it, for an archive rather than for a root. */
function deliveredPack(name: string, metadata: string, views: Record<string, string> = {}): DeliveredPack {
  return {
    name,
    files: [
      { path: 'SKILL.md', content: skillText(name, metadata) },
      ...Object.entries(views).map(([file, body]) => ({ path: `views/${file}`, content: body })),
    ],
  }
}

/**
 * Boot the skill registry, the web server and this package over a freshly
 * written pack root.
 * @param watch - whether the row watches the pack root.
 * @param broken - whether the root also holds a pack whose manifest never parses, which is the pack that can never become active.
 */
async function loadComposition(watch = false, broken = true): Promise<{ ctx: Context; root: string }> {
  world = await mkdtemp(join(tmpdir(), 'dsh-skill-pack-'))
  const root = join(world, 'packs')
  await writePack(root, 'space-data-page', [
    '  pack:',
    '    version: 1.0.0',
    '    platform: ">=0.5.0"',
    '  requires:',
    '    components:',
    `      "${KIT}": ">=0.4.0"`,
    '    parts: [toy.crud]',
    '  views: [views/space-layer.yml]',
  ].join('\n'), { 'space-layer.yml': 'id: space-layer\ntitle: 图层数据\nspec: []\nparams:\n  relatedMeta: sys_layer\n' })
  await writePack(root, 'plain-note', '  pack:\n    version: 2.0.0', {}, 'When the user asks for the note.')
  if (broken) await writePack(root, 'broken-pack', '  pack:\n    version: one')

  return { ctx: await boot(skillPackRow(root, watch)), root }
}

/** The plugin row this package is mounted through, with the pack-root config every composition here gives it. */
function skillPackRow(root: string, watch: boolean, deliveries: string[] = []): string[] {
  return [
    "- name: '@deepseek-ai/dsh-experimental-skill-pack'",
    '  config:',
    `    root: ${JSON.stringify(root)}`,
    `    platformVersion: '${PLATFORM_VERSION}'`,
    `    watch: ${String(watch)}`,
    ...deliveries,
  ]
}

/** Boot the skill registry, the web server and the given rows through the Loader, over the test world. */
async function boot(rows: string[]): Promise<Context> {
  const configPath = join(world!, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-skill'",
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    ...rows,
    '',
  ].join('\n'))

  context = new Context()
  context.logger.exporter({
    export: (message) => { logLines.push({ type: message.type, text: Logger.format({ export() {} }, message) }) },
  })
  context.baseUrl = pathToFileURL(world!).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-skill', SkillRegistry],
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-experimental-skill-pack', SkillPackRegistry],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

/** Read the status route the composition serves. */
async function fetchStatus(ctx: Context, method = 'GET'): Promise<Response> {
  return await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${SKILL_PACK_STATUS_ROUTE}`, { method })
}

/** Poll the merged catalog until it holds the expected names, so a watch event has somewhere to arrive. */
async function catalogSettlesOn(ctx: Context, expected: string[]): Promise<string[]> {
  return await settlesOn(
    async () => (await ctx.skills.list()).map(skill => skill.name),
    names => names.length === expected.length && expected.every(name => names.includes(name)),
  )
}

/** Poll one read until it answers what the caller is waiting for, or give up and let the assertion say what it found. */
async function settlesOn<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000
  let value = await read()
  while (Date.now() < deadline && !done(value)) {
    await new Promise(resolve => setTimeout(resolve, 50))
    value = await read()
  }
  return value
}

/** Poll the process log until a line carries the fragment; the assertion reads the lines it found. */
async function logSettlesOn(fragment: string): Promise<string[]> {
  return await settlesOn(
    () => Promise.resolve(logLines.map(line => `${line.type} ${line.text}`)),
    lines => lines.some(line => line.includes(fragment)),
  )
}

/** Boot a composition whose pack root is empty and whose packs arrive as one archive in a delivery directory. */
async function loadDeliveryComposition(limits: string[] = []): Promise<{ ctx: Context; root: string; deliveries: string }> {
  world = await mkdtemp(join(tmpdir(), 'dsh-skill-pack-'))
  const root = join(world, 'packs')
  const deliveries = join(world, 'deliveries')
  await mkdir(deliveries, { recursive: true })
  const ctx = await boot(skillPackRow(root, false, [
    '    deliveries:',
    `      directory: ${JSON.stringify(deliveries)}`,
    ...limits,
  ]))
  return { ctx, root, deliveries }
}

/** Replace whatever the delivery directory held with one archive, the way ops hands a deployment its packs. */
async function deliver(directory: string, name: string, packs: DeliveredPack[], version = '1.0.0'): Promise<void> {
  for (const stale of await readdir(directory)) await rm(join(directory, stale))
  await writeFile(join(directory, name), await buildPackArchive({ kind: 'packs', packs }, { id: 'space-console', version }))
}

/** The two packs every delivery test starts from: one that needs a part, and one that needs nothing. */
function deliverySet(noteVersion = '2.0.0'): DeliveredPack[] {
  return [
    deliveredPack('plain-note', `  pack:\n    version: ${noteVersion}`),
    deliveredPack('space-data-page', [
      '  pack:',
      '    version: 1.0.0',
      '    platform: ">=0.5.0"',
      '  requires:',
      '    components:',
      `      "${KIT}": ">=0.4.0"`,
      '    parts: [toy.crud]',
      '  views: [views/space-layer.yml]',
    ].join('\n'), { 'space-layer.yml': 'id: space-layer\ntitle: 图层数据\nspec: []\nparams:\n  relatedMeta: sys_layer\n' }),
  ]
}

describe('a pack root whose parts nothing has registered', () => {
  it('offers the model and the user nothing about the pack that is waiting', async () => {
    const { ctx } = await loadComposition()
    const catalog = await ctx.skills.list()
    expect(catalog.map(skill => skill.name)).toEqual(['plain-note'])
    expect(catalog.filter(isModelInvocable).map(skill => skill.name)).toEqual(['plain-note'])
    expect(catalog.filter(isUserInvocable).map(skill => skill.name)).toEqual(['plain-note'])
    // A pack that activates by itself once its plugin is composed is an info
    // line: nothing here needs editing.
    expect(reportsAt('error')).toEqual([])
    expect(reportsAt('info')[0]).toContain(`space-data-page: ${KIT} >=0.4.0 is not installed`)
    expect(await ctx.skills.get('space-data-page')).toBeUndefined()
    expect(await ctx.skills.get('broken-pack')).toBeUndefined()
    expect(await ctx.skillPacks.activeViews()).toEqual([])
  })

  it('carries the pack\'s own routing guidance and version into the catalog it is offered in', async () => {
    const { ctx } = await loadComposition()
    const note = await ctx.skills.get('plain-note')
    expect(note).toMatchObject({
      name: 'plain-note',
      whenToUse: 'When the user asks for the note.',
      provider: 'skill-pack',
      metadata: { pack: { version: '2.0.0' } },
    })
    expect(note?.content.trim()).toBe('Instructions for plain-note.')
  })

  it('says on its own route which packs are held back and why', async () => {
    const { ctx } = await loadComposition()
    const response = await fetchStatus(ctx)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const document = await response.json() as PackStatusDocument
    expect(document.packs).toEqual([
      {
        skill: 'broken-pack',
        state: 'inactive',
        missing: [{
          kind: 'manifest-invalid',
          field: 'metadata.pack.version',
          reason: 'must be an exact semantic version',
        }],
      },
      { skill: 'plain-note', version: '2.0.0', state: 'active', missing: [] },
      {
        skill: 'space-data-page',
        version: '1.0.0',
        state: 'inactive',
        missing: [
          { kind: 'plugin-absent', plugin: KIT, range: '>=0.4.0' },
          { kind: 'part-absent', part: 'toy.crud' },
        ],
      },
    ])
  })

  it('answers a method it does not serve with the complete set it does', async () => {
    const { ctx } = await loadComposition()
    const response = await fetchStatus(ctx, 'POST')
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
  })
})

describe('a parts source arriving and going away', () => {
  it('offers the pack once its parts are registered and takes it back when they are withdrawn', async () => {
    const { ctx } = await loadComposition(false, false)
    await ctx.plugin(TestParts, { parts: [CRUD] })
    const parts = ctx.skillPackParts as TestParts

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['plain-note', 'space-data-page'])
    const loaded = await ctx.skills.get('space-data-page')
    expect(loaded?.content.trim()).toBe('Instructions for space-data-page.')
    expect(loaded?.metadata).toEqual({ pack: { version: '1.0.0', platform: '>=0.5.0' } })
    expect(await ctx.skillPacks.activeViews()).toEqual([
      { pack: 'space-data-page', id: 'space-layer', title: '图层数据', spec: [], params: { relatedMeta: 'sys_layer' } },
    ])

    parts.replace([])
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['plain-note'])
    expect(await ctx.skills.get('space-data-page')).toBeUndefined()

    parts.replace([CRUD])
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['plain-note', 'space-data-page'])
  })

  it('withholds a pack whose view the surface refuses, and says which file and which value', async () => {
    const { ctx } = await loadComposition(false, false)
    await ctx.plugin(TestParts, { parts: [CRUD] })
    const parts = ctx.skillPackParts as TestParts
    parts.refused.add('space-layer')
    parts.replace([CRUD])

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['plain-note'])
    expect((await ctx.skillPacks.statuses()).find(status => status.skill === 'space-data-page')).toEqual({
      skill: 'space-data-page',
      version: '1.0.0',
      state: 'inactive',
      missing: [{
        kind: 'view-refused',
        view: 'views/space-layer.yml',
        path: 'spec.nodes[0].component',
        reason: 'names no component of this deployment',
      }],
    })
    // Nothing of a withheld pack is offered, its views included.
    expect(await ctx.skillPacks.activeViews()).toEqual([])
    // A pack nobody can activate by installing anything is an error line, not
    // the info line a pack waiting for a plugin gets.
    expect(reportsAt('error').filter(text => text.includes('space-data-page'))).toHaveLength(1)
    expect(reportsAt('error')[0]).toContain('view views/space-layer.yml cannot be drawn: names no component of this deployment')
  })

  it('tells a watcher when the pack set moves, and stops when the watch is given up', async () => {
    const { ctx } = await loadComposition(false, false)
    let changes = 0
    const stop = ctx.skillPacks.onChange(() => { changes += 1 })
    await ctx.plugin(TestParts, { parts: [CRUD] })
    const parts = ctx.skillPackParts as TestParts
    expect(changes).toBeGreaterThan(0)
    const mounted = changes
    parts.replace([])
    expect(changes).toBe(mounted + 1)
    stop()
    parts.replace([CRUD])
    expect(changes).toBe(mounted + 1)
  })

  it('takes the pack back when the parts source itself is disposed', async () => {
    const { ctx } = await loadComposition(false, false)
    const partsFiber = await ctx.plugin(TestParts, { parts: [CRUD] })
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['plain-note', 'space-data-page'])
    await partsFiber.dispose()
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['plain-note'])
  })
})

describe('the pack root changing under a running composition', () => {
  it('refuses to load a pack the root no longer offers, even from a catalog that still lists it', async () => {
    const { ctx, root } = await loadComposition()
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['plain-note'])
    // An unwatched root goes out of date without invalidating the catalog, so
    // the load runs against a selection the root has already moved past.
    await rm(join(root, 'plain-note'), { recursive: true })
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['plain-note'])
    expect(await ctx.skills.get('plain-note')).toBeUndefined()
  })

  it('offers a pack that arrives in a watched root without a restart', async () => {
    const { ctx, root } = await loadComposition(true)
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['plain-note'])
    await writePack(root, 'late-note', '  pack:\n    version: 3.0.0')
    expect(await catalogSettlesOn(ctx, ['late-note', 'plain-note'])).toEqual(['late-note', 'plain-note'])
  })
})

describe('a delivery archive copied into the delivery directory', () => {
  it('installs the set it carries and withholds the pack whose part nothing registers', async () => {
    const { ctx, deliveries } = await loadDeliveryComposition()
    await deliver(deliveries, 'set.dshpack', deliverySet())

    expect(await catalogSettlesOn(ctx, ['plain-note'])).toEqual(['plain-note'])
    expect(await ctx.skillPacks.statuses()).toEqual([
      { skill: 'plain-note', version: '2.0.0', state: 'active', missing: [] },
      {
        skill: 'space-data-page',
        version: '1.0.0',
        state: 'inactive',
        missing: [
          { kind: 'plugin-absent', plugin: KIT, range: '>=0.4.0' },
          { kind: 'part-absent', part: 'toy.crud' },
        ],
      },
    ])
    // The delivered pack is installed and its view file is readable; nothing
    // about it is offered, the view included, until its part is registered.
    expect(await ctx.skillPacks.activeViews()).toEqual([])
    expect(await logSettlesOn(
      'installed space-console 1.0.0 from set.dshpack: packs [plain-note, space-data-page], retired []',
    )).toEqual(expect.arrayContaining([expect.stringContaining('info')]))

    await ctx.plugin(TestParts, { parts: [CRUD] })
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['plain-note', 'space-data-page'])
    expect(await ctx.skillPacks.activeViews()).toEqual([
      { pack: 'space-data-page', id: 'space-layer', title: '图层数据', spec: [], params: { relatedMeta: 'sys_layer' } },
    ])
  })

  it('adds and replaces a pack on an upgrade, and takes one away on a downgrade', async () => {
    const { ctx, deliveries, root } = await loadDeliveryComposition()
    await deliver(deliveries, 'v1.dshpack', deliverySet())
    expect(await catalogSettlesOn(ctx, ['plain-note'])).toEqual(['plain-note'])

    await deliver(deliveries, 'v2.dshpack', [
      ...deliverySet('2.1.0'),
      deliveredPack('late-note', '  pack:\n    version: 3.0.0'),
    ], '2.0.0')
    expect(await catalogSettlesOn(ctx, ['late-note', 'plain-note'])).toEqual(['late-note', 'plain-note'])
    expect((await ctx.skills.get('plain-note'))?.metadata).toEqual({ pack: { version: '2.1.0' } })

    await deliver(deliveries, 'v1.dshpack', [deliveredPack('plain-note', '  pack:\n    version: 2.0.0')])
    expect(await catalogSettlesOn(ctx, ['plain-note'])).toEqual(['plain-note'])
    expect(await readdir(root)).toEqual(['plain-note'])
    expect(await logSettlesOn('retired [late-note, space-data-page]'))
      .toEqual(expect.arrayContaining([expect.stringContaining('info')]))
  })

  it('installs nothing while the directory holds two archives, because one of them is not the delivery', async () => {
    const { ctx, deliveries, root } = await loadDeliveryComposition()
    await deliver(deliveries, 'v1.dshpack', [deliveredPack('plain-note', '  pack:\n    version: 2.0.0')])
    expect(await catalogSettlesOn(ctx, ['plain-note'])).toEqual(['plain-note'])

    await writeFile(
      join(deliveries, 'v2.dshpack'),
      await buildPackArchive({ kind: 'packs', packs: deliverySet() }, { id: 'space-console', version: '2.0.0' }),
    )
    expect(await logSettlesOn('holds 2 archives (v1.dshpack, v2.dshpack)'))
      .toEqual(expect.arrayContaining([expect.stringContaining('error')]))
    expect(await readdir(root)).toEqual(['plain-note'])
  })

  it('leaves the root as it was when the archive does not verify against its own manifest', async () => {
    const { ctx, deliveries, root } = await loadDeliveryComposition()
    await deliver(deliveries, 'v1.dshpack', [deliveredPack('plain-note', '  pack:\n    version: 2.0.0')])
    expect(await catalogSettlesOn(ctx, ['plain-note'])).toEqual(['plain-note'])

    for (const stale of await readdir(deliveries)) await rm(join(deliveries, stale))
    await writeFile(join(deliveries, 'v2.dshpack'), Buffer.from(zipSync({
      [PACK_ARCHIVE_MANIFEST]: Buffer.from(JSON.stringify({
        format: 1,
        set: { id: 'space-console', version: '2.0.0' },
        files: [{ path: 'late-note/SKILL.md', sha256: createHash('sha256').update('signed').digest('hex') }],
      })),
      'packs/late-note/SKILL.md': Buffer.from('edited between the console and the box'),
    })))
    expect(await logSettlesOn('v2.dshpack was not installed'))
      .toEqual(expect.arrayContaining([expect.stringContaining('error')]))
    expect(await readdir(root)).toEqual(['plain-note'])
  })

  it('refuses an archive larger than the size this deployment reads one under', async () => {
    const { deliveries, root } = await loadDeliveryComposition(['      maxArchiveBytes: 64'])
    await deliver(deliveries, 'v1.dshpack', deliverySet())
    expect(await logSettlesOn('over the 64 it is read under'))
      .toEqual(expect.arrayContaining([expect.stringContaining('error')]))
    await expect(readdir(root)).rejects.toThrow()
  })

  it('stops watching the delivery directory when its own fiber is disposed', async () => {
    world = await mkdtemp(join(tmpdir(), 'dsh-skill-pack-'))
    const root = join(world, 'packs')
    const deliveries = join(world, 'deliveries')
    await mkdir(deliveries, { recursive: true })
    context = new Context()
    await context.plugin(SkillRegistry)
    const fiber = await context.plugin(SkillPackRegistry, {
      root,
      platformVersion: PLATFORM_VERSION,
      watch: false,
      deliveries: { directory: deliveries, maxArchiveBytes: 1_000_000, maxFileBytes: 100_000, maxFiles: 50 },
    })
    await deliver(deliveries, 'v1.dshpack', [deliveredPack('plain-note', '  pack:\n    version: 2.0.0')])
    expect(await catalogSettlesOn(context, ['plain-note'])).toEqual(['plain-note'])

    await fiber.dispose()
    await deliver(deliveries, 'v2.dshpack', [deliveredPack('late-note', '  pack:\n    version: 3.0.0')])
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(await readdir(root)).toEqual(['plain-note'])
    expect(await context.skills.list()).toEqual([])
  })

  it('refuses a delivery directory that is not an absolute path', () => {
    context = new Context()
    expect(() => new SkillPackRegistry(context!, {
      root: join(tmpdir(), 'packs'),
      platformVersion: PLATFORM_VERSION,
      deliveries: { directory: 'deliveries', maxArchiveBytes: 1, maxFileBytes: 1, maxFiles: 1 },
    })).toThrow('skill-pack: deliveries.directory must be an absolute path, received "deliveries"')
  })
})

describe('disposal and configuration', () => {
  it('withdraws every pack it contributed when its own fiber is disposed', async () => {
    world = await mkdtemp(join(tmpdir(), 'dsh-skill-pack-'))
    const root = join(world, 'packs')
    await writePack(root, 'plain-note', '  pack:\n    version: 2.0.0')
    context = new Context()
    await context.plugin(SkillRegistry)
    const fiber = await context.plugin(SkillPackRegistry, { root, platformVersion: PLATFORM_VERSION, watch: false })
    expect((await context.skills.list()).map(skill => skill.name)).toEqual(['plain-note'])
    await fiber.dispose()
    expect(await context.skills.list()).toEqual([])
  })

  it('refuses a root that is not absolute', () => {
    context = new Context()
    expect(() => new SkillPackRegistry(context!, { root: 'packs', platformVersion: PLATFORM_VERSION }))
      .toThrow('skill-pack: root must be an absolute path, received "packs"')
  })

  it('refuses a platform version that is not an exact one', () => {
    context = new Context()
    expect(() => new SkillPackRegistry(context!, { root: join(tmpdir(), 'packs'), platformVersion: 'newest' }))
      .toThrow('skill-pack: platformVersion must be an exact semantic version, received "newest"')
  })
})
