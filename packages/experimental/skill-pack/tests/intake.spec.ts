/**
 * REAL-composition coverage for the organization intake: a test-only
 * cordis.yml booted through the vendored Loader mounts the skill registry and
 * this package with an organization root, a plugin standing in for the
 * organization plugin reads `skillPackIntake` from its own `inject` fiber, and
 * every assertion reads what the composition answers — `isActive`, the
 * statuses and views `ctx.skillPacks` reports, the skill catalog, and the
 * organization root on disk.
 *
 * The root write itself is the real `syncPackRoot`, and the read of the view
 * ids the root holds the real `readInstalledPacks`. A case that needs a call
 * to stop part-way holds the write behind a gate and waits for the write to
 * start, and the failure cases make the write or the read throw, through
 * `rootControl`, or make the organization root unreadable on disk.
 */

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Logger, Service, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SkillPackRegistry from '../src/index.ts'
import { readPackRoot } from '../src/scan.ts'
import type { DeliveredFile, IntakeResult, OrgPackInput, PackView, PackViewRefusal, ProvidedPart, SkillPackIntake } from '../src/types.ts'

/**
 * What the next root writes report as they start, what they wait for, and the
 * error they throw instead of writing; and the error a read of the
 * organization root throws instead of reading.
 */
const rootControl = vi.hoisted(() => ({
  writing: (): void => undefined,
  gate: undefined as Promise<void> | undefined,
  failure: undefined as Error | undefined,
  readFailure: undefined as Error | undefined,
}))

vi.mock('../src/install.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/install.ts')>()
  return {
    ...actual,
    async readInstalledPacks(...args: Parameters<typeof actual.readInstalledPacks>): ReturnType<typeof actual.readInstalledPacks> {
      if (rootControl.readFailure !== undefined) throw rootControl.readFailure
      return await actual.readInstalledPacks(...args)
    },
    async syncPackRoot(...args: Parameters<typeof actual.syncPackRoot>): ReturnType<typeof actual.syncPackRoot> {
      rootControl.writing()
      await rootControl.gate
      if (rootControl.failure !== undefined) throw rootControl.failure
      return await actual.syncPackRoot(...args)
    },
  }
})

/** Resolves once the next root write starts. */
function writeStarts(): Promise<void> {
  return new Promise((resolve) => { rootControl.writing = resolve })
}

const PLATFORM_VERSION = '0.5.2'
const KIT = '@deepseek-ai/dsh-experimental-component-kit'
const CRUD: ProvidedPart = { id: 'toy.data-page', plugin: KIT, version: '0.4.0' }

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

  /** Run while a view is judged, the way a surface's own judgement can reach back into the composition. */
  whileJudging: () => void = () => undefined

  judgeView(view: PackView): PackViewRefusal | undefined {
    this.whileJudging()
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

/** Every line the composition wrote, with the level it was written at. */
let logLines: string[] = []

afterEach(async () => {
  rootControl.writing = () => undefined
  rootControl.gate = undefined
  rootControl.failure = undefined
  rootControl.readFailure = undefined
  await context?.fiber.dispose()
  context = undefined
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
  logLines = []
})

/** The paths one test world holds. */
interface World {
  /** The pack root, which the row reads as the skill provider. */
  readonly root: string
  /** The organization root, which only the intake writes. */
  readonly organizationRoot: string
}

/** Create a fresh test world. */
async function newWorld(): Promise<World> {
  world = await mkdtemp(join(tmpdir(), 'dsh-skill-pack-intake-'))
  return { root: join(world, 'packs'), organizationRoot: join(world, 'organization', 'packs') }
}

/**
 * Boot the skill registry and this package through the Loader, over a world.
 * @param paths - the world's roots.
 * @param organization - whether the row configures its organization root.
 * @returns the booted context.
 */
async function boot(paths: World, organization = true): Promise<Context> {
  const configPath = join(world!, 'cordis.yml')
  const rows = [
    { name: '@deepseek-ai/dsh-skill' },
    {
      id: 'skill-pack',
      name: '@deepseek-ai/dsh-experimental-skill-pack',
      config: {
        root: paths.root,
        platformVersion: PLATFORM_VERSION,
        watch: false,
        ...organization ? { organizationRoot: paths.organizationRoot } : {},
      },
    },
  ]
  // JSON is YAML, so the rows are written as the documents they are.
  await writeFile(configPath, `${JSON.stringify(rows, null, 2)}\n`)
  const ctx = context = new Context()
  ctx.logger.exporter({
    export: (message) => { logLines.push(`${message.type} ${Logger.format({ export() {} }, message)}`) },
  })
  ctx.baseUrl = pathToFileURL(world!).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // Without a Node internal loader the Loader imports bare names through this
  // test runner's module graph, which resolves workspace packages to `src`.
  ctx.loader.internal = undefined
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

/** The skill-pack row's own fiber. */
function rowFiber(ctx: Context): Fiber {
  const fiber = [...ctx.loader.entries()].find(entry => entry.options.id === 'skill-pack')?.fiber
  if (fiber === undefined) throw new Error('the skill-pack row is not loaded')
  return fiber
}

/** A plugin standing in for the organization plugin: the intake it reads from its own `inject` fiber, and that fiber. */
interface Organization {
  readonly intake: SkillPackIntake
  readonly fiber: Fiber
}

/** Mount a stand-in for the organization plugin, which reads the intake the way that plugin does. */
async function organization(ctx: Context): Promise<Organization> {
  let intake: SkillPackIntake | undefined
  const fiber = ctx.inject(['skillPackIntake'], (scope: Context) => { intake = scope.skillPackIntake })
  await fiber
  if (intake === undefined) throw new Error('the organization intake is not provided')
  return { intake, fiber }
}

/** Mount the parts source, registering the parts given. */
async function mountParts(ctx: Context, parts: readonly ProvidedPart[] = [CRUD]): Promise<TestParts> {
  await ctx.plugin(TestParts, { parts })
  return ctx.skillPackParts as TestParts
}

/** What one entry carries, beyond its name, version and channel. */
interface EntryShape {
  /** The `metadata.pack.version` its SKILL.md states. */
  readonly packVersion?: string
  /** The skill name its SKILL.md frontmatter states, where it differs from the entry's. */
  readonly skill?: string
  /** Part ids it requires. */
  readonly parts?: readonly string[]
  /** The anchor format it states. */
  readonly anchorFormat?: number
  /** The view format it states; absent states `1` where it declares views. */
  readonly viewFormat?: number
  /** View file name under `views/` to its text. */
  readonly views?: Readonly<Record<string, string>>
  /** Further files, by pack-relative path. */
  readonly extra?: readonly DeliveredFile[]
  /** Whether each file is handed over as bytes rather than text. */
  readonly bytes?: boolean
}

/** One view file's text. */
function viewText(id: string, title: string): string {
  return `id: ${id}\ntitle: ${title}\nspec: []\nparams: {}\n`
}

/** One entry's SKILL.md. */
function skillText(name: string, shape: EntryShape): string {
  const views = Object.keys(shape.views ?? {})
  return [
    '---',
    `name: ${shape.skill ?? name}`,
    `description: ${name} description.`,
    'metadata:',
    '  pack:',
    `    version: ${shape.packVersion ?? '1.0.0'}`,
    ...views.length > 0 ? [`    viewFormat: ${String(shape.viewFormat ?? 1)}`] : [],
    ...shape.anchorFormat === undefined ? [] : [`    anchorFormat: ${String(shape.anchorFormat)}`],
    ...shape.parts === undefined
      ? []
      : ['  requires:', '    components:', `      "${KIT}": ">=0.4.0"`, `    parts: [${shape.parts.join(', ')}]`],
    ...views.length > 0 ? [`  views: [${views.map(file => `views/${file}`).join(', ')}]`] : [],
    '---',
    `Instructions for ${name}.`,
    '',
  ].join('\n')
}

/** One organization entry. */
function entry(name: string, version: string, channel: 'stable' | 'trial', shape: EntryShape = {}): OrgPackInput {
  const encode = (text: string): string | Uint8Array => shape.bytes === true ? new TextEncoder().encode(text) : text
  return {
    name,
    version,
    channel,
    files: [
      { path: 'SKILL.md', content: encode(skillText(name, shape)) },
      ...Object.entries(shape.views ?? {}).map(([file, text]) => ({ path: `views/${file}`, content: encode(text) })),
      ...shape.extra ?? [],
    ],
  }
}

/** The `ok` answer's refusals, or a failure naming what the call answered instead. */
function refusalsOf(result: IntakeResult): readonly { name: string; version: string; code: string }[] {
  if (result.kind !== 'ok') throw new Error(`replace answered ${result.kind}: ${result.detail}`)
  return result.refused.map(({ name, version, code }) => ({ name, version, code }))
}

/** The organization entries the status read lists, as `name@entryVersion state`. */
async function organizationStates(ctx: Context): Promise<string[]> {
  return (await ctx.skillPacks.statuses())
    .filter(status => status.origin === 'organization')
    .map(status => `${status.skill}@${String(status.entryVersion)} ${status.state}`)
}

/** The view ids `activeViews()` lists, in order. */
async function viewIds(ctx: Context): Promise<string[]> {
  return (await ctx.skillPacks.activeViews()).map(view => `${view.pack}:${view.id}`)
}

/** A promise held open until the test opens it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {}
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

/** Let every queued microtask, and one macrotask, run. */
async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('a deployment with no organization root', () => {
  it('provides no organization intake', async () => {
    const ctx = await boot(await newWorld(), false)
    expect(ctx.get('skillPackIntake')).toBeUndefined()
    expect(ctx.get('skillPacks')).toBeDefined()
  })
})

describe('the organization root configuration', () => {
  const root = join(tmpdir(), 'dsh-intake-config', 'packs')
  const deliveries = { directory: join(tmpdir(), 'dsh-intake-drop', 'deliveries'), maxArchiveBytes: 1, maxFileBytes: 1, maxFiles: 1 }

  it('refuses at load an organization root that is not absolute', () => {
    expect(() => new SkillPackRegistry(new Context(), { root, platformVersion: PLATFORM_VERSION, organizationRoot: 'organization' }))
      .toThrow('skill-pack: organizationRoot must be an absolute path, received "organization"')
  })

  it('refuses at load an organization root that is the pack root, or lies inside or around it', () => {
    for (const organizationRoot of [root, join(root, 'organization'), join(root, '..')]) {
      expect(() => new SkillPackRegistry(new Context(), { root, platformVersion: PLATFORM_VERSION, organizationRoot }))
        .toThrow(`skill-pack: organizationRoot ${JSON.stringify(organizationRoot)} and root ${JSON.stringify(root)} must be separate directories`)
    }
  })

  it('refuses at load an organization root that is the delivery directory, or lies inside or around it', () => {
    for (const organizationRoot of [deliveries.directory, join(deliveries.directory, 'organization'), join(deliveries.directory, '..')]) {
      expect(() => new SkillPackRegistry(new Context(), { root, platformVersion: PLATFORM_VERSION, deliveries, organizationRoot }))
        .toThrow(`and deliveries.directory ${JSON.stringify(deliveries.directory)} must be separate directories`)
    }
  })

  it('replaces an organization root configured with a trailing separator', async () => {
    const paths = await newWorld()
    const ctx = await boot({ ...paths, organizationRoot: `${paths.organizationRoot}${sep}` })
    const { intake } = await organization(ctx)
    expect(await intake.replace([entry('layer-guide', '1', 'stable')])).toEqual({ kind: 'ok', refused: [] })
    expect(intake.isActive('layer-guide', '1')).toBe(true)
    expect(await readdir(paths.organizationRoot)).toEqual(['layer-guide@1'])
  })

  it('takes an organization root beside the pack root and the delivery directory', async () => {
    const ctx = context = new Context()
    await ctx.plugin(SkillRegistry)
    const organizationRoot = join(tmpdir(), 'dsh-intake-config', 'organization')
    await ctx.plugin(SkillPackRegistry, { root, platformVersion: PLATFORM_VERSION, watch: false, deliveries, organizationRoot })
    expect(ctx.get('skillPackIntake')).toBeDefined()
  })
})

describe('an organization set handed over', () => {
  it('installs the stable and the trial version of one skill side by side, each under its own name and version', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    const result = await intake.replace([
      entry('layer-guide', '3', 'stable', { packVersion: '1.0.0' }),
      entry('layer-guide', '4', 'trial', { packVersion: '1.1.0' }),
    ])
    expect(refusalsOf(result)).toEqual([])
    expect((await readdir(paths.organizationRoot)).sort()).toEqual(['layer-guide@3', 'layer-guide@4'])
    expect(intake.isActive('layer-guide', '3')).toBe(true)
    expect(intake.isActive('layer-guide', '4')).toBe(true)
    expect(intake.isActive('layer-guide', '5')).toBe(false)
    expect((await ctx.skillPacks.statuses()).filter(status => status.origin === 'organization')).toEqual([
      { skill: 'layer-guide', version: '1.0.0', origin: 'organization', entryVersion: '3', channel: 'stable', state: 'active', missing: [] },
      { skill: 'layer-guide', version: '1.1.0', origin: 'organization', entryVersion: '4', channel: 'trial', state: 'active', missing: [] },
    ])
  })

  it('reports none of its skills to the skill registry', async () => {
    const ctx = await boot(await newWorld())
    const { intake } = await organization(ctx)
    await intake.replace([entry('layer-guide', '3', 'stable')])
    expect(intake.isActive('layer-guide', '3')).toBe(true)
    expect(await ctx.skills.list()).toEqual([])
    expect(await ctx.skills.get('layer-guide')).toBeUndefined()
  })

  it('offers an entry only once its parts are registered, and tells a watcher when that happens without a restart', async () => {
    const ctx = await boot(await newWorld())
    const { intake } = await organization(ctx)
    const parts = await mountParts(ctx, [])
    expect(refusalsOf(await intake.replace([
      entry('space-data-page', '7', 'stable', { parts: ['toy.data-page'], views: { 'layers.yml': viewText('layers', '图层') } }),
    ]))).toEqual([])
    expect(intake.isActive('space-data-page', '7')).toBe(false)
    expect(await viewIds(ctx)).toEqual([])
    expect((await ctx.skillPacks.statuses()).find(status => status.origin === 'organization')?.missing).toEqual([
      { kind: 'plugin-absent', plugin: KIT, range: '>=0.4.0' },
      { kind: 'part-absent', part: 'toy.data-page' },
    ])
    expect(logLines.filter(line => line.includes('withholding organization space-data-page@7'))).toHaveLength(1)

    const seen: boolean[] = []
    intake.onChange(() => { seen.push(intake.isActive('space-data-page', '7')) })
    parts.replace([CRUD])
    expect(seen).toEqual([true])
    expect(await viewIds(ctx)).toEqual(['space-data-page:layers'])
  })

  it('answers from the new set once replace resolves, and calls watchers after the set is offered', async () => {
    const ctx = await boot(await newWorld())
    const { intake } = await organization(ctx)
    const seen: boolean[] = []
    intake.onChange(() => { seen.push(intake.isActive('layer-guide', '3')) })
    const result = await intake.replace([entry('layer-guide', '3', 'stable')])
    expect(result).toEqual({ kind: 'ok', refused: [] })
    expect(intake.isActive('layer-guide', '3')).toBe(true)
    expect(seen).toEqual([true])
  })

  it('takes every entry\'s files as bytes or as text, and writes the bytes it was handed', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    const views = { 'layers.yml': viewText('layers', '图层') }
    expect(refusalsOf(await intake.replace([
      entry('byte-guide', '1', 'stable', { views, bytes: true }),
      entry('text-guide', '1', 'stable', { views: { 'sites.yml': viewText('sites', '站点') } }),
    ]))).toEqual([])
    expect(intake.isActive('byte-guide', '1')).toBe(true)
    expect(intake.isActive('text-guide', '1')).toBe(true)
    expect(await readFile(join(paths.organizationRoot, 'byte-guide@1', 'views', 'layers.yml'), 'utf8')).toBe(viewText('layers', '图层'))
    expect(await readFile(join(paths.organizationRoot, 'byte-guide@1', 'SKILL.md'), 'utf8'))
      .toBe(skillText('byte-guide', { views }))
    expect(await viewIds(ctx)).toEqual(['byte-guide:layers', 'text-guide:sites'])
  })

  it('judges a SKILL.md opening with a byte-order mark the way the pack root reads the same file from disk', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    const marked = new Uint8Array([0xEF, 0xBB, 0xBF, ...new TextEncoder().encode(skillText('marked-guide', {}))])
    const result = await intake.replace([{ name: 'marked-guide', version: '1', channel: 'stable', files: [{ path: 'SKILL.md', content: marked }] }])
    expect(refusalsOf(result)).toEqual([{ name: 'marked-guide', version: '1', code: 'pack-invalid' }])
    // The same bytes in a pack root are not a pack either.
    await mkdir(join(paths.root, 'marked-guide'), { recursive: true })
    await writeFile(join(paths.root, 'marked-guide', 'SKILL.md'), marked)
    expect(await readPackRoot(paths.root)).toEqual([])
  })

  it('withdraws the set and empties the root when handed an empty set', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    await intake.replace([entry('layer-guide', '3', 'stable', { views: { 'layers.yml': viewText('layers', '图层') } })])
    expect(await viewIds(ctx)).toEqual(['layer-guide:layers'])
    expect(await intake.replace([])).toEqual({ kind: 'ok', refused: [] })
    expect(intake.isActive('layer-guide', '3')).toBe(false)
    expect(await viewIds(ctx)).toEqual([])
    expect(await organizationStates(ctx)).toEqual([])
    expect(await readdir(paths.organizationRoot)).toEqual([])
  })
})

describe('an entry refused', () => {
  it('refuses an entry whose files do not make it the pack it names as pack-invalid', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    const result = await intake.replace([
      entry('layer-guide', '1', 'stable', { skill: 'other-guide' }),
      entry('layer-guide', '..', 'stable'),
      entry('layer-guide', 'a/b', 'stable'),
      entry('Layer Guide', '1', 'stable'),
      { name: 'bare-guide', version: '1', channel: 'stable', files: [{ path: 'SKILL.md', content: '---\nname: bare-guide\ndescription: d.\n---\nBody.\n' }] },
      { name: 'empty-guide', version: '1', channel: 'stable', files: [{ path: 'README.md', content: 'no skill here' }] },
      entry('broken-view', '1', 'stable', { views: { 'layers.yml': 'id: layers\n' } }),
      entry('kept-guide', '1', 'stable'),
    ])
    const refused = result.kind === 'ok' ? result.refused : []
    expect(refused.slice(0, -1)).toEqual([
      { name: 'layer-guide', version: '1', code: 'pack-invalid', detail: 'SKILL.md names the skill "other-guide"' },
      { name: 'layer-guide', version: '..', code: 'pack-invalid', detail: 'the version ".." is not one directory name' },
      { name: 'layer-guide', version: 'a/b', code: 'pack-invalid', detail: 'the version "a/b" is not one directory name' },
      { name: 'Layer Guide', version: '1', code: 'pack-invalid', detail: 'the name "Layer Guide" is not a skill name' },
      { name: 'bare-guide', version: '1', code: 'pack-invalid', detail: 'metadata Invalid input: expected object, received undefined' },
      {
        name: 'empty-guide',
        version: '1',
        code: 'pack-invalid',
        detail: 'SKILL.md is missing, or its frontmatter states no skill name and description',
      },
    ])
    expect(refused.at(-1)).toMatchObject({ name: 'broken-view', version: '1', code: 'pack-invalid' })
    expect(refused.at(-1)?.detail).toContain('view views/layers.yml is unreadable')
    expect(await readdir(paths.organizationRoot)).toEqual(['kept-guide@1'])
    expect(intake.isActive('layer-guide', '1')).toBe(false)
  })

  it('refuses an entry carrying a file a pack may not carry, and installs the rest', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    const result = await intake.replace([
      entry('script-guide', '1', 'stable', { extra: [{ path: 'run.js', content: 'process.exit(1)' }] }),
      entry('layer-guide', '1', 'stable'),
    ])
    expect(refusalsOf(result)).toEqual([{ name: 'script-guide', version: '1', code: 'pack-invalid' }])
    expect(result.kind === 'ok' ? result.refused[0]?.detail : '').toContain('refused script-guide@1/run.js — a pack carries only .md')
    expect(await readdir(paths.organizationRoot)).toEqual(['layer-guide@1'])
    expect(intake.isActive('layer-guide', '1')).toBe(true)
  })

  it('refuses an entry stating an anchor format this build does not read', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    const result = await intake.replace([
      entry('anchored-guide', '2', 'stable', { anchorFormat: 2 }),
      entry('anchored-guide', '1', 'stable', { anchorFormat: 1 }),
    ])
    expect(result.kind === 'ok' ? result.refused : []).toEqual([{
      name: 'anchored-guide',
      version: '2',
      code: 'anchor-format',
      detail: 'states anchor format 2; this build reads 1',
    }])
    expect(await readdir(paths.organizationRoot)).toEqual(['anchored-guide@1'])
    expect(intake.isActive('anchored-guide', '1')).toBe(true)
  })

  it('refuses an entry declaring views in a view format this build does not read', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    const result = await intake.replace([entry('layer-guide', '1', 'stable', { viewFormat: 2, views: { 'layers.yml': viewText('layers', '图层') } })])
    expect(result.kind === 'ok' ? result.refused : []).toEqual([{
      name: 'layer-guide',
      version: '1',
      code: 'view-format',
      detail: 'declares views in view format 2; this build reads 1',
    }])
    // Nothing was written, so the root was never created.
    await expect(readdir(paths.organizationRoot)).rejects.toThrow('ENOENT')
  })

  it('refuses an entry whose view the composed surface will not draw, and installs one still waiting for its parts', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    const parts = await mountParts(ctx, [CRUD])
    parts.refused.add('layers')
    const result = await intake.replace([
      entry('layer-guide', '1', 'stable', { parts: ['toy.data-page'], views: { 'layers.yml': viewText('layers', '图层') } }),
      entry('waiting-guide', '1', 'stable', { parts: ['toy.chart'], views: { 'layers.yml': viewText('layers', '图层') } }),
    ])
    expect(result.kind === 'ok' ? result.refused : []).toEqual([{
      name: 'layer-guide',
      version: '1',
      code: 'view-refused',
      detail: 'view views/layers.yml cannot be drawn: names no component of this deployment',
    }])
    expect(await readdir(paths.organizationRoot)).toEqual(['waiting-guide@1'])
    expect(await organizationStates(ctx)).toEqual(['waiting-guide@1 inactive'])
  })

  it('refuses every occurrence of a name and version the set names more than once, because none of them is the one meant', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    const result = await intake.replace([
      entry('layer-guide', '1', 'stable'),
      entry('layer-guide', '1', 'trial', { packVersion: '1.0.1' }),
      entry('layer-guide', '2', 'trial'),
    ])
    expect(result.kind === 'ok' ? result.refused : []).toEqual([
      { name: 'layer-guide', version: '1', code: 'duplicate', detail: 'layer-guide@1 is named more than once in this set' },
      { name: 'layer-guide', version: '1', code: 'duplicate', detail: 'layer-guide@1 is named more than once in this set' },
    ])
    expect(await readdir(paths.organizationRoot)).toEqual(['layer-guide@2'])
    expect(intake.isActive('layer-guide', '1')).toBe(false)
  })
})

describe('view ids an organization set declares', () => {
  it('refuses every entry declaring one id with different files when the offered set holds none of them', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    const result = await intake.replace([
      entry('b-guide', '1', 'stable', { views: { 'layers.yml': viewText('layers', '图层 B') } }),
      entry('a-guide', '1', 'stable', { views: { 'layers.yml': viewText('layers', '图层 A') } }),
      entry('c-guide', '1', 'stable', { views: { 'sites.yml': viewText('sites', '站点') } }),
    ])
    const sentence = 'another entry of this set declares the view id layers with a different file'
    expect(result.kind === 'ok' ? result.refused : []).toEqual([
      { name: 'b-guide', version: '1', code: 'view-id-conflict', detail: sentence },
      { name: 'a-guide', version: '1', code: 'view-id-conflict', detail: sentence },
    ])
    expect(await readdir(paths.organizationRoot)).toEqual(['c-guide@1'])
  })

  it('keeps the offered entry\'s view and refuses an entry changing its file', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    const kept = entry('layer-guide', '1', 'stable', { views: { 'layers.yml': viewText('layers', '图层') } })
    await intake.replace([kept])
    const result = await intake.replace([
      entry('layer-guide', '2', 'trial', { views: { 'layers.yml': viewText('layers', '新图层') } }),
      kept,
    ])
    expect(result.kind === 'ok' ? result.refused : []).toEqual([{
      name: 'layer-guide',
      version: '2',
      code: 'view-id-conflict',
      detail: 'the view id layers is held by the offered organization set with a different file',
    }])
    expect((await ctx.skillPacks.activeViews()).map(view => view.title)).toEqual(['图层'])
  })

  /** A stable version holding a view, and a trial version changing that view's file. */
  function stableAndTrial(): { stable: OrgPackInput; set: OrgPackInput[] } {
    const stable = entry('layer-guide', '3', 'stable', { views: { 'layers.yml': viewText('layers', '图层') } })
    const trial = entry('layer-guide', '4', 'trial', { packVersion: '1.1.0', views: { 'layers.yml': viewText('layers', '新图层') } })
    return { stable, set: [stable, trial] }
  }

  /** The refusal of the trial version for the view id the organization root holds on disk. */
  const HELD_ON_DISK = {
    name: 'layer-guide',
    version: '4',
    code: 'view-id-conflict',
    detail: 'the view id layers is held by the organization root with a different file',
  }

  it('judges a set the same way after the fiber holding the last one is reloaded, by what the organization root holds', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const { stable, set } = stableAndTrial()
    const before = await organization(ctx)
    await before.intake.replace([stable])
    expect(refusalsOf(await before.intake.replace(set))).toEqual([{ name: 'layer-guide', version: '4', code: 'view-id-conflict' }])
    await before.fiber.dispose()

    const { intake } = await organization(ctx)
    const result = await intake.replace(set)
    expect(result.kind === 'ok' ? result.refused : result).toEqual([HELD_ON_DISK])
    expect(intake.isActive('layer-guide', '3')).toBe(true)
    expect(intake.isActive('layer-guide', '4')).toBe(false)
    expect((await ctx.skillPacks.activeViews()).map(view => view.title)).toEqual(['图层'])
    expect(await readdir(paths.organizationRoot)).toEqual(['layer-guide@3'])
  })

  it('judges a set the same way after a restart, by what the organization root holds', async () => {
    const paths = await newWorld()
    const { stable, set } = stableAndTrial()
    const before = await boot(paths)
    const { intake: running } = await organization(before)
    await running.replace([stable])
    expect(refusalsOf(await running.replace(set))).toEqual([{ name: 'layer-guide', version: '4', code: 'view-id-conflict' }])
    await before.fiber.dispose()

    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    const result = await intake.replace(set)
    expect(result.kind === 'ok' ? result.refused : result).toEqual([HELD_ON_DISK])
    expect(intake.isActive('layer-guide', '3')).toBe(true)
    expect((await ctx.skillPacks.activeViews()).map(view => view.title)).toEqual(['图层'])
    expect(await readdir(paths.organizationRoot)).toEqual(['layer-guide@3'])
  })

  // Mode 000 denies a directory read only to a non-root owner on POSIX:
  // Windows has no directory permission bits for readdir, and root bypasses
  // them, so there the organization root stays readable and nothing fails.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'answers failed after a restart, changing nothing, while the organization root cannot be read, and judges the same set by that root once it can',
    async () => {
      const paths = await newWorld()
      const { stable, set } = stableAndTrial()
      const before = await boot(paths)
      await (await organization(before)).intake.replace([stable])
      await before.fiber.dispose()

      const ctx = await boot(paths)
      const { intake } = await organization(ctx)
      await chmod(paths.organizationRoot, 0o000)
      let unread: IntakeResult
      try {
        unread = await intake.replace(set)
      } finally {
        await chmod(paths.organizationRoot, 0o755)
      }
      expect(unread.kind).toBe('failed')
      expect(unread.kind === 'failed' ? unread.detail : '').toContain('skill-pack: the organization root was not read: Error: EACCES')
      expect(intake.isActive('layer-guide', '3')).toBe(false)
      expect(await readdir(paths.organizationRoot)).toEqual(['layer-guide@3'])

      const result = await intake.replace(set)
      expect(result.kind === 'ok' ? result.refused : result).toEqual([HELD_ON_DISK])
      expect(intake.isActive('layer-guide', '3')).toBe(true)
      expect(intake.isActive('layer-guide', '4')).toBe(false)
      expect(await readdir(paths.organizationRoot)).toEqual(['layer-guide@3'])
    },
  )

  it('holds an id on disk by the first entry declaring it in name@version order while no set is offered', async () => {
    const paths = await newWorld()
    for (const [name, title] of [['a-guide', 'OLD'], ['b-guide', 'NEW']] as const) {
      const directory = join(paths.organizationRoot, `${name}@1`)
      await mkdir(join(directory, 'views'), { recursive: true })
      await writeFile(join(directory, 'SKILL.md'), skillText(name, { views: { 'layers.yml': '' } }))
      await writeFile(join(directory, 'views', 'layers.yml'), viewText('layers', title))
    }
    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    const result = await intake.replace([
      entry('c-guide', '1', 'stable', { views: { 'layers.yml': viewText('layers', 'OLD') } }),
      entry('d-guide', '1', 'stable', { views: { 'layers.yml': viewText('layers', 'NEW') } }),
    ])
    expect(result.kind === 'ok' ? result.refused : result).toEqual([{
      name: 'd-guide',
      version: '1',
      code: 'view-id-conflict',
      detail: 'the view id layers is held by the organization root with a different file',
    }])
    expect(await readdir(paths.organizationRoot)).toEqual(['c-guide@1'])
  })

  it('reads the organization root the way the pack root is read while no set is offered: a directory that is no pack, and a view that does not read, hold no id', async () => {
    const paths = await newWorld()
    await mkdir(join(paths.organizationRoot, 'notes@1'), { recursive: true })
    await writeFile(join(paths.organizationRoot, 'notes@1', 'README.md'), 'no skill here')
    await mkdir(join(paths.organizationRoot, 'broken-guide@1', 'views'), { recursive: true })
    await writeFile(join(paths.organizationRoot, 'broken-guide@1', 'SKILL.md'), skillText('broken-guide', { views: { 'layers.yml': '' } }))
    await writeFile(join(paths.organizationRoot, 'broken-guide@1', 'views', 'layers.yml'), 'id: layers\n')
    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    const result = await intake.replace([
      entry('a-guide', '1', 'stable', { views: { 'layers.yml': viewText('layers', '图层 A') } }),
      entry('b-guide', '1', 'stable', { views: { 'layers.yml': viewText('layers', '图层 B') } }),
    ])
    const sentence = 'another entry of this set declares the view id layers with a different file'
    expect(result.kind === 'ok' ? result.refused : result).toEqual([
      { name: 'a-guide', version: '1', code: 'view-id-conflict', detail: sentence },
      { name: 'b-guide', version: '1', code: 'view-id-conflict', detail: sentence },
    ])
  })

  it('replaces an offered version whose view the new set changes when the set no longer names it', async () => {
    const ctx = await boot(await newWorld())
    const { intake } = await organization(ctx)
    await intake.replace([entry('layer-guide', '1', 'stable', { views: { 'layers.yml': viewText('layers', '图层') } })])
    expect(refusalsOf(await intake.replace([
      entry('layer-guide', '2', 'stable', { views: { 'layers.yml': viewText('layers', '新图层') } }),
    ]))).toEqual([])
    expect((await ctx.skillPacks.activeViews()).map(view => view.title)).toEqual(['新图层'])
  })

  it('lists a view two versions declare with the same file once, under the first of them', async () => {
    const ctx = await boot(await newWorld())
    const { intake } = await organization(ctx)
    expect(refusalsOf(await intake.replace([
      entry('layer-guide', '2', 'trial', { packVersion: '1.1.0', views: { 'layers.yml': viewText('layers', '图层') } }),
      entry('layer-guide', '1', 'stable', { views: { 'layers.yml': viewText('layers', '图层') } }),
    ]))).toEqual([])
    expect(await ctx.skillPacks.activeViews()).toEqual([
      { pack: 'layer-guide', id: 'layers', title: '图层', spec: [], params: {} },
    ])
  })

  it('withholds a pack of the pack root declaring an id an offered organization pack holds, until that set is withdrawn', async () => {
    const paths = await newWorld()
    await mkdir(join(paths.root, 'root-guide', 'views'), { recursive: true })
    await writeFile(join(paths.root, 'root-guide', 'SKILL.md'), skillText('root-guide', { views: { 'layers.yml': '' } }))
    await writeFile(join(paths.root, 'root-guide', 'views', 'layers.yml'), viewText('layers', '包根图层'))
    const ctx = await boot(paths)
    const { intake, fiber } = await organization(ctx)
    expect(await viewIds(ctx)).toEqual(['root-guide:layers'])

    await intake.replace([entry('org-guide', '1', 'stable', { views: { 'layers.yml': viewText('layers', '组织图层') } })])
    expect(await viewIds(ctx)).toEqual(['org-guide:layers'])
    expect((await ctx.skillPacks.statuses()).find(status => status.skill === 'root-guide')).toEqual({
      skill: 'root-guide',
      version: '1.0.0',
      origin: 'pack-root',
      state: 'inactive',
      missing: [{ kind: 'view-id-conflict', id: 'layers', pack: 'org-guide', origin: 'organization' }],
    })
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual([])

    await fiber.dispose()
    expect(await viewIds(ctx)).toEqual(['root-guide:layers'])
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['root-guide'])
  })

  it('lets an organization pack hold no id while it is inactive', async () => {
    const paths = await newWorld()
    await mkdir(join(paths.root, 'root-guide', 'views'), { recursive: true })
    await writeFile(join(paths.root, 'root-guide', 'SKILL.md'), skillText('root-guide', { views: { 'layers.yml': '' } }))
    await writeFile(join(paths.root, 'root-guide', 'views', 'layers.yml'), viewText('layers', '包根图层'))
    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    const parts = await mountParts(ctx, [])
    await intake.replace([entry('org-guide', '1', 'stable', { parts: ['toy.data-page'], views: { 'layers.yml': viewText('layers', '组织图层') } })])
    expect(await viewIds(ctx)).toEqual(['root-guide:layers'])
    parts.replace([CRUD])
    expect(await viewIds(ctx)).toEqual(['org-guide:layers'])
  })
})

describe('the calls themselves', () => {
  it('answers failed and keeps the offered set when the write fails', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    await intake.replace([entry('layer-guide', '1', 'stable')])
    rootControl.failure = new Error('the disk is full')
    const result = await intake.replace([entry('layer-guide', '2', 'stable')])
    expect(result).toEqual({ kind: 'failed', detail: 'skill-pack: the organization root was not replaced: Error: the disk is full' })
    expect(intake.isActive('layer-guide', '1')).toBe(true)
    expect(intake.isActive('layer-guide', '2')).toBe(false)
    expect(await readdir(paths.organizationRoot)).toEqual(['layer-guide@1'])
  })

  it('answers failed, writing nothing, when the organization root cannot be read for the view ids it holds', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    rootControl.readFailure = new Error('the disk is unreadable')
    expect(await intake.replace([entry('layer-guide', '1', 'stable')])).toEqual({
      kind: 'failed',
      detail: 'skill-pack: the organization root was not read: Error: the disk is unreadable',
    })
    expect(intake.isActive('layer-guide', '1')).toBe(false)
    await expect(readdir(paths.organizationRoot)).rejects.toThrow('ENOENT')
  })

  it('rejects with the signal\'s reason, changing nothing, when aborted before the call or while it waits for its turn', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    const reason = new Error('a newer set arrived')
    const write = gate()
    rootControl.gate = write.promise
    const first = intake.replace([entry('layer-guide', '1', 'stable')])
    // Refused at once, without waiting behind the call that is writing.
    await expect(intake.replace([entry('layer-guide', '9', 'stable')], { signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
    const controller = new AbortController()
    const second = intake.replace([entry('layer-guide', '2', 'stable')], { signal: controller.signal })
    controller.abort(reason)
    write.open()
    expect(await first).toEqual({ kind: 'ok', refused: [] })
    await expect(second).rejects.toBe(reason)
    expect(intake.isActive('layer-guide', '1')).toBe(true)
    expect(intake.isActive('layer-guide', '2')).toBe(false)
    expect(await readdir(paths.organizationRoot)).toEqual(['layer-guide@1'])
  })

  it('rejects with the signal\'s reason, writing nothing, when aborted while its entries are judged', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    const parts = await mountParts(ctx)
    const controller = new AbortController()
    const reason = new Error('a newer set arrived')
    parts.whileJudging = () => { controller.abort(reason) }
    await expect(intake.replace(
      [entry('layer-guide', '1', 'stable', { parts: ['toy.data-page'], views: { 'layers.yml': viewText('layers', '图层') } })],
      { signal: controller.signal },
    )).rejects.toBe(reason)
    expect(intake.isActive('layer-guide', '1')).toBe(false)
    await expect(readdir(paths.organizationRoot)).rejects.toThrow('ENOENT')
  })

  it('runs concurrent calls in the order they arrive, and offers the last one', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    const answers = await Promise.all([
      intake.replace([entry('layer-guide', '1', 'stable')]),
      intake.replace([entry('layer-guide', '2', 'stable'), entry('site-guide', '1', 'trial')]),
    ])
    expect(answers).toEqual([{ kind: 'ok', refused: [] }, { kind: 'ok', refused: [] }])
    expect(await organizationStates(ctx)).toEqual(['layer-guide@2 active', 'site-guide@1 active'])
    expect((await readdir(paths.organizationRoot)).sort()).toEqual(['layer-guide@2', 'site-guide@1'])
  })

  it('answers failed, offering nothing new, when the calling fiber stops before its turn', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const first = await organization(ctx)
    const second = await organization(ctx)
    const write = gate()
    rootControl.gate = write.promise
    const held = first.intake.replace([entry('layer-guide', '1', 'stable')])
    const queued = second.intake.replace([entry('layer-guide', '2', 'stable')])
    await second.fiber.dispose()
    write.open()
    expect(await held).toEqual({ kind: 'ok', refused: [] })
    expect(await queued).toEqual({ kind: 'failed', detail: 'skill-pack: the fiber that called replace stopped before the call could write' })
    expect(await organizationStates(ctx)).toEqual(['layer-guide@1 active'])
    expect(await readdir(paths.organizationRoot)).toEqual(['layer-guide@1'])
  })

  it('answers failed, writing nothing, when the calling fiber stops while its entries are judged', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const { intake, fiber } = await organization(ctx)
    const parts = await mountParts(ctx)
    parts.whileJudging = () => { void fiber.dispose() }
    expect(await intake.replace([
      entry('layer-guide', '1', 'stable', { parts: ['toy.data-page'], views: { 'layers.yml': viewText('layers', '图层') } }),
    ])).toEqual({ kind: 'failed', detail: 'skill-pack: the fiber that called replace stopped before the call could write' })
    expect(await organizationStates(ctx)).toEqual([])
    await expect(readdir(paths.organizationRoot)).rejects.toThrow('ENOENT')
  })

  it('answers failed when the calling fiber stops while the set is written, and offers it to the next call without writing it again', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const first = await organization(ctx)
    const second = await organization(ctx)
    await first.intake.replace([entry('layer-guide', '1', 'stable')])

    const write = gate()
    rootControl.gate = write.promise
    const newer = [entry('layer-guide', '2', 'stable')]
    const started = writeStarts()
    const writing = second.intake.replace(newer)
    await started
    await second.fiber.dispose()
    write.open()
    expect(await writing).toEqual({
      kind: 'failed',
      detail: 'skill-pack: the fiber that called replace stopped while the set was written; the organization root holds it, and it is not offered',
    })
    expect(await organizationStates(ctx)).toEqual(['layer-guide@1 active'])
    expect(await readdir(paths.organizationRoot)).toEqual(['layer-guide@2'])

    const written = (await stat(paths.organizationRoot)).ino
    expect(await first.intake.replace(newer)).toEqual({ kind: 'ok', refused: [] })
    expect((await stat(paths.organizationRoot)).ino).toBe(written)
    expect(await organizationStates(ctx)).toEqual(['layer-guide@2 active'])
  })
})

describe('the lifetime of the offered set', () => {
  it('offers nothing after a restart until the first replace, which writes nothing when the root already holds the set', async () => {
    const paths = await newWorld()
    const set = [entry('layer-guide', '1', 'stable', { views: { 'layers.yml': viewText('layers', '图层') } })]
    const before = await boot(paths)
    await (await organization(before)).intake.replace(set)
    await before.fiber.dispose()

    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    expect(intake.isActive('layer-guide', '1')).toBe(false)
    expect(await organizationStates(ctx)).toEqual([])
    expect(await viewIds(ctx)).toEqual([])
    const written = (await stat(paths.organizationRoot)).ino
    expect(await intake.replace(set)).toEqual({ kind: 'ok', refused: [] })
    expect((await stat(paths.organizationRoot)).ino).toBe(written)
    expect(intake.isActive('layer-guide', '1')).toBe(true)
    expect(await viewIds(ctx)).toEqual(['layer-guide:layers'])
  })

  it('withdraws the set when the fiber that handed it over is disposed, leaving its files (HMR safety)', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const { intake, fiber } = await organization(ctx)
    await intake.replace([entry('layer-guide', '1', 'stable', { views: { 'layers.yml': viewText('layers', '图层') } })])
    const watcher = await organization(ctx)
    let changes = 0
    watcher.intake.onChange(() => { changes += 1 })
    await fiber.dispose()
    expect(changes).toBe(1)
    expect(watcher.intake.isActive('layer-guide', '1')).toBe(false)
    expect(await viewIds(ctx)).toEqual([])
    expect(await organizationStates(ctx)).toEqual([])
    expect(await readdir(paths.organizationRoot)).toEqual(['layer-guide@1'])
  })

  it('keeps a set another call replaced when the fiber that handed over the older one is disposed', async () => {
    const ctx = await boot(await newWorld())
    const older = await organization(ctx)
    const newer = await organization(ctx)
    await older.intake.replace([entry('layer-guide', '1', 'stable')])
    await newer.intake.replace([entry('layer-guide', '2', 'stable')])
    await older.fiber.dispose()
    expect(await organizationStates(ctx)).toEqual(['layer-guide@2 active'])
  })

  it('holds the set on a plugin\'s fiber while its apply still awaits the call', async () => {
    const ctx = await boot(await newWorld())
    const results: IntakeResult[] = []
    const fiber = await ctx.plugin({
      name: 'awaiting-organization',
      inject: ['skillPackIntake'],
      async apply(scope: Context) {
        results.push(await scope.skillPackIntake.replace([entry('layer-guide', '1', 'stable')]))
      },
    })
    expect(results).toEqual([{ kind: 'ok', refused: [] }])
    expect(await organizationStates(ctx)).toEqual(['layer-guide@1 active'])
    await fiber.dispose()
    expect(await organizationStates(ctx)).toEqual([])
  })

  it('withdraws the intake with its row, waiting for a write in progress, and answers every call of the stopped row failed (HMR safety)', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    const { intake } = await organization(ctx)
    const write = gate()
    rootControl.gate = write.promise
    const order: string[] = []
    const started = writeStarts()
    const writing = intake.replace([entry('layer-guide', '1', 'stable')]).then((result) => { order.push('written'); return result })
    const queued = intake.replace([entry('layer-guide', '2', 'stable')])
    await started
    const disposed = rowFiber(ctx).dispose().then(() => { order.push('disposed') })
    await tick()
    expect(ctx.get('skillPackIntake')).toBeUndefined()
    write.open()
    await disposed
    expect(order).toEqual(['written', 'disposed'])
    // The organization plugin's inject fiber stops with the intake it injects,
    // so the call in progress writes and offers nothing.
    expect(await writing).toEqual({
      kind: 'failed',
      detail: 'skill-pack: the fiber that called replace stopped while the set was written; the organization root holds it, and it is not offered',
    })
    expect(await queued).toEqual({ kind: 'failed', detail: 'skill-pack: the row stopped before this replace could write' })
    expect(intake.isActive('layer-guide', '1')).toBe(false)
    expect(await readdir(paths.organizationRoot)).toEqual(['layer-guide@1'])
  })

  it('answers failed when the row stops while the set is written, for a caller whose own fiber outlives the row', async () => {
    const paths = await newWorld()
    const ctx = await boot(paths)
    // Read without an inject, so the calling fiber is the root's and stays active.
    const intake = ctx.get('skillPackIntake')
    if (intake === undefined) throw new Error('the organization intake is not provided')
    const write = gate()
    rootControl.gate = write.promise
    const started = writeStarts()
    const writing = intake.replace([entry('layer-guide', '1', 'stable')])
    await started
    const disposed = rowFiber(ctx).dispose()
    await tick()
    write.open()
    await disposed
    expect(await writing).toEqual({
      kind: 'failed',
      detail: 'skill-pack: the row stopped while the set was written; the organization root holds it, and it is not offered',
    })
    expect(intake.isActive('layer-guide', '1')).toBe(false)
    expect(await readdir(paths.organizationRoot)).toEqual(['layer-guide@1'])
  })

  it('stops calling a watcher once the fiber that asked for it is disposed', async () => {
    const ctx = await boot(await newWorld())
    const { intake } = await organization(ctx)
    const parts = await mountParts(ctx)
    const watcher = await organization(ctx)
    let changes = 0
    watcher.intake.onChange(() => { changes += 1 })
    parts.replace([CRUD])
    expect(changes).toBe(1)
    await watcher.fiber.dispose()
    await intake.replace([entry('layer-guide', '1', 'stable')])
    parts.replace([])
    expect(changes).toBe(1)
  })

  it('stops calling a watcher once the watch is given up', async () => {
    const ctx = await boot(await newWorld())
    const { intake } = await organization(ctx)
    let changes = 0
    const stop = intake.onChange(() => { changes += 1 })
    await intake.replace([entry('layer-guide', '1', 'stable')])
    stop()
    await intake.replace([])
    expect(changes).toBe(1)
  })
})
