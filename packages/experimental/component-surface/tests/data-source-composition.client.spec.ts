/**
 * REAL-composition coverage for the data-source half: a test-only cordis.yml
 * booted through the vendored Loader mounts the tool runtime, the session
 * store, the real approval service, and a stub data backend, and every
 * assertion observes the composed application — whether the tool is offered at
 * all, what the description promises, and what the session log holds after one
 * question was put to the user and answered.
 *
 * The approval service is the shipped one rather than a stub, because the
 * sentence the user is asked reaches the log through it: pinning that sentence
 * off a real `approval/asked` is what proves the card a person reads carries
 * the promise this row makes about their ticked rows.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import UserApproval from '@deepseek-ai/dsh-user-approval'
import type { BizMetaResult, BizSearchRequest, BizSearchResult } from '@deepseek-ai/dsh-experimental-biz-backend'
import ContentSurfaceRegistry from '@deepseek-ai/dsh-experimental-content-surface'
import * as ShowComponent from '../src/index.ts'

let world: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

/** Every read this stub answered, so a composed run can be told from an unrun one. */
const reads: BizSearchRequest[] = []

/**
 * A stub `ctx.bizBackend`, mounted through the same module table the real one
 * would be: what this file exercises is the row's own injection, not the
 * backend's wire.
 */
class StubBizBackend extends Service {
  /**
   * Install the stub as `ctx.bizBackend`.
   * @param ctx - Cordis context that owns the service.
   */
  constructor(ctx: Context) {
    super(ctx, 'bizBackend')
  }

  /**
   * Answer that a visitor's token is held, which every composed read here has.
   * @returns true.
   */
  holdsCredential(): boolean {
    return true
  }

  /**
   * Answer with a two-attribute dictionary.
   * @returns the attributes.
   */
  describe(): Promise<BizMetaResult> {
    return Promise.resolve({
      attributes: [
        { attributeEnName: 'zh_label', attributeCnName: '名称' },
        { attributeEnName: 'layer_id', attributeCnName: '图层id' },
      ],
    })
  }

  /**
   * Answer with one row.
   * @param request - the read that went out.
   * @returns the row, twice over.
   */
  search(request: BizSearchRequest): Promise<BizSearchResult> {
    reads.push(request)
    const row = { zh_label: '东风站', layer_id: 'element:site' }
    return Promise.resolve({ rawValue: [row], displayValue: [row], total: 1 })
  }
}

/** The stub as a Cordis plugin, which is how the loader mounts it. */
const StubBackendPlugin = { name: 'stub-biz-backend', apply: (ctx: Context) => { new StubBizBackend(ctx) } }

/** One table block whose rows a data source fills. */
const SPEC = {
  nodes: [{
    id: 'rows',
    component: 'toy.table',
    props: { tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label', alias: '名称' }, { relatedMetaAttr: 'layer_id' }] } },
  }],
}

/** The `dataSource` the composed call sends. */
const SOURCE = [{ nodeId: 'rows', meta: 'SpaceLayer', metaLabel: '图层配置' }]

/** How one composition is written. */
interface Composition {
  /** Whether the row announces a data source. */
  readonly dataSource?: boolean
  /** Whether the backend is composed beside it. */
  readonly backend?: boolean
  /** The deployment's approval stance; `'never'` refuses every question. */
  readonly policy?: 'ask' | 'never'
  /** Rows one read asks for when the call names none. */
  readonly dataDefaultPageSize?: number
}

/**
 * Write a cordis.yml and boot it through the real Loader.
 * @param composition - what the deployment composed.
 * @returns the booted context.
 */
async function loadComposition(composition: Composition = {}): Promise<Context> {
  world = await mkdtemp(join(tmpdir(), 'dsh-show-component-data-'))
  const configPath = join(world, 'cordis.yml')
  const rowConfig = [
    ...composition.dataSource === undefined ? [] : [`    dataSource: ${String(composition.dataSource)}`],
    ...composition.dataDefaultPageSize === undefined ? [] : [`    dataDefaultPageSize: ${composition.dataDefaultPageSize}`],
  ]
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-experimental-content-surface'",
    "- name: '@deepseek-ai/dsh-user-approval'",
    '  config:',
    `    policy: ${composition.policy ?? 'never'}`,
    ...composition.backend === false ? [] : ["- name: 'stub-biz-backend'"],
    '- id: show-component',
    "  name: '@deepseek-ai/dsh-experimental-component-surface'",
    ...rowConfig.length === 0 ? [] : ['  config:', ...rowConfig],
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(world).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-experimental-content-surface', ContentSurfaceRegistry],
    ['@deepseek-ai/dsh-user-approval', UserApproval],
    ['stub-biz-backend', StubBackendPlugin],
    ['@deepseek-ai/dsh-experimental-component-surface', ShowComponent],
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
 * One session with a turn open, which an approval question requires.
 * @param ctx - the loaded composition.
 * @returns the session and a fake agent over it.
 */
function openTurn(ctx: Context): { session: Session; agent: Agent } {
  const session = (ctx.get('sessions') as unknown as SessionStore).create()
  session.append('turn/start', { turn: 1 })
  return { session, agent: { id: session.id, session } as unknown as Agent }
}

/**
 * Run one `show_component` call through the composed registry.
 * @param ctx - the loaded composition.
 * @param agent - the agent the call runs for.
 * @param args - the call's arguments.
 * @returns the settled execution.
 */
function run(ctx: Context, agent: Agent, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: ToolCallId('call-1'),
    name: 'show_component',
    arguments: args,
    agent,
    signal: new AbortController().signal,
  })
}

describe('the composed data-source row', () => {
  it('offers no data source at all where the deployment did not ask for one', async () => {
    const ctx = await loadComposition()
    const [schema] = ctx.tools.schemas().filter(entry => entry.name === 'show_component')
    expect(schema?.description).not.toContain('dataSource')
  })

  it('offers one where the deployment asked and both seams are composed', async () => {
    const ctx = await loadComposition({ dataSource: true, dataDefaultPageSize: 50 })
    const [schema] = ctx.tools.schemas().filter(entry => entry.name === 'show_component')
    expect(schema?.description).toContain('A read asks for 50 rows where it names no count, and there is no way to ask for a second page')
  })

  it('offers no tool at all where the deployment asked and no backend is composed', async () => {
    // Pending rather than degraded: the description names a parameter, and a
    // parameter with nothing behind it is an offer that cannot be kept.
    const ctx = await loadComposition({ dataSource: true, backend: false })
    expect(ctx.tools.schemas().map(entry => entry.name)).not.toContain('show_component')
  })

  it('refuses to load with a default page a table could not draw', async () => {
    await expect(loadComposition({ dataSource: true, dataDefaultPageSize: 900 })).rejects
      .toThrow('component-surface: dataDefaultPageSize must be between 1 and 500, received 900')
  })

  it('puts the question to the real approval service, and records it verbatim', async () => {
    const ctx = await loadComposition({ dataSource: true })
    const { session, agent } = openTurn(ctx)
    const before = reads.length
    const result = await run(ctx, agent, { id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE })
    const asked = session.snapshotEvents().filter(event => event.type === 'approval/asked')
    expect(asked).toHaveLength(1)
    expect((asked[0] as { data: { toolName: string; reason?: string } }).data.reason).toBe(
      '用您的账号查一份数据：从「图层配置」里取最多 200 条，只取「名称」等 2 列。\n'
      + '数据表：SpaceLayer\n\n'
      + '取回来的数据画成表格放在右边，小助手看不到表里的内容；您在表里勾选的行，会作为您的选择告诉小助手。',
    )
    // `policy: never` answers every question without an answerer, so this is
    // the refusal path end to end: nothing was read, and nothing was recorded.
    expect(session.snapshotEvents().filter(event => event.type === 'approval/decided')).toHaveLength(1)
    expect(result.isError).toBe(true)
    expect(reads).toHaveLength(before)
    expect(session.snapshotEvents().filter(event => event.type === 'content-component/resolved')).toEqual([])
    expect(ctx.sessionProjections.snapshot(session).values.contentSurface?.entries).toEqual([])
  })

  it('draws the rows it read into the column the deployment composed', async () => {
    const ctx = await loadComposition({ dataSource: true, policy: 'ask' })
    // With `policy: 'ask'` and no answerer the service fails closed, so the
    // grant has to come from an answerer this composition registers.
    ctx.on('approval/request', () => Promise.resolve('allowed-once'))
    const { session, agent } = openTurn(ctx)
    const result = await run(ctx, agent, { id: 'layers', title: '图层', spec: SPEC, dataSource: SOURCE })
    expect(result.isError).toBeFalsy()
    expect(reads.at(-1)).toMatchObject({ meta: 'SpaceLayer', source: ['zh_label', 'layer_id'] })
    expect(ctx.sessionProjections.snapshot(session).values.contentSurface?.entries).toEqual([{
      kind: 'component',
      entryId: 'layers',
      seq: expect.any(Number) as number,
      title: '图层',
      payload: {
        spec: {
          nodes: [{
            id: 'rows',
            component: 'toy.table',
            props: {
              tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label', alias: '名称' }, { relatedMetaAttr: 'layer_id', alias: '图层id' }] },
              displayValueList: [{ zh_label: '东风站', layer_id: 'element:site' }],
              rawValueList: [{ zh_label: '东风站', layer_id: 'element:site' }],
            },
          }],
        },
      },
    }])
  })
})
