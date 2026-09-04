/**
 * The shared vocabulary both halves of the seam read: the catalog lookups, the
 * lines a refusal and the tool description are both built from, and the two
 * readers that turn a logged argument value into a call's arguments.
 *
 * Nothing here judges a call — that is `validate.ts`'s whole job, and the split
 * is what lets the browser seat read the catalog without carrying the
 * judgement's failure text into a page.
 */

import { describe, expect, it } from 'vitest'
import {
  catalogEntry,
  catalogLabels,
  COMPONENT_CATALOG,
  COMPONENT_KIND,
  CONFIRM_BAR_ID,
  describeCatalog,
  MAX_SPEC_DEPTH,
  maxSpecDepthOf,
  parseComponentCall,
  readComponentCall,
  SHOW_COMPONENT_TOOL_NAME,
  type ComponentCatalogEntry,
} from '../src/component-call.ts'

describe('component catalog', () => {
  it('claims one wire tool name and one content kind', () => {
    expect(SHOW_COMPONENT_TOOL_NAME).toBe('show_component')
    expect(COMPONENT_KIND).toBe('component')
  })

  it('offers the confirmation bar under a Chinese name the user reads', () => {
    const entry = catalogEntry(CONFIRM_BAR_ID)
    expect(entry?.label).toBe('确认条')
    expect(Object.keys(entry?.propsSchema ?? {})).toEqual(['title', 'message', 'buttons'])
  })

  it('knows no component it does not list', () => {
    expect(catalogEntry('toy.table')).toBeUndefined()
    expect(catalogEntry(42)).toBeUndefined()
  })

  it('renders every component as one id — label — purpose line', () => {
    expect(describeCatalog()).toBe(
      '- el.confirm-bar — 确认条 — A short prompt above a row of buttons, for putting one decision in front of the user.',
    )
    expect(describeCatalog().split('\n')).toHaveLength(COMPONENT_CATALOG.length)
  })

  it('names the components a spec places in the wording shown on screen', () => {
    expect(catalogLabels([
      { id: 'a', component: CONFIRM_BAR_ID, props: {} },
      { id: 'b', component: CONFIRM_BAR_ID, props: {} },
    ])).toBe('确认条、确认条')
  })

  it('falls back to the raw id for a node naming no catalog entry', () => {
    // Reachable from a persisted entry written before a component was renamed:
    // `resolve` deliberately consults no catalog, so a stored spec can outlive
    // the table the call was accepted against.
    expect(catalogLabels([{ id: 'a', component: 'toy.table', props: {} }])).toBe('toy.table')
  })
})

describe('the spec nesting ceiling', () => {
  /** One catalog entry around a declared property, for measuring what that property costs. */
  function entryWith(schema: ComponentCatalogEntry['propsSchema']): ComponentCatalogEntry {
    return { id: 'toy.probe', label: '探针', purpose: 'Measured, never placed.', propsSchema: schema, actions: [] }
  }

  it('leaves room for the deepest document this deployment declares as legal', () => {
    // spec, nodes, one node, its props, the buttons list, one button.
    expect(MAX_SPEC_DEPTH).toBe(6)
  })

  it('spends four levels on a component whose properties are all scalars', () => {
    expect(maxSpecDepthOf([entryWith({ text: { required: true, schema: { kind: 'string', maxLength: 8 } } })])).toBe(4)
  })

  it('widens by one for a record-valued property', () => {
    const nested = entryWith({
      header: {
        required: false,
        schema: { kind: 'object', fields: { title: { required: true, schema: { kind: 'string', maxLength: 8 } } } },
      },
    })
    expect(maxSpecDepthOf([nested])).toBe(5)
    expect(maxSpecDepthOf([...COMPONENT_CATALOG, nested])).toBe(MAX_SPEC_DEPTH)
  })
})

describe('reading one call argument value', () => {
  it('reads a decoded argument record, the form Code Mode logs', () => {
    expect(readComponentCall({ id: 'budget', title: '预算', spec: { nodes: [] } }))
      .toEqual({ id: 'budget', title: '预算', spec: { nodes: [] } })
  })

  it('reads nothing from a value that is not an argument record', () => {
    expect(readComponentCall(null)).toBeUndefined()
    expect(readComponentCall('budget')).toBeUndefined()
    expect(readComponentCall([{ id: 'budget' }])).toBeUndefined()
  })

  it('reads raw argument JSON, the form a top-level call logs', () => {
    expect(parseComponentCall('{"id":"budget","title":"预算"}')).toEqual({ id: 'budget', title: '预算' })
  })

  it('reads nothing from a log line no reader can decode', () => {
    expect(parseComponentCall('{"id":')).toBeUndefined()
    expect(parseComponentCall('"budget"')).toBeUndefined()
  })
})
