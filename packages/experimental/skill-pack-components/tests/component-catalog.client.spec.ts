/**
 * The component catalog file under `tests/expected/` is the file this tree
 * generates, and its header digests are the ones a reader recomputes from it.
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
import { PACK_MANIFEST_FIELDS, parsePackManifest, parsePackView } from '@deepseek-ai/dsh-experimental-skill-pack'
import { anchorFormatMissing, readsDeclaredViews } from '@deepseek-ai/dsh-experimental-skill-pack/src/manifest.ts'
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

/** One field of an object property, as the file states it. */
interface FieldFacts {
  readonly schema: { readonly kind: string; readonly fields?: Readonly<Record<string, FieldFacts>> }
}

/** One of a component's own properties, as the file states it. */
interface PropFacts extends FieldFacts {
  readonly viewOnly: boolean
  readonly unbindable: boolean
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
    readonly components: readonly {
      readonly id: string
      readonly placement: string
      readonly deploymentSwitches: readonly string[]
      readonly props: Readonly<Record<string, PropFacts>>
    }[]
    readonly rules: {
      readonly view: { readonly nodes: { readonly min: number; readonly max: number } }
      readonly layout: {
        readonly root: string
        readonly flex: { readonly min: number; readonly max: number; readonly integer: boolean }
      }
      readonly viewFile: { readonly otherKeys: string }
      readonly manifest: { readonly key: string; readonly otherKeys: string }
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

/**
 * Judge one spec the way a call is judged.
 * @param spec - the spec.
 * @returns the refusal's path, or `undefined` where the spec is accepted.
 */
function refusedAt(spec: unknown): string | undefined {
  const result = validateComponentCall(catalog, { id: 'v', title: 't', spec })
  return result.ok ? undefined : result.failure.path
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

  it('lists every component the kit registers, in registration order, each placed by a call', async () => {
    const { file } = await checkedIn()
    expect(file.body.components.map(component => component.id)).toEqual(COMPONENT_KIT_ENTRIES.map(entry => entry.id))
    expect(new Set(file.body.components.map(component => component.placement))).toEqual(new Set(['call']))
  })

  it('names dataPage as the switch the data page needs, and no switch for a component every composition offers', async () => {
    const { file } = await checkedIn()
    const switches = new Map(file.body.components.map(component => [component.id, component.deploymentSwitches]))
    expect(switches.get('toy.data-page')).toEqual(['dataPage'])
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

  it('marks a property unbindable exactly where the component surface refuses a $from on it as unbindable', async () => {
    const { file } = await checkedIn()
    const mismatches: string[] = []
    for (const component of file.body.components) {
      for (const [name, prop] of Object.entries(component.props)) {
        const props = { [name]: { $from: 'node:b.x' } }
        const result = validateComponentCall(catalog, { id: 'v', title: 't', spec: { nodes: [{ id: 'a', component: component.id, props }] } })
        const refused = !result.ok
          && result.failure.path === `spec.nodes[0].props.${name}`
          && result.failure.text.includes('cannot be read from another block')
        if (refused !== prop.unbindable) mismatches.push(`${component.id}.${name}`)
      }
    }
    expect(mismatches).toEqual([])
    const unbindable = (id: string, name: string): boolean | undefined =>
      file.body.components.find(component => component.id === id)?.props[name]?.unbindable
    expect(unbindable('toy.table', 'tableConfig')).toBe(true)
    expect(unbindable('el.metric', 'background')).toBe(true)
  })

  it('states viewOnly and unbindable on a component\'s own properties and not on the fields of an object property', async () => {
    const { file } = await checkedIn()
    const nested = file.body.components.flatMap(component => Object.values(component.props))
      .flatMap(prop => Object.values(prop.schema.fields ?? {}))
    expect(nested.length).toBeGreaterThan(0)
    for (const field of nested) {
      expect(field).not.toHaveProperty('viewOnly')
      expect(field).not.toHaveProperty('unbindable')
    }
  })

  it('writes out the lower bounds and the root kind the component surface judges a spec by', async () => {
    const { file } = await checkedIn()
    const { nodes } = file.body.rules.view
    const { root, flex } = file.body.rules.layout
    const nodeList = (count: number): unknown[] => Array.from({ length: count }, (_, index) => ({ ...METRIC, id: `n${index}` }))
    expect(refusedAt({ nodes: nodeList(nodes.min) })).toBeUndefined()
    expect(refusedAt({ nodes: nodeList(nodes.min - 1) })).toBe('spec.nodes')
    expect(refusedAt({ nodes: nodeList(nodes.max + 1) })).toBe('spec.nodes')
    const placed = (share: number): unknown => ({
      nodes: [METRIC],
      layout: { node: root, dir: 'row', children: [{ node: 'component', id: 'a', flex: share }] },
    })
    expect(refusedAt(placed(flex.min))).toBeUndefined()
    expect(refusedAt(placed(flex.max))).toBeUndefined()
    expect(refusedAt(placed(flex.min - 1))).toBe('spec.layout.children[0].flex')
    expect(flex.integer).toBe(true)
    expect(refusedAt(placed(flex.min + 0.5))).toBe('spec.layout.children[0].flex')
    expect(refusedAt({ nodes: [METRIC], layout: { node: 'component', id: 'a' } })).toBe('spec.layout.node')
  })

  it('refuses a view placing a second data page, or sorting one both ways, as its view rules say', () => {
    const page = (id: string, extra: Readonly<Record<string, unknown>> = {}): unknown =>
      ({ id, component: DATA_PAGE_ID, props: { relatedMeta: 'orders', metaLabel: '订单', ...extra } })
    const judged = (nodes: readonly unknown[]): string | undefined => {
      const result = judgeView(catalog, true, { id: 'v', title: 't', spec: { nodes } })
      return result.ok ? undefined : result.refusal.path
    }
    expect(judged([page('p'), METRIC])).toBeUndefined()
    expect(judged([page('p'), page('q')])).toBe('spec.nodes[1]')
    expect(judged([page('p', { querySort: { asc: 'a' } })])).toBeUndefined()
    expect(judged([page('p', { querySort: { asc: 'a', desc: 'b' } })])).toBe('spec.nodes[0].props.querySort.desc')
  })

  it('states the manifest key and the conditions on the two format fields as the pack root reads them', async () => {
    const { file } = await checkedIn()
    expect(parsePackManifest({ pack: { version: '1.0.0' }, notes: 'x' }))
      .toMatchObject({ ok: false, field: `${file.body.rules.manifest.key}.notes` })
    expect(PACK_MANIFEST_FIELDS.map(field => field.path)).toEqual(expect.arrayContaining(['pack.viewFormat', 'pack.anchorFormat', 'views']))
    const read = (pack: Readonly<Record<string, unknown>>, views?: readonly string[]): ReturnType<typeof parsePackManifest> =>
      parsePackManifest({ pack: { version: '1.0.0', ...pack }, ...views === undefined ? {} : { views } })
    const views = (pack: Readonly<Record<string, unknown>>, listed?: readonly string[]): boolean | undefined => {
      const result = read(pack, listed)
      return result.ok ? readsDeclaredViews(result.manifest) : undefined
    }
    expect(views({})).toBe(true)
    expect(views({}, ['v.yml'])).toBe(false)
    expect(views({ viewFormat: 1 }, ['v.yml'])).toBe(true)
    expect(views({ viewFormat: 2 }, ['v.yml'])).toBe(false)
    const anchors = (pack: Readonly<Record<string, unknown>>): string | undefined => {
      const result = read(pack)
      return result.ok ? anchorFormatMissing(result.manifest)?.kind : 'refused'
    }
    expect(anchors({})).toBeUndefined()
    expect(anchors({ anchorFormat: 1 })).toBeUndefined()
    expect(anchors({ anchorFormat: 2 })).toBe('anchor-format')
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
