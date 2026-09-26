/**
 * The catalog these specs judge against: the six components
 * `@deepseek-ai/dsh-experimental-component-kit` registers.
 *
 * Every deployment that offers `show_component` today composes that row, so
 * this is the catalog the shipped compositions actually run — which is what
 * keeps the refusals, the tool description and the depth ceiling these specs
 * pin the same values a user meets. Cases about a catalog nobody ships build
 * their own with `readCatalog`.
 * @module @deepseek-ai/dsh-experimental-component-surface/tests/kit-catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import { ComponentCatalogRegistry, type ComponentSource } from '../src/catalog.ts'
import {
  COMPONENT_KIT_ENTRIES,
  readCatalog,
  type ComponentCatalog,
  type ComponentCatalogEntry,
} from '../src/component-call.ts'

/** The component row's six components, as a catalog. */
export const KIT_CATALOG: ComponentCatalog = readCatalog(COMPONENT_KIT_ENTRIES)

/** The contributing package these specs register the six under; the real row reads its own manifest. */
export const KIT_SOURCE: ComponentSource = {
  package: '@deepseek-ai/dsh-experimental-component-kit',
  version: '0.0.0-test',
}

/**
 * Install the catalog registry on a hand-built context and register the six
 * components into it, the way the component row does.
 * @param ctx - the context to install it on.
 * @returns the disposer of the contribution, for cases that take it back out.
 */
export async function installKitCatalog(ctx: Context): Promise<() => void> {
  // The row installs one of its own, so a bench that already composed it
  // contributes into that registry rather than claiming the service twice.
  if (ctx.get('componentCatalog') === undefined) await ctx.plugin(ComponentCatalogRegistry).await()
  return ctx.componentCatalog.register({ entries: COMPONENT_KIT_ENTRIES, source: KIT_SOURCE })
}

/** The module name a composed row of {@link componentPlugin} is written under. */
export const COMPONENT_PLUGIN_NAME = 'test:component-plugin'

/**
 * A component plugin for the composition specs: it contributes the same six
 * components the component row does, through the same registry, and knows
 * nothing else.
 *
 * A stand-in rather than the real row, because the real one depends on this
 * package: the seam under test is the registry, and what a composition has to
 * prove is that a package this one does not own can fill it.
 * @param entries - the components to contribute; the component row's six by default.
 * @returns the plugin to write into a test-only `cordis.yml` module table.
 */
export function componentPlugin(
  entries: readonly ComponentCatalogEntry[] = COMPONENT_KIT_ENTRIES,
): { name: string; inject: readonly string[]; apply: (ctx: Context) => void } {
  return {
    name: 'test-component-plugin',
    // Declared rather than nested, so the Loader's own await covers the
    // contribution and a composed row is offered its tool by the time the boot
    // settles.
    inject: ['componentCatalog'],
    apply(ctx: Context) {
      ctx.componentCatalog.register({ entries, source: KIT_SOURCE })
    },
  }
}
