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
 * @module @deepseek-ai/dsh-experimental-component-kit/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ConfirmBar } from './ConfirmBar.tsx'
import { en, NS, zh } from './locales.ts'
import type { ComponentRenderer } from './renderer.ts'

export { NS } from './locales.ts'
export type { ComponentKitKey } from './locales.ts'
export type {
  ComponentActionHandler,
  ComponentKitTranslate,
  ComponentRenderer,
  ComponentRendererProps,
} from './renderer.ts'

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
} satisfies Readonly<Record<string, ComponentRenderer>>

/** Required service: the locale registry this row's dictionaries land in. */
export const inject = ['locale']

/**
 * Client plugin body: register this package's dictionaries.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'component-kit: dictionaries')
}
