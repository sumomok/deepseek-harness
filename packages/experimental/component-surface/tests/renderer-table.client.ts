/**
 * The renderer table these seat specs draw through.
 *
 * The seat reads two things off the browser registry — the catalog to judge a
 * payload against, and the renderer to draw each accepted block with — so a
 * case about what the seat draws builds the table directly rather than booting
 * a client Cordis context to fill one.
 * @module @deepseek-ai/dsh-experimental-component-surface/tests/renderer-table
 */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { componentKitRenderers } from '@deepseek-ai/dsh-experimental-component-kit/src/client/index.ts'
import { en as kitEn } from '@deepseek-ai/dsh-experimental-component-kit/src/client/locales.ts'
import { readCatalog, type ComponentCatalogEntry } from '../src/component-call.ts'
import type { ComponentRenderer } from '../src/client/renderer.ts'
import type { ComponentRendererTable, RegisteredRenderer } from '../src/client/registry.ts'

/**
 * Build the table a seat draws through.
 * @param components - the definitions and the renderers a component plugin would have registered.
 * @param t - the translate those renderers receive, as their own package bound it.
 * @returns the table to hand the seat.
 */
export function rendererTable(
  components: readonly { readonly entry: ComponentCatalogEntry; readonly render: ComponentRenderer }[],
  t: Translate,
): ComponentRendererTable {
  const table = new Map<string, RegisteredRenderer>(
    components.map(one => [one.entry.id as string, { render: one.render, t }]))
  return {
    catalog: readCatalog(components.map(one => one.entry)),
    rendererFor: (id: string) => table.get(id),
  }
}

/**
 * The table a page composing the component row draws through: its six
 * components, and its own dictionary behind their translate.
 * @returns the table to hand the seat.
 */
export function kitRendererTable(): ComponentRendererTable {
  return rendererTable(componentKitRenderers(), makeTranslate(kitEn))
}

/** The table a page composing no component row at all draws through. */
export const NO_COMPONENTS: ComponentRendererTable = rendererTable([], makeTranslate({}))
