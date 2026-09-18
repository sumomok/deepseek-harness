/**
 * REAL-composition coverage: a test-only cordis.yml booted through the vendored
 * Loader mounts the component surface, a component plugin, the pack root's
 * skill provider and this row over a real pack root, and every assertion reads
 * what the composition actually offers — the merged skill catalog, the pack
 * status route, and what both answer as a component plugin arrives and goes
 * away.
 *
 * The one thing only a composition can show is the point of the row: the parts
 * a pack is judged against are the components this deployment *offers*, so a
 * pack requiring the data page is withheld from a deployment that registered
 * it and left `crud` off.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ShowComponent from '@deepseek-ai/dsh-experimental-component-surface'
import { COMPONENT_KIT_ENTRIES } from '@deepseek-ai/dsh-experimental-component-surface'
import SkillPackRegistry from '@deepseek-ai/dsh-experimental-skill-pack'
import type { PackStatus } from '@deepseek-ai/dsh-experimental-skill-pack'
import * as SkillPackComponents from '../src/index.ts'

/** The platform version the packs below are judged against. */
const PLATFORM_VERSION = '0.5.2'

/** The component plugin the pack is written against, at the version its manifest asks for. */
const KIT = '@deepseek-ai/dsh-experimental-component-kit'
const KIT_VERSION = '0.4.0'

/** The module name the stand-in component plugin is composed under. */
const COMPONENT_PLUGIN_NAME = 'test:component-plugin'

/**
 * A component plugin for this composition: it contributes the same components
 * the shipped component row does, through the same registry, and knows nothing
 * about packs.
 * @returns the plugin to write into the test-only Loader module table.
 */
function componentPlugin(): { name: string; inject: readonly string[]; apply: (ctx: Context) => void } {
  return {
    name: 'test-component-plugin',
    inject: ['componentCatalog'],
    apply(ctx: Context) {
      ctx.componentCatalog.register({
        entries: COMPONENT_KIT_ENTRIES,
        source: { package: KIT, version: KIT_VERSION },
      })
    },
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

/** Write one pack into a root: a SKILL.md carrying the manifest, and the view it declares. */
async function writePack(root: string, name: string, metadata: readonly string[]): Promise<void> {
  const directory = join(root, name)
  await mkdir(join(directory, 'views'), { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${name} description.`,
    'metadata:',
    ...metadata,
    '---',
    `Instructions for ${name}.`,
    '',
  ].join('\n'))
}

/** The pack every case here is about: it places the deployment's own data page. */
const DATA_PAGE_PACK = [
  '  pack:',
  '    version: 1.0.0',
  '  requires:',
  '    components:',
  `      "${KIT}": ">=0.4.0"`,
  '    parts: [toy.crud]',
]

/** Boot the four rows over a freshly written pack root. */
async function loadComposition(crud: boolean): Promise<Context> {
  world = await mkdtemp(join(tmpdir(), 'dsh-skill-pack-components-'))
  const root = join(world, 'packs')
  await writePack(root, 'space-data-page', DATA_PAGE_PACK)

  const configPath = join(world, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-skill'",
    `- name: '${COMPONENT_PLUGIN_NAME}'`,
    '- id: show-component',
    "  name: '@deepseek-ai/dsh-experimental-component-surface'",
    '  config:',
    `    crud: ${String(crud)}`,
    "- name: '@deepseek-ai/dsh-experimental-skill-pack'",
    '  config:',
    `    root: ${JSON.stringify(root)}`,
    `    platformVersion: '${PLATFORM_VERSION}'`,
    '    watch: false',
    "- name: '@deepseek-ai/dsh-experimental-skill-pack-components'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(world).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    [COMPONENT_PLUGIN_NAME, componentPlugin()],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-skill', SkillRegistry],
    ['@deepseek-ai/dsh-experimental-component-surface', ShowComponent],
    ['@deepseek-ai/dsh-experimental-skill-pack', SkillPackRegistry],
    ['@deepseek-ai/dsh-experimental-skill-pack-components', SkillPackComponents],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/** The one pack's status, as the pack root's provider judges it now. */
async function statusOf(ctx: Context): Promise<PackStatus | undefined> {
  return (await ctx.skillPacks.statuses()).find(status => status.skill === 'space-data-page')
}

/** The skill names the merged catalog offers. */
async function skillNames(ctx: Context): Promise<string[]> {
  return (await ctx.skills.list()).map(candidate => candidate.name)
}

describe('the component catalog as a pack reads it', () => {
  it('offers a pack whose part the deployment registered and offers', { timeout: 60_000 }, async () => {
    const ctx = await loadComposition(true)
    expect(await statusOf(ctx)).toEqual({ skill: 'space-data-page', version: '1.0.0', state: 'active', missing: [] })
    expect(await skillNames(ctx)).toContain('space-data-page')
  })

  it('publishes each offered component with the package that registered it and that package\'s own version', async () => {
    const ctx = await loadComposition(true)
    const parts = ctx.skillPackParts.list()
    expect(parts).toContainEqual({ id: 'toy.crud', plugin: KIT, version: KIT_VERSION })
    // Every registered component is a part, not only the one the pack names:
    // which parts a pack may require is the pack's business.
    expect(parts.map(part => part.id)).toEqual(COMPONENT_KIT_ENTRIES.map(entry => entry.id))
  })

  it('withholds a pack whose part the deployment registered and does not offer', async () => {
    // `crud: false` is a deployment that composed the component plugin and did
    // not turn the data page on. The page cannot be drawn here, so the pack
    // that places it is offered to nobody — the part is absent as far as a
    // pack is concerned, which is the whole reason this row reads the offer
    // rather than the registration.
    const ctx = await loadComposition(false)
    expect(await statusOf(ctx)).toEqual({
      skill: 'space-data-page',
      version: '1.0.0',
      state: 'inactive',
      missing: [{ kind: 'part-absent', part: 'toy.crud' }],
    })
    expect(await skillNames(ctx)).not.toContain('space-data-page')
    expect(ctx.skillPackParts.list().map(part => part.id)).not.toContain('toy.crud')
  })

  it('withdraws the pack when the component plugin goes away, with no restart', async () => {
    const ctx = await loadComposition(true)
    expect(await skillNames(ctx)).toContain('space-data-page')
    await [...ctx.loader.entries()].find(entry => entry.options.name === COMPONENT_PLUGIN_NAME)?.fiber?.dispose()
    expect(await statusOf(ctx)).toEqual({
      skill: 'space-data-page',
      version: '1.0.0',
      state: 'inactive',
      missing: [
        { kind: 'plugin-absent', plugin: KIT, range: '>=0.4.0' },
        { kind: 'part-absent', part: 'toy.crud' },
      ],
    })
    expect(await skillNames(ctx)).not.toContain('space-data-page')
  })

  it('releases the parts source when the row unloads (HMR safety)', async () => {
    const ctx = await loadComposition(true)
    await [...ctx.loader.entries()]
      .find(entry => entry.options.name === '@deepseek-ai/dsh-experimental-skill-pack-components')?.fiber?.dispose()
    expect(ctx.get('skillPackParts')).toBeUndefined()
    expect(await skillNames(ctx)).not.toContain('space-data-page')
  })
})
