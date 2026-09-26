/**
 * What one call answers with, run through the real tool runtime over a stub
 * backend.
 *
 * The runtime is the real one because that is what validates the arguments,
 * snapshots and validates the canonical value, and turns a throw into the
 * error a model reads: a case that called `execute` directly would assert a
 * value the registry might still refuse.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  BizBackendService,
  BizOperationRules,
  type BizBackendFailure,
  type BizMetaResult,
  type BizModelListResult,
  type BizModelSchemes,
  type BizUserRights,
} from '@deepseek-ai/dsh-experimental-biz-backend'
import * as SystemMap from '../src/index.ts'
import { DOMAIN_MODELS_TOOL_NAME, DOMAINS_TOOL_NAME, MODEL_TOOL_NAME } from '../src/text.ts'

/** What one stub answers with, for each of the four reads a call can make. */
interface StubAnswers {
  catalog?: BizModelListResult | BizBackendFailure
  rights?: BizUserRights | BizBackendFailure
  described?: BizMetaResult | BizBackendFailure
  schemes?: BizModelSchemes | BizBackendFailure
  /** The deployment's rule table; the defaults where left out. */
  rules?: BizOperationRules
}

/** Three models across two subject areas, as the catalog lists them. */
const CATALOG: BizModelListResult = {
  models: [
    { resClassEnName: 'SpaceLayer', resClassCnName: '空间图层', classDiagramType: 'TRANSO', classDiagramTypeCnName: '传输专业', dsTableName: 'SPACE_LAYER', remark: '图层配置', parentClassEnName: 'ResBase' },
    { resClassEnName: 'SITE', resClassCnName: '站点', classDiagramType: 'TRANSO', classDiagramTypeCnName: '传输专业' },
    { resClassEnName: 'CITY', resClassCnName: '地市', classDiagramType: 'COMMON', classDiagramTypeCnName: '公共专业' },
  ],
}

/**
 * A rights table granting two writes on one model and narrowing its editing,
 * holding a row that grants no flag for a second, and no row at all for the
 * third — the model this person may not look at.
 */
const RIGHTS: BizUserRights = {
  resclass: [
    { resclassenname: 'SpaceLayer', operations: ['add', 'search', 'update'], columns: 'zh_label' },
    { resclassenname: 'CITY', operations: [] },
  ],
  rows: [],
}

/**
 * A rights table holding a row granting no flag for every model of one catalog.
 * @param catalog - the catalog.
 * @returns the rights read.
 */
function rightsOver(catalog: BizModelListResult): BizUserRights {
  return { resclass: catalog.models.map(model => ({ resclassenname: model.resClassEnName, operations: [] })), rows: [] }
}

/** One model's attributes, as the description states them. */
const DESCRIBED: BizMetaResult = {
  attributes: [
    { attributeEnName: 'zh_label', attributeCnName: '名称', dataType: 'VARCHAR', dataLength: 128 },
    { attributeEnName: 'state', attributeCnName: '状态', dataType: 'VARCHAR', dataLength: 8 },
  ],
}

/**
 * A catalog big enough to overrun the smallest budget a deployment may set.
 *
 * Twelve models under one subject area, each line about thirty characters, so a
 * two-hundred-character budget stops part way through whichever listing is
 * being cut.
 * @returns the catalog.
 */
function wideCatalog(): BizModelListResult {
  return {
    models: Array.from({ length: 12 }, (_, index) => ({
      resClassEnName: `Model${String(index).padStart(2, '0')}`,
      resClassCnName: `资源模型${String(index)}`,
      classDiagramType: `AREA${String(index).padStart(2, '0')}`,
      classDiagramTypeCnName: `第${String(index)}号专业`,
    })),
  }
}

/** The same twelve models, all under one subject area. */
function oneAreaCatalog(): BizModelListResult {
  return { models: wideCatalog().models.map(model => ({ ...model, classDiagramType: 'AREA', classDiagramTypeCnName: '一个专业' })) }
}

/** Twelve attributes of one model, enough to overrun the smallest budget. */
function wideDescription(): BizMetaResult {
  return {
    attributes: Array.from({ length: 12 }, (_, index) => ({
      attributeEnName: `attribute_${String(index).padStart(2, '0')}`,
      attributeCnName: `属性名称${String(index)}`,
      dataType: 'VARCHAR',
      dataLength: 128,
    })),
  }
}

/** The same model's default schemes. */
const SCHEMES: BizModelSchemes = {
  schemes: [
    { schemaType: 1, formItems: [{ relatedMetaAttr: 'zh_label' }], columns: [{ relatedMetaAttr: 'zh_label', isShow: true }] },
    { schemaType: 2, formItems: [{ relatedMetaAttr: 'zh_label', isRequired: true }, { relatedMetaAttr: 'state', relatedDict: [{ key: '1', value: '在用' }] }], columns: [] },
  ],
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/**
 * A stub `ctx.bizBackend` answering exactly what one case states.
 * @param answers - what each read answers with.
 * @returns the plugin that installs it.
 */
function stubBackend(answers: StubAnswers) {
  return {
    name: 'stub-biz-backend',
    apply: (ctx: Context) => {
      // The real service with its four reads stubbed, so the judgement the
      // reads are filtered by is the one a deployment runs.
      class StubBizBackend extends BizBackendService {
        /**
         * Install the stub as `ctx.bizBackend`.
         * @param inner - the context that owns it.
         */
        constructor(inner: Context) {
          super(inner, 'https://biz.invalid/', { read: () => undefined, set: () => {}, drop: () => {} }, answers.rules ?? BizOperationRules({}))
        }

        /**
         * Answer the catalog read.
         * @returns what the case stated.
         */
        override listModels(): Promise<BizModelListResult | BizBackendFailure> {
          return Promise.resolve(answers.catalog ?? CATALOG)
        }

        /**
         * Answer the rights read.
         * @returns what the case stated.
         */
        override userRights(): Promise<BizUserRights | BizBackendFailure> {
          return Promise.resolve(answers.rights ?? RIGHTS)
        }

        /**
         * Answer the model description.
         * @returns what the case stated.
         */
        override describe(): Promise<BizMetaResult | BizBackendFailure> {
          return Promise.resolve(answers.described ?? DESCRIBED)
        }

        /**
         * Answer the scheme read.
         * @returns what the case stated.
         */
        override describeSchemes(): Promise<BizModelSchemes | BizBackendFailure> {
          return Promise.resolve(answers.schemes ?? SCHEMES)
        }
      }
      new StubBizBackend(ctx)
    },
  }
}

/**
 * Mount the tool runtime, a stub backend and this row.
 * @param answers - what the stub answers with.
 * @param config - the ceilings this deployment reads under.
 * @returns the context carrying all three.
 */
async function mount(answers: StubAnswers = {}, config: Partial<SystemMap.Config> = {}): Promise<Context> {
  // Cast at the boundary: schemastery defaults every field this partial omits,
  // and the plugin's declared `Config` is what it receives after that pass.
  const ctx = new Context()
  context = ctx
  // The runtime waits for the prompt registry it contributes schemas to, so a
  // composition without it never applies the row this file is about.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(stubBackend(answers))
  await ctx.plugin(SystemMap, config as SystemMap.Config)
  return ctx
}

/**
 * The composed tool runtime.
 *
 * `ctx.get` rather than the property: the property proxy is topology-sensitive
 * and these cases read the service from the context that mounted it.
 * @param ctx - the mounted context.
 * @returns the runtime.
 */
function runtimeOf(ctx: Context): ToolRuntime {
  return ctx.get('tools') as unknown as ToolRuntime
}

/**
 * Run one call through the composed registry.
 * @param ctx - the mounted context.
 * @param name - the tool to call.
 * @param args - the call's arguments.
 * @returns the settled execution.
 */
function run(ctx: Context, name: string, args: Record<string, unknown> = {}): Promise<ToolExecutionResult> {
  return runtimeOf(ctx).execute({
    callId: ToolCallId('call-1'),
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
}

/**
 * The text one settled call answers with.
 * @param result - the settled execution.
 * @returns the joined text of every content block.
 */
function textOf(result: ToolExecutionResult): string {
  return result.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

describe('the subject-area listing', () => {
  it('counts the models of every subject area this person may look at, in code order', async () => {
    const ctx = await mount()
    const result = await run(ctx, DOMAINS_TOOL_NAME)
    expect(result.isError).toBe(false)
    // SITE has no row in the rights table, so TRANSO counts one model, not two.
    expect(result.value).toEqual({
      domains: [
        { domain: 'COMMON', name: '公共专业', models: 1 },
        { domain: 'TRANSO', name: '传输专业', models: 1 },
      ],
      from: 0,
      shown: 2,
      total: 2,
      truncated: false,
    })
    expect(textOf(result)).toContain('COMMON name=公共专业 models=1')
  })

  it('leaves out a subject area holding no model this person may look at', async () => {
    const ctx = await mount({ rights: { resclass: [{ resclassenname: 'CITY', operations: [] }], rows: [] } })
    expect((await run(ctx, DOMAINS_TOOL_NAME)).value).toMatchObject({
      domains: [{ domain: 'COMMON', name: '公共专业', models: 1 }],
      total: 1,
    })
  })

  it('lists no subject area at all when the rights table names no model', async () => {
    const ctx = await mount({ rights: { resclass: [], rows: [] } })
    const result = await run(ctx, DOMAINS_TOOL_NAME)
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ domains: [], from: 0, shown: 0, total: 0, truncated: false })
    expect(textOf(result)).toContain('The data models the signed-in person may look at are sorted into 0 subject areas.')
  })

  it('lists nothing and says why when the rights cannot be read', async () => {
    const ctx = await mount({ rights: { kind: 'rejected', status: 400, code: 1, message: '用户未授权' } })
    const result = await run(ctx, DOMAINS_TOOL_NAME)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('This deployment refused the request (HTTP 400, code 1): 用户未授权.')
  })

  it('judges by the rule table this deployment wrote', async () => {
    // A deployment that makes reading a description require `search` hides
    // CITY, whose row grants no flag.
    const ctx = await mount({ rules: BizOperationRules({ metadata_read: ['search'] }) })
    expect((await run(ctx, DOMAINS_TOOL_NAME)).value).toMatchObject({
      domains: [{ domain: 'TRANSO', models: 1 }],
      total: 1,
    })
  })

  it('cuts at the deployment\'s budget and hands back a cursor its next call continues from', async () => {
    const ctx = await mount({ catalog: wideCatalog(), rights: rightsOver(wideCatalog()) }, { listingChars: 200 })
    const first = await run(ctx, DOMAINS_TOOL_NAME)
    const cut = first.value as { shown: number; total: number; truncated: boolean; cursor: string }
    expect(cut.total).toBe(12)
    expect(cut.truncated).toBe(true)
    expect(cut.shown).toBeLessThan(12)
    expect(textOf(first)).toContain(`Cut after ${String(cut.shown)} of 12; pass "${cut.cursor}" as \`after\` to continue.`)
    const next = await run(ctx, DOMAINS_TOOL_NAME, { after: cut.cursor })
    expect(next.value).toMatchObject({ from: cut.shown })
    expect(textOf(next)).not.toContain(`${cut.cursor} name=`)
  })

  it('refuses an empty cursor by naming the parameter that carried it', async () => {
    const ctx = await mount()
    const result = await run(ctx, DOMAINS_TOOL_NAME, { after: '' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('`after` was empty')
  })
})

describe('the model listing', () => {
  it('lists one subject area\'s models this person may look at, with what they may do with each', async () => {
    const ctx = await mount()
    const result = await run(ctx, DOMAIN_MODELS_TOOL_NAME, { domain: 'TRANSO' })
    expect(result.value).toEqual({
      domain: 'TRANSO',
      name: '传输专业',
      models: [
        {
          model: 'SpaceLayer',
          name: '空间图层',
          table: 'SPACE_LAYER',
          may: ['read', 'metadata_read', 'create', 'update', 'import', 'export'],
          note: '图层配置',
        },
      ],
      from: 0,
      shown: 1,
      total: 1,
      truncated: false,
    })
    expect(textOf(result)).not.toContain('SITE')
  })

  it('takes the subject area by the name a person is shown as well as by its code', async () => {
    const ctx = await mount()
    expect((await run(ctx, DOMAIN_MODELS_TOOL_NAME, { domain: '公共专业' })).value)
      .toMatchObject({ domain: 'COMMON', models: [{ model: 'CITY', may: ['read', 'metadata_read', 'export'] }] })
  })

  it('cuts one subject area\'s models at the budget', async () => {
    const ctx = await mount({ catalog: oneAreaCatalog(), rights: rightsOver(oneAreaCatalog()) }, { listingChars: 200 })
    const result = await run(ctx, DOMAIN_MODELS_TOOL_NAME, { domain: 'AREA' })
    const cut = result.value as { shown: number; total: number; truncated: boolean; cursor: string }
    expect(cut).toMatchObject({ total: 12, truncated: true, cursor: `Model${String(cut.shown - 1).padStart(2, '0')}` })
    expect(cut.shown).toBeLessThan(12)
  })

  it('names the subject areas this deployment has when it has none of the name asked for', async () => {
    const ctx = await mount()
    const result = await run(ctx, DOMAIN_MODELS_TOOL_NAME, { domain: 'TRANSMISSION' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('No subject area the signed-in person may look at is called "TRANSMISSION".')
    expect(textOf(result)).toContain('TRANSO (传输专业)')
  })

  it('refuses a subject area holding no model this person may look at as if it did not exist', async () => {
    const ctx = await mount({ rights: { resclass: [{ resclassenname: 'CITY', operations: [] }], rows: [] } })
    const hidden = textOf(await run(ctx, DOMAIN_MODELS_TOOL_NAME, { domain: 'TRANSO' }))
    expect(hidden).toBe(
      'Error: No subject area the signed-in person may look at is called "TRANSO". Pass `domain` as one of those: COMMON (公共专业).',
    )
  })

  it('refuses an empty subject area by naming the parameter that carried it', async () => {
    const ctx = await mount()
    expect(textOf(await run(ctx, DOMAIN_MODELS_TOOL_NAME, { domain: '' }))).toContain('`domain` was empty')
  })

  it('cuts the note it repeats to the deployment\'s ceiling', async () => {
    const ctx = await mount({}, { noteChars: 2 })
    expect((await run(ctx, DOMAIN_MODELS_TOOL_NAME, { domain: 'TRANSO' })).value)
      .toMatchObject({ models: [{ model: 'SpaceLayer', note: '图层' }] })
  })
})

describe('the one-model read', () => {
  it('answers with the model, its attributes and this person\'s rights', async () => {
    const ctx = await mount()
    const result = await run(ctx, MODEL_TOOL_NAME, { model: 'SpaceLayer' })
    expect(result.value).toEqual({
      model: 'SpaceLayer',
      name: '空间图层',
      domain: 'TRANSO',
      domainName: '传输专业',
      table: 'SPACE_LAYER',
      parent: 'ResBase',
      note: '图层配置',
      attributes: [
        { attribute: 'state', name: '状态', type: 'VARCHAR', length: 8, forms: ['add'], values: [{ stored: '1', shown: '在用' }] },
        { attribute: 'zh_label', name: '名称', type: 'VARCHAR', length: 128, required: true, forms: ['query', 'grid', 'add'] },
      ],
      may: ['read', 'metadata_read', 'create', 'update', 'import', 'export'],
      editableColumns: ['zh_label'],
      from: 0,
      shown: 2,
      total: 2,
      truncated: false,
    })
    expect(textOf(result)).toContain(
      'The signed-in person may perform these operations on this model: read, metadata_read, create, update, import, export.',
    )
  })

  it('takes the model by the name a person is shown as well as by its English name', async () => {
    const ctx = await mount()
    expect((await run(ctx, MODEL_TOOL_NAME, { model: '空间图层' })).value).toMatchObject({ model: 'SpaceLayer' })
  })

  it('answers a model whose row grants no flag with what the row alone permits', async () => {
    const ctx = await mount()
    const result = await run(ctx, MODEL_TOOL_NAME, { model: 'CITY' })
    expect(result.value).toMatchObject({ model: 'CITY', may: ['read', 'metadata_read', 'export'] })
    expect(result.value).not.toHaveProperty('editableColumns')
  })

  it('refuses a model the rights table never names in the words it refuses one that does not exist', async () => {
    const ctx = await mount()
    const hidden = await run(ctx, MODEL_TOOL_NAME, { model: 'SITE' })
    expect(hidden.isError).toBe(true)
    expect(textOf(hidden)).toBe('Error: No data model the signed-in person may look at is called "SITE". '
      + 'Pass `model` as either the English name this deployment keys a model by or the name it shows a person for one.')
    // By the name a person is shown as well: that is the other way in.
    expect(textOf(await run(ctx, MODEL_TOOL_NAME, { model: '站点' })))
      .toBe(textOf(hidden).replace('"SITE"', '"站点"'))
    expect(textOf(await run(ctx, MODEL_TOOL_NAME, { model: 'NoSuchModel' })))
      .toBe(textOf(hidden).replace('"SITE"', '"NoSuchModel"'))
  })

  it('cuts the attribute listing at the budget and continues past the cursor', async () => {
    const ctx = await mount({ described: wideDescription() }, { listingChars: 200 })
    const first = await run(ctx, MODEL_TOOL_NAME, { model: 'SpaceLayer' })
    const cut = first.value as { shown: number; total: number; truncated: boolean; cursor: string }
    expect(cut).toMatchObject({ total: 12, truncated: true })
    expect(cut.shown).toBeLessThan(12)
    expect((await run(ctx, MODEL_TOOL_NAME, { model: 'SpaceLayer', after: cut.cursor })).value)
      .toMatchObject({ from: cut.shown })
  })

  it('refuses a model this deployment does not have, and an empty one, by naming the parameter', async () => {
    const ctx = await mount()
    expect(textOf(await run(ctx, MODEL_TOOL_NAME, { model: 'SpaceLayers' })))
      .toContain('No data model the signed-in person may look at is called "SpaceLayers"')
    expect(textOf(await run(ctx, MODEL_TOOL_NAME, { model: '' }))).toContain('`model` was empty')
  })

  it('leaves out the shown name and the parent of a model the catalog states neither for', async () => {
    const catalog: BizModelListResult = { models: [{ resClassEnName: 'Bare', resClassCnName: '' }] }
    const ctx = await mount({ catalog, rights: rightsOver(catalog), described: { attributes: [] }, schemes: { schemes: [] } })
    const result = await run(ctx, MODEL_TOOL_NAME, { model: 'Bare' })
    expect(result.value).toEqual({
      model: 'Bare',
      domain: 'UNFILED',
      domainName: 'UNFILED',
      attributes: [],
      may: ['read', 'metadata_read', 'export'],
      from: 0,
      shown: 0,
      total: 0,
      truncated: false,
    })
  })
})

describe('a read this deployment would not answer', () => {
  /** Each failure the seam can answer with, and the sentence it becomes. */
  const CASES: readonly (readonly [BizBackendFailure, string])[] = [
    [{ kind: 'unauthenticated' }, 'Nobody is signed in to this deployment'],
    [{ kind: 'refused', status: 401 }, 'refused the signed-in person\'s credential (HTTP 401)'],
    [{ kind: 'rejected', status: 200, code: 4, message: '没有权限' }, 'refused the request (HTTP 200, code 4): 没有权限'],
    [{ kind: 'unreachable', detail: 'the answer listed no resource models' }, 'did not answer: the answer listed no resource models'],
  ]

  it('becomes a sentence saying why, on whichever of the four reads failed', async () => {
    for (const [failure, said] of CASES) {
      const ctx = await mount({ catalog: failure })
      expect(textOf(await run(ctx, DOMAINS_TOOL_NAME))).toContain(said)
      await ctx.fiber.dispose()
      context = undefined
    }
    for (const tool of [DOMAINS_TOOL_NAME, DOMAIN_MODELS_TOOL_NAME]) {
      const ctx = await mount({ rights: { kind: 'unauthenticated' } })
      expect(textOf(await run(ctx, tool, { domain: 'TRANSO' }))).toContain('Nobody is signed in to this deployment')
      await ctx.fiber.dispose()
      context = undefined
    }
    for (const read of ['rights', 'described', 'schemes'] as const) {
      const ctx = await mount({ [read]: { kind: 'unauthenticated' } })
      expect(textOf(await run(ctx, MODEL_TOOL_NAME, { model: 'SpaceLayer' })))
        .toContain('Nobody is signed in to this deployment')
      await ctx.fiber.dispose()
      context = undefined
    }
  })
})

describe('the row\'s own lifetime', () => {
  it('takes all three offers back off the next request when its fiber is disposed', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(stubBackend({}))
    const fork = ctx.plugin(SystemMap)
    await fork
    const names = () => runtimeOf(ctx).schemas().map(entry => entry.name)
    expect(names()).toEqual(expect.arrayContaining([DOMAINS_TOOL_NAME, DOMAIN_MODELS_TOOL_NAME, MODEL_TOOL_NAME]))
    await fork.dispose()
    for (const name of [DOMAINS_TOOL_NAME, DOMAIN_MODELS_TOOL_NAME, MODEL_TOOL_NAME]) {
      expect(names()).not.toContain(name)
    }
  })
})

describe('the cards a person sees', () => {
  it('names each call by what it is reading, and settles into the same card', async () => {
    const ctx = await mount()
    const [domains, models, model] = [DOMAINS_TOOL_NAME, DOMAIN_MODELS_TOOL_NAME, MODEL_TOOL_NAME]
      .map(name => runtimeOf(ctx).get(name))
    expect(domains?.presentCall?.({})).toEqual({
      card: 'generic',
      title: 'List this deployment\'s subject areas',
      kind: 'search',
    })
    expect(domains?.presentCall?.({ after: 'COMMON' })).toMatchObject({ rawInput: 'after COMMON' })
    expect(models?.presentCall?.({ domain: 'TRANSO' })).toEqual({
      card: 'generic',
      title: 'List a subject area\'s data models',
      kind: 'search',
      rawInput: 'TRANSO',
    })
    expect(models?.presentCall?.({ domain: 'TRANSO', after: 'SITE' })).toMatchObject({ rawInput: 'TRANSO, after SITE' })
    expect(model?.presentCall?.({ model: 'SpaceLayer' })).toEqual({
      card: 'generic',
      title: 'Read one data model',
      kind: 'read',
      rawInput: 'SpaceLayer',
    })
    expect(model?.presentCall?.({ model: 'SpaceLayer', after: 'state' })).toMatchObject({ rawInput: 'SpaceLayer, after state' })
    const settled = { content: [{ type: 'text' as const, text: 'read' }], isError: false }
    expect(domains?.presentResult?.({}, settled)).toMatchObject({ card: 'generic', content: settled.content })
    expect(models?.presentResult?.({ domain: 'TRANSO' }, settled)).toMatchObject({ card: 'generic', content: settled.content })
    expect(model?.presentResult?.({ model: 'SpaceLayer' }, settled)).toMatchObject({ card: 'generic', content: settled.content })
  })

  it('answers two reads in one step rather than queueing them', async () => {
    const ctx = await mount()
    const calls: readonly (readonly [string, Record<string, unknown>])[] = [
      [DOMAINS_TOOL_NAME, {}],
      [DOMAIN_MODELS_TOOL_NAME, { domain: 'TRANSO' }],
      [MODEL_TOOL_NAME, { model: 'SpaceLayer' }],
    ]
    for (const [name, args] of calls) {
      expect(runtimeOf(ctx).get(name)?.isConcurrencySafe?.(args)).toBe(true)
    }
  })
})
