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
import { COMPONENT_KIT_ENTRIES, DATA_PAGE_VIEW_PROP_NAMES, withheldComponents } from '@deepseek-ai/dsh-experimental-component-surface'
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
      readonly props: Readonly<Record<string, { readonly viewOnly: boolean }>>
    }[]
    readonly rules: {
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

  it('states the component kit version its own manifest states', async () => {
    const { file } = await checkedIn()
    const manifest = JSON.parse(await readFile(COMPONENT_KIT_MANIFEST, 'utf8')) as { name: string; version: string }
    expect(file.header.componentKit).toEqual({ package: manifest.name, version: manifest.version })
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
