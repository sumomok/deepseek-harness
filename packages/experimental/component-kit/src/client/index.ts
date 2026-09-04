/**
 * Component row, browser half. It registers its dictionaries and exports the
 * renderer table; it declares no slot and knows no layout, so a placement
 * package decides where a block is drawn.
 *
 * The table is the row's whole surface. A placement package requests it through
 * the loader's module table
 * (`dsh.client.external: ['@deepseek-ai/dsh-experimental-component-kit/client']`),
 * looks a component up by the id a validated block names, and hands the block's
 * properties over as {@link ComponentRendererProps}. The table's keys stay
 * literal ids, so a placement package whose catalog derives a union of its own
 * ids can require this table to cover that union, and fails to compile the day
 * its catalog names a component this row cannot draw.
 *
 * This row has no host half worth the name and reads no configuration: a
 * component here draws its properties and reports what the user pressed. It
 * performs no navigation, no request, and no write of its own.
 *
 * Two kinds of component live here. One is written in this repository as
 * ordinary React and depends on nothing else. The other is a Vue 2 component
 * compiled outside it and vendored as `@sumomok/toy-surface-kit`, drawn through
 * {@link VueBridge} onto the Vue 2.7 runtime the
 * `@deepseek-ai/dsh-experimental-vue2-echarts-poc` row owns — never a second
 * copy — with element-ui installed exactly once by {@link installElementUI}.
 * `README.md` records how those components get here and what that costs.
 * @module @deepseek-ai/dsh-experimental-component-kit/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ConfirmBar } from './ConfirmBar.tsx'
import { installElementUI } from './element-ui.ts'
import { en, NS, zh } from './locales.ts'
import { TcFormDetailRenderer } from './TcFormDetailRenderer.tsx'
import type { ComponentRenderer } from './renderer.ts'

export { NS } from './locales.ts'
export { installElementUI } from './element-ui.ts'
export { freezeDeep } from './freeze.ts'
export { useVueComponent, VueBridge } from './vue2-bridge.tsx'
export type { ComponentKitKey } from './locales.ts'
export type {
  ComponentActionHandler,
  ComponentActionPayload,
  ComponentActionState,
  ComponentKitTranslate,
  ComponentRenderer,
  ComponentRendererProps,
} from './renderer.ts'
export type {
  VueBridgeOptions,
  VueBridgeProps,
  VueEventHandlers,
  VuePropRecord,
} from './vue2-bridge.tsx'
export type { VueComponentOptions, VueInstance } from './vue-shim.ts'

/**
 * Every component this row offers, by the catalog id a block names.
 *
 * A plain object with literal keys rather than a registry service: one package
 * owns every entry, and the literal keys are what let a placement package check
 * this table against the id union its own catalog derives, turning "a catalog
 * id with no renderer" into a compile error instead of a blank block. The
 * `satisfies` here only pins what the values are; which keys must exist is the
 * placement package's check, because the catalog is its fact rather than this
 * row's.
 */
export const COMPONENT_RENDERERS = {
  'el.confirm-bar': ConfirmBar,
  'toy.record': TcFormDetailRenderer,
} satisfies Readonly<Record<string, ComponentRenderer>>

/** Required service: the locale registry this row's dictionaries land in. */
export const inject = ['locale']

/**
 * Client plugin body: register this package's dictionaries and install
 * element-ui onto the Vue 2 runtime this row shares.
 *
 * The installation is not an effect: `Vue.use` has no counterpart, so tearing
 * this row down leaves element-ui's components registered on a runtime other
 * rows also hold. It is idempotent instead, which is what makes a reload safe.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'component-kit: dictionaries')
  installElementUI()
}
