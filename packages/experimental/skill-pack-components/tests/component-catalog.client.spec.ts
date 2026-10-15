/**
 * The component catalog file under `tests/expected/` is the file this tree
 * generates, its header digests are the ones a reader recomputes from it, and
 * what the generator writes itself states the judgement it restates.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  COMPONENT_KIT_ENTRIES,
  DATA_PAGE_ID,
  DATA_PAGE_VIEW_PROP_NAMES,
  readCatalog,
  withheldComponents,
} from '@deepseek-ai/dsh-experimental-component-surface'
import { validateComponentCall } from '@deepseek-ai/dsh-experimental-component-surface/src/validate.ts'
import { judgeView } from '@deepseek-ai/dsh-experimental-component-surface/src/views.ts'
import { parsePackManifest, parsePackView } from '@deepseek-ai/dsh-experimental-skill-pack'
import {
  COMPONENT_CATALOG_FORMAT,
  componentCatalogText,
  readCatalogPackage,
  readComponentCatalogVersions,
} from '../src/component-catalog.ts'

/** The checked-in file. */
const EXPECTED = new URL('./expected/component-catalog.json', import.meta.url)

/**
 * The component kit's own manifest, read by its place in the workspace rather
 * than through the package (whose types reach Vue 2's global JSX declarations
 * and so stay out of this typecheck program).
 */
const COMPONENT_KIT_MANIFEST = new URL('../../component-kit/package.json', import.meta.url)

/** One of a component's own properties, as the file states it. */
interface PropFacts {
  readonly viewOnly: boolean
  readonly unbindable: boolean
  readonly bindsFrom?: { readonly component: string; readonly output: string; readonly reason: string }
}

/** One component, as the file states it. */
interface ComponentFacts {
  readonly id: string
  readonly placement: string
  readonly deploymentSwitches: readonly string[]
  readonly props: Readonly<Record<string, PropFacts>>
  readonly outputs: readonly { readonly id: string; readonly readers?: string }[]
}

/** The parts of the file these cases read. */
interface CatalogFile {
  readonly header: {
    readonly catalogFormat: number
    readonly componentKit: { readonly package: string; readonly version: string }
    readonly toyCrudKit: { readonly package: string; readonly version: string }
    readonly bodySha256: string
    readonly exampleViewSha256: string | null
  }
  readonly body: {
    readonly components: readonly ComponentFacts[]
    readonly rules: {
      readonly layout: { readonly root: string; readonly flex: { readonly integer: boolean } }
      readonly viewFile: { readonly otherKeys: string }
      readonly manifest: { readonly otherKeys: string }
    }
  }
}

/** Read and parse the checked-in file. */
async function checkedIn(): Promise<{ text: string; file: CatalogFile }> {
  const text = await readFile(EXPECTED, 'utf8')
  return { text, file: JSON.parse(text) as CatalogFile }
}

/** Every component the kit registers, as a deployment offering all of them judges a call against. */
const catalog = readCatalog(COMPONENT_KIT_ENTRIES)

/** A node every catalog built from the kit accepts on its own. */
const METRIC = { id: 'a', component: 'el.metric', props: { process: 50 } }

/** A table every catalog built from the kit accepts on its own, which reports `selectionDetail`. */
const TABLE = { id: 't', component: 'toy.table', props: { tableConfig: { gridItems: [{ relatedMetaAttr: 'a' }] }, displayValueList: [{ a: 1 }] } }

/**
 * A record, node `r`, whose `dataList` is the given value.
 * @param dataList - the value, a `$from` reference or a list.
 * @returns the node.
 */
function record(dataList: unknown): unknown {
  return { id: 'r', component: 'toy.record', props: { dataList } }
}

/**
 * A data page with the given properties beside the two it requires.
 * @param id - the node id, or a reference standing for it.
 * @param extra - the other properties.
 * @returns the node.
 */
function dataPage(id: unknown, extra: Readonly<Record<string, unknown>> = {}): unknown {
  return { id, component: DATA_PAGE_ID, props: { relatedMeta: 'orders', metaLabel: '订单', ...extra } }
}

/**
 * A layout of one column placing the given children.
 * @param children - the stack's children.
 * @returns the layout.
 */
function column(children: readonly unknown[]): unknown {
  return { node: 'stack', dir: 'col', children }
}

/**
 * Judge one spec the way a call is judged.
 * @param spec - the spec.
 * @returns the refusal's path, or `undefined` where the spec is accepted.
 */
function refusedAt(spec: unknown): string | undefined {
  const result = validateComponentCall(catalog, { id: 'v', title: 't', spec })
  return result.ok ? undefined : result.failure.path
}

/**
 * Judge one view the way a pack view is judged, on a deployment offering the data page.
 * @param spec - the spec as the view file writes it.
 * @param params - the view file's params.
 * @returns the refusal's path, or `undefined` where the view is accepted.
 */
function viewRefusedAt(spec: unknown, params: Readonly<Record<string, unknown>> = {}): string | undefined {
  const result = judgeView(catalog, true, { id: 'v', title: 't', spec, params })
  return result.ok ? undefined : result.refusal.path
}

describe('the component catalog file', () => {
  it('is byte for byte what generating it from this tree writes', async () => {
    const { text } = await checkedIn()
    expect(componentCatalogText(readComponentCatalogVersions())).toBe(text)
    expect(text.endsWith('}\n')).toBe(true)
  })

  it('carries the SHA-256 of its compact body in its header, and no example view yet', async () => {
    const { file } = await checkedIn()
    expect(file.header.catalogFormat).toBe(COMPONENT_CATALOG_FORMAT)
    expect(file.header.bodySha256).toBe(createHash('sha256').update(JSON.stringify(file.body), 'utf8').digest('hex'))
    expect(file.header.exampleViewSha256).toBeNull()
  })

  it('states the component kit version its own manifest states, and the kit version it vendors', async () => {
    const { file } = await checkedIn()
    const manifest = JSON.parse(await readFile(COMPONENT_KIT_MANIFEST, 'utf8')) as {
      name: string
      version: string
      dependencies: Record<string, string>
    }
    expect(file.header.componentKit).toEqual({ package: manifest.name, version: manifest.version })
    expect(manifest.dependencies['@sumomok/toy-crud-kit'])
      .toBe(`file:./vendor/sumomok-toy-crud-kit-${file.header.toyCrudKit.version}.tgz`)
    expect(file.header.toyCrudKit.package).toBe('@sumomok/toy-crud-kit')
  })

  it('lists every component the kit registers, in registration order, the form page and the info card placed only by a view', async () => {
    const { file } = await checkedIn()
    expect(file.body.components.map(component => component.id)).toEqual(COMPONENT_KIT_ENTRIES.map(entry => entry.id))
    expect(file.body.components.filter(component => component.placement === 'view').map(component => component.id))
      .toEqual(['toy.form-page', 'toy.info-card'])
  })

  it('names the output the form page and the info card each read', async () => {
    const { file } = await checkedIn()
    const stated = file.body.components.flatMap(component => Object.entries(component.props)
      .filter(([, prop]) => prop.bindsFrom !== undefined)
      .map(([name, prop]) => [component.id, name, prop.bindsFrom?.component, prop.bindsFrom?.output]))
    expect(stated).toEqual([
      ['toy.form-page', 'request', DATA_PAGE_ID, 'editing'],
      ['toy.info-card', 'record', DATA_PAGE_ID, 'opened'],
    ])
  })

  it('states which outputs only a component a view places reads', async () => {
    const { file } = await checkedIn()
    const outputs = new Map(file.body.components.map(component => [component.id, component.outputs]))
    expect(outputs.get(DATA_PAGE_ID)?.map(output => [output.id, output.readers])).toEqual([['opened', 'view'], ['editing', 'view']])
    expect(outputs.get('toy.table')?.every(output => output.readers === undefined)).toBe(true)
  })

  it('names dataPage as the switch the data page needs, and no switch for a component every composition offers', async () => {
    const { file } = await checkedIn()
    const switches = new Map(file.body.components.map(component => [component.id, component.deploymentSwitches]))
    expect(switches.get('toy.data-page')).toEqual(['dataPage'])
    expect(switches.get('toy.form-page')).toEqual(['dataPage'])
    expect(switches.get('toy.info-card')).toEqual(['dataPage'])
    const withheld = withheldComponents({ dataPage: false, dataSource: false, defaultPageSize: 1, dataPageLoadTimeoutMs: 1 })
    expect(withheld).toContain('toy.data-page')
    for (const entry of COMPONENT_KIT_ENTRIES.filter(one => !withheld.includes(one.id))) {
      expect(switches.get(entry.id)).toEqual([])
    }
  })

  it('marks the data page\'s arrangement as set only in a view file', async () => {
    const { file } = await checkedIn()
    const page = file.body.components.find(component => component.id === 'toy.data-page')
    expect(Object.entries(page?.props ?? {}).filter(([, prop]) => prop.viewOnly).map(([name]) => name).sort())
      .toEqual([...DATA_PAGE_VIEW_PROP_NAMES].sort())
  })

  it('marks a table\'s configuration and a metric\'s color unbindable', async () => {
    const { file } = await checkedIn()
    const unbindable = (id: string, name: string): boolean | undefined =>
      file.body.components.find(component => component.id === id)?.props[name]?.unbindable
    expect(unbindable('toy.table', 'tableConfig')).toBe(true)
    expect(unbindable('el.metric', 'background')).toBe(true)
  })

  it('writes out the root kind and the whole-number flex the component surface judges a layout by', async () => {
    const { file } = await checkedIn()
    const { root, flex } = file.body.rules.layout
    const placed = (share: number): unknown => ({
      nodes: [METRIC],
      layout: { node: root, dir: 'row', children: [{ node: 'component', id: 'a', flex: share }] },
    })
    expect(refusedAt(placed(1))).toBeUndefined()
    expect(refusedAt({ nodes: [METRIC], layout: { node: 'component', id: 'a' } })).toBe('spec.layout.node')
    expect(flex.integer).toBe(true)
    expect(refusedAt(placed(1.5))).toBe('spec.layout.children[0].flex')
  })

  it('judges a spec, its nodes and its data page as the view rules state', () => {
    expect(refusedAt({ nodes: [METRIC] })).toBeUndefined()
    expect(refusedAt({ layout: column([{ node: 'component', id: 'a' }]) })).toBe('spec.nodes')
    expect(refusedAt({ nodes: [{ id: 'a', component: 'el.metric' }] })).toBe('spec.nodes[0].props')
    expect(refusedAt({ nodes: [{ ...METRIC, props: [] }] })).toBe('spec.nodes[0].props')
    expect(refusedAt({ nodes: [METRIC, METRIC] })).toBe('spec.nodes[1].id')
    expect(viewRefusedAt({ nodes: [dataPage('p'), dataPage('q')] })).toBe('spec.nodes[1]')
    expect(viewRefusedAt({ nodes: [dataPage('p', { querySort: { asc: 'a', desc: 'b' } })] })).toBe('spec.nodes[0].props.querySort.desc')
  })

  it('judges a stack, a placed block and the placement as the layout rules state', () => {
    const placing = (layout: unknown, nodes: readonly unknown[] = [METRIC]): string | undefined => refusedAt({ nodes, layout })
    const block = { node: 'component', id: 'a' }
    expect(placing(column([block]))).toBeUndefined()
    expect(placing({ node: 'stack', children: [block] })).toBe('spec.layout.dir')
    expect(placing({ node: 'stack', dir: 'col', flex: 1, children: [block] })).toBe('spec.layout.flex')
    expect(placing(column([{ node: 'component' }]))).toBe('spec.layout.children[0].id')
    expect(placing(column([block]), [METRIC, { ...METRIC, id: 'b' }])).toBe('spec.nodes[1].id')
    expect(placing(column([block, block]))).toBe('spec.layout.children[1].id')
  })

  it('judges a $from as the binding rules state', () => {
    const beside = (node: unknown): string | undefined => refusedAt({ nodes: [TABLE, node] })
    const bound = (from: unknown): string | undefined => beside(record(from))
    expect(bound({ $from: 'node:t.selectionDetail' })).toBeUndefined()
    expect(bound({ $from: 'node:t.selectionDetail', note: 'x' })).toBe('spec.nodes[1].props.dataList.$from')
    expect(bound([{ $from: 'node:t.selectionDetail[0]' }])).toBe('spec.nodes[1].props.dataList[0].$from')
    expect(bound({ $from: 'node:x.selectionDetail' })).toBe('spec.nodes[1].props.dataList.$from')
    expect(bound({ $from: 'node:t.nope' })).toBe('spec.nodes[1].props.dataList.$from')
    const metric = (props: Readonly<Record<string, unknown>>): unknown => ({ id: 'm', component: 'el.metric', props: { process: 1, ...props } })
    expect(beside(metric({ background: { $from: 'node:t.selectionDetail' } }))).toBe('spec.nodes[1].props.background')
    expect(beside(metric({ text: { $from: 'node:t.selectionDetail' } }))).toBe('spec.nodes[1].props.text.$from')
    expect(refusedAt({ nodes: [dataPage('p'), record({ $from: 'node:p.opened' })] })).toBe('spec.nodes[1].props.dataList.$from')
  })

  it('judges a view with its params as the param rules state', () => {
    const params = { table: 'orders', node: 'p' }
    expect(viewRefusedAt({ nodes: [dataPage({ $param: 'node' })] }, params)).toBeUndefined()
    expect(viewRefusedAt({ nodes: [{ $param: 'node' }] }, params)).toBe('spec.nodes[0]')
    expect(viewRefusedAt({ nodes: [dataPage('p', { relatedMeta: { $param: 'table', note: 'x' } })] }, params))
      .toBe('spec.nodes[0].props.relatedMeta')
    expect(viewRefusedAt({ nodes: [dataPage('p', { relatedMeta: { $param: 'other' } })] }, params)).toBe('spec.nodes[0].props.relatedMeta')
    expect(viewRefusedAt({ nodes: [dataPage('p', { relatedMeta: { $param: 'table' } })] }, { table: { name: 'orders' } }))
      .toBe('spec.nodes[0].props.relatedMeta')
    const judged = judgeView(catalog, true, {
      id: 'v',
      title: 't',
      spec: { nodes: [TABLE, record({ $from: 'node:t.selectionDetail' }), dataPage('p', { relatedMeta: { $param: 'table' } })] },
      params,
    })
    expect(judged.ok && judged.call.spec.nodes.map(node => node.props['dataList'] ?? node.props['relatedMeta']))
      .toEqual([undefined, { $from: 'node:t.selectionDetail' }, 'orders'])
  })

  it('says what the pack root does with a key it does not read, as the pack root does it', async () => {
    const { file } = await checkedIn()
    expect(file.body.rules.viewFile.otherKeys).toBe('ignored')
    expect(parsePackView('v.yml', 'id: a\ntitle: A\nspec: []\nnotes: x\n')).toMatchObject({ ok: true })
    expect(file.body.rules.manifest.otherKeys).toBe('refused')
    expect(parsePackManifest({ pack: { version: '1.0.0' }, notes: 'x' })).toMatchObject({ ok: false, field: 'metadata.notes' })
  })
})

describe('reading a package version for the header', () => {
  it('reads the name and version a manifest states', () => {
    expect(readCatalogPackage({ name: 'a', version: '1.2.3' }, 'a')).toEqual({ package: 'a', version: '1.2.3' })
  })

  it('refuses a manifest naming another package, or carrying no version', () => {
    expect(() => readCatalogPackage({ name: 'b', version: '1.2.3' }, 'a'))
      .toThrow('skill-pack-components: the package.json read for a names "b"')
    expect(() => readCatalogPackage(null, 'a')).toThrow('skill-pack-components: the package.json read for a names undefined')
    expect(() => readCatalogPackage({ name: 'a' }, 'a')).toThrow('skill-pack-components: the package.json of a carries no version')
    expect(() => readCatalogPackage({ name: 'a', version: '' }, 'a')).toThrow('skill-pack-components: the package.json of a carries no version')
  })
})
