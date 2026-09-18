/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the skill registry, the web server and this package
 * over a real pack root, and every assertion reads what the composition
 * actually offers — the merged skill catalog a model-facing consumer reads,
 * the body a load returns, the status route, the views of the active packs,
 * and what all four answer as the parts source arrives and goes away.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SkillRegistry, { isModelInvocable, isUserInvocable } from '@deepseek-ai/dsh-skill'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import SkillPackRegistry, { SKILL_PACK_STATUS_ROUTE } from '../src/index.ts'
import type { PackStatusDocument, ProvidedPart } from '../src/types.ts'

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

  /** Register or withdraw parts without remounting, the way a component plugin's catalog changes. */
  replace(parts: readonly ProvidedPart[]): void {
    this.parts = parts
    for (const listener of this.listeners) listener()
  }
}

let world: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

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
  await writeFile(join(directory, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${name} description.`,
    ...whenToUse === undefined ? [] : [`whenToUse: ${whenToUse}`],
    'metadata:',
    metadata,
    '---',
    `Instructions for ${name}.`,
    '',
  ].join('\n'))
  for (const [file, body] of Object.entries(views)) await writeFile(join(directory, 'views', file), body)
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

  const configPath = join(world, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-skill'",
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-experimental-skill-pack'",
    '  config:',
    `    root: ${JSON.stringify(root)}`,
    `    platformVersion: '${PLATFORM_VERSION}'`,
    `    watch: ${String(watch)}`,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(world).href + '/'
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
  return { ctx: context, root }
}

/** Read the status route the composition serves. */
async function fetchStatus(ctx: Context, method = 'GET'): Promise<Response> {
  return await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${SKILL_PACK_STATUS_ROUTE}`, { method })
}

/** Poll the merged catalog until it holds the expected names, so a watch event has somewhere to arrive. */
async function catalogSettlesOn(ctx: Context, expected: string[]): Promise<string[]> {
  const deadline = Date.now() + 10_000
  let names: string[] = []
  while (Date.now() < deadline) {
    names = (await ctx.skills.list()).map(skill => skill.name)
    if (names.length === expected.length && expected.every(name => names.includes(name))) return names
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return names
}

describe('a pack root whose parts nothing has registered', () => {
  it('offers the model and the user nothing about the pack that is waiting', async () => {
    const { ctx } = await loadComposition()
    const catalog = await ctx.skills.list()
    expect(catalog.map(skill => skill.name)).toEqual(['plain-note'])
    expect(catalog.filter(isModelInvocable).map(skill => skill.name)).toEqual(['plain-note'])
    expect(catalog.filter(isUserInvocable).map(skill => skill.name)).toEqual(['plain-note'])
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
