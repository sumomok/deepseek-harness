/**
 * REAL-composition coverage: a test-only cordis.yml booted through the vendored
 * Loader mounts the tool runtime, the prompt registry and a stub data backend,
 * and every case here observes the composed application — whether the three
 * reads are offered at all, what their descriptions promise the model, what a
 * composed read leaves out for a person who may not look at a model, and what a
 * ceiling this deployment could not read under does at load. Disposal is
 * `tools.spec.ts`, over the same registry.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import {
  BizBackendService,
  BizOperationRules,
  type BizModelListResult,
  type BizUserRights,
} from '@deepseek-ai/dsh-experimental-biz-backend'
import * as SystemMap from '../src/index.ts'
import { DOMAIN_MODELS_TOOL_NAME, DOMAINS_TOOL_NAME, MODEL_TOOL_NAME } from '../src/text.ts'

/** The three names a composed row offers. */
const OFFERED = [DOMAINS_TOOL_NAME, DOMAIN_MODELS_TOOL_NAME, MODEL_TOOL_NAME]

/** The name of the stub row, as the composition's module table resolves it. */
const STUB_BACKEND = 'stub-biz-backend'

let world: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

/**
 * The real `ctx.bizBackend` with its two reads stubbed, mounted through the same
 * module table the real one would be, so the judgement is the deployment's own.
 */
class StubBizBackend extends BizBackendService {
  /**
   * Install the stub as `ctx.bizBackend`, judging by the default rules.
   * @param ctx - Cordis context that owns the service.
   */
  constructor(ctx: Context) {
    super(ctx, 'https://biz.invalid/', { read: () => undefined, set: () => {}, drop: () => {} }, BizOperationRules({}))
  }

  /**
   * Answer with two models under one subject area.
   * @returns the catalog.
   */
  override listModels(): Promise<BizModelListResult> {
    return Promise.resolve({
      models: [
        { resClassEnName: 'SpaceLayer', resClassCnName: '空间图层', classDiagramType: 'TRANSO', classDiagramTypeCnName: '传输专业' },
        { resClassEnName: 'SITE', resClassCnName: '站点', classDiagramType: 'TRANSO', classDiagramTypeCnName: '传输专业' },
      ],
    })
  }

  /**
   * Answer with a row for one of the two models.
   * @returns the rights.
   */
  override userRights(): Promise<BizUserRights> {
    return Promise.resolve({ resclass: [{ resclassenname: 'SpaceLayer', operations: ['add'] }], rows: [] })
  }
}

/** The stub as a Cordis plugin, which is how the loader mounts it. */
const StubBackendPlugin = { name: STUB_BACKEND, apply: (ctx: Context) => { new StubBizBackend(ctx) } }

/** How one composition is written. */
interface Composition {
  /** Whether the data backend is composed beside this row. */
  readonly backend?: boolean
  /** The listing budget this deployment sets, where it sets one. */
  readonly listingChars?: number
}

/**
 * Write a cordis.yml and boot it through the real Loader.
 * @param composition - what the deployment composed.
 * @returns the booted context.
 */
async function loadComposition(composition: Composition = {}): Promise<Context> {
  world = await mkdtemp(join(tmpdir(), 'dsh-system-map-'))
  const configPath = join(world, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    ...composition.backend === false ? [] : [`- name: '${STUB_BACKEND}'`],
    '- id: system-map',
    "  name: '@deepseek-ai/dsh-experimental-system-map'",
    ...composition.listingChars === undefined
      ? []
      : ['  config:', `    listingChars: ${String(composition.listingChars)}`],
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = `${pathToFileURL(world).href}/`
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    [STUB_BACKEND, StubBackendPlugin],
    ['@deepseek-ai/dsh-experimental-system-map', SystemMap],
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

/**
 * The names the composed runtime offers a model.
 * @param ctx - the booted composition.
 * @returns the offered tool names.
 */
function offered(ctx: Context): readonly string[] {
  return (ctx.get('tools') as unknown as ToolRuntime).schemas().map(entry => entry.name)
}

describe('the composed row', () => {
  it('offers all three reads where the deployment composed a data backend', async () => {
    const ctx = await loadComposition()
    expect(offered(ctx)).toEqual(expect.arrayContaining([...OFFERED]))
  })

  it('offers no read at all where the deployment composed none', async () => {
    // Pending rather than degraded: each description promises an account of
    // this deployment's own business system, and a composition with nothing to
    // read has none to give.
    const ctx = await loadComposition({ backend: false })
    for (const name of OFFERED) expect(offered(ctx)).not.toContain(name)
  })

  it('puts each description and every parameter in front of the model', async () => {
    const ctx = await loadComposition()
    const schemas = (ctx.get('tools') as unknown as ToolRuntime).schemas()
    const domains = schemas.find(entry => entry.name === DOMAINS_TOOL_NAME)
    const models = schemas.find(entry => entry.name === DOMAIN_MODELS_TOOL_NAME)
    const model = schemas.find(entry => entry.name === MODEL_TOOL_NAME)
    expect(domains?.description).toContain('subject areas this deployment divides its business data into')
    expect(Object.keys(domains?.parameters.properties ?? {})).toEqual(['after'])
    expect(Object.keys(models?.parameters.properties ?? {})).toEqual(['domain', 'after'])
    expect(models?.parameters.required).toEqual(['domain'])
    expect(Object.keys(model?.parameters.properties ?? {})).toEqual(['model', 'after'])
    expect(model?.parameters.required).toEqual(['model'])
  })

  it('lists and reads only the models the signed-in person may look at', async () => {
    const ctx = await loadComposition()
    const runtime = ctx.get('tools') as unknown as ToolRuntime
    const call = (name: string, args: Record<string, unknown>) => runtime.execute({
      callId: ToolCallId('call-1'),
      name,
      arguments: args,
      signal: new AbortController().signal,
    })
    expect((await call(DOMAINS_TOOL_NAME, {})).value).toMatchObject({ domains: [{ domain: 'TRANSO', models: 1 }] })
    const listed = await call(DOMAIN_MODELS_TOOL_NAME, { domain: 'TRANSO' })
    expect(listed.value).toMatchObject({
      models: [{ model: 'SpaceLayer', may: ['read', 'metadata_read', 'create', 'import', 'export'] }],
      total: 1,
    })
    const hidden = await call(MODEL_TOOL_NAME, { model: 'SITE' })
    expect(hidden.isError).toBe(true)
    expect(JSON.stringify(hidden.content)).toContain('No data model the signed-in person may look at is called \\"SITE\\"')
  })

  it('refuses to load under a budget no listing could be written in', async () => {
    // Loud at load: a budget of one character would answer every call with a
    // single cut line, with no diagnostic naming the row that set it.
    await expect(loadComposition({ listingChars: 1 })).rejects.toThrow('listingChars')
  })
})
