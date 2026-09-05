// @vitest-environment jsdom
// The row's browser barrel reaches element-ui, whose own module reads
// `document` as it evaluates. A claim about that barrel is type-level, but
// importing it is not, so this file needs a DOM like every other browser spec.
/**
 * The pin between this package's catalog and the component row's renderer
 * table: every catalog id must name a renderer, and the compiler must be the
 * one that says so.
 *
 * The claim is only worth as much as its negative. `CatalogId` is derived from
 * `COMPONENT_CATALOG`, so the positive direction is proved by the seat
 * compiling at all; what cannot be seen from a green build is whether a catalog
 * that gained an entry would actually be rejected. This file states that case
 * directly, over a catalog one entry ahead of the row — what adding a component
 * looks like the moment before its renderer exists.
 */

import { describe, expect, it } from 'vitest'
import { COMPONENT_RENDERERS, type ComponentRenderer } from '@deepseek-ai/dsh-experimental-component-kit/client'
import { COMPONENT_CATALOG, type ComponentCatalogEntry } from '../src/component-call.ts'

/** The catalog with one component this row has no renderer for. */
const CATALOG_AHEAD = [
  ...COMPONENT_CATALOG,
  {
    id: 'el.not-drawn-yet',
    label: '未画',
    purpose: 'Stands in for a component declared before its renderer exists.',
    propsSchema: {},
    actions: [],
  },
] as const satisfies readonly ComponentCatalogEntry[]

/** Ids of {@link CATALOG_AHEAD}, derived exactly as `CatalogId` is derived from the real catalog. */
type IdAhead = (typeof CATALOG_AHEAD)[number]['id']

describe('the renderer table against the catalog', () => {
  it('stops compiling when the catalog names a component the row cannot draw', () => {
    // @ts-expect-error - `el.not-drawn-yet` has no renderer, so the table no
    // longer covers the catalog. Removing the derivation from the seat's
    // `satisfies` — pinning a hand-written union instead — is what would make
    // this line compile and let a blank block reach a user.
    const uncovered: Record<IdAhead, ComponentRenderer> = COMPONENT_RENDERERS
    // The same table today, which is the positive half: every id the real
    // catalog declares, and nothing the catalog does not. As a set, because the
    // order a row lists its renderers in is that row's business — the order
    // blocks are drawn in is the spec's.
    expect(Object.keys(uncovered).sort()).toEqual(COMPONENT_CATALOG.map(entry => entry.id).toSorted())
  })
})
