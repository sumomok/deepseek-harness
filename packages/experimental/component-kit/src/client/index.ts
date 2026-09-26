/**
 * Component row, browser half. It registers its dictionaries and its six
 * components' renderers; it declares no slot and knows no layout, so a
 * placement package decides where a block is drawn.
 *
 * The registration is the row's whole surface. Each component goes in with the
 * same definition this row's host half registers and the React component that
 * draws it, so what a block may carry and what draws it arrive together and a
 * page loaded without this row simply cannot draw these six. The placement
 * package hands each renderer the block's already-validated properties as
 * {@link ComponentRendererProps} and this row's own translate.
 *
 * This row's host half serves one setting, and this half reads it once at
 * start: the base path the data page requests its table under. Every other
 * component here draws its properties and reports what the user pressed, and
 * performs no navigation, no request, and no write of its own; the data page
 * requests its own table from the browser, which `README.md` records.
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
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the renderer registry's Context merge (ctx.componentRenderers).
import type {} from '@deepseek-ai/dsh-experimental-component-surface/client'
import { COMPONENT_KIT_ENTRIES } from '@deepseek-ai/dsh-experimental-component-surface/client'
import type { BrowserComponent } from '@deepseek-ai/dsh-experimental-component-surface/client'
import { ConfirmBar } from './ConfirmBar.tsx'
import { DataPageRenderer } from './DataPageRenderer.tsx'
import { settleDataPageBasePath } from './data-page-settings.ts'
import { installElementUI } from './element-ui.ts'
import { en, NS, zh } from './locales.ts'
import { TableDetailRenderer } from './TableDetailRenderer.tsx'
import { TcFormDetailRenderer } from './TcFormDetailRenderer.tsx'
import { TcProcessBallRenderer } from './TcProcessBallRenderer.tsx'
import { TuQueryCondAdvRenderer } from './TuQueryCondAdvRenderer.tsx'
import type { ComponentRenderer } from './renderer.ts'

export { NS } from './locales.ts'
export { DATA_PAGE_REPORT_LIMITS } from './data-page-limits.ts'
export { installElementUI } from './element-ui.ts'
export { freezeDeep } from './freeze.ts'
export { useVueComponent, VueBridge } from './vue2-bridge.tsx'
export type { ComponentKitKey, ComponentKitTranslate } from './locales.ts'
export type {
  ComponentActionHandler,
  ComponentActionPayload,
  ComponentActionState,
  ComponentOutputHandler,
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
 * Which ids must appear is no longer a compile-time claim: a catalog id is a
 * runtime value now, so there is no literal union for this table to be checked
 * against. {@link componentKitRenderers} refuses at registration instead, and
 * `browser-plugin.client.spec.ts` pairs the two tables both ways.
 */
const COMPONENT_RENDERERS = {
  'el.confirm-bar': ConfirmBar,
  'el.filter-bar': TuQueryCondAdvRenderer,
  'el.metric': TcProcessBallRenderer,
  'toy.data-page': DataPageRenderer,
  'toy.record': TcFormDetailRenderer,
  'toy.table': TableDetailRenderer,
} satisfies Readonly<Record<string, ComponentRenderer>>

/**
 * Pair each of this row's definitions with the renderer that draws it.
 * @param table - the renderers to pair them against; this row's own by default.
 * @returns the contribution's components, in the order the host half offers them.
 * @throws {Error} when a definition has no renderer in the table.
 */
export function componentKitRenderers(
  table: Readonly<Record<string, ComponentRenderer>> = COMPONENT_RENDERERS,
): readonly BrowserComponent[] {
  return COMPONENT_KIT_ENTRIES.map((entry) => {
    const render = table[entry.id as string]
    if (render === undefined) throw new Error(`component-kit: no renderer draws ${entry.id}`)
    return { entry, render }
  })
}

/** Required service: the locale registry this row's dictionaries land in. */
export const inject = ['locale']

/**
 * Client plugin body: register this package's dictionaries and its six
 * components, install element-ui onto the Vue 2 runtime this row shares, and
 * start the one read of this row's settings that the data page waits on before
 * it is drawn.
 *
 * The components are registered with this row's own translate, bound once:
 * `bind` reads the active locale at call time and the seat re-renders on a
 * language switch, so a renderer's copy follows the user's language without
 * this row holding a copy of it.
 *
 * The registry is waited for rather than required, so a page that loads this
 * row without a placement row still gets its dictionaries and its settings.
 *
 * The element-ui installation is not an effect: `Vue.use` has no counterpart,
 * so tearing this row down leaves element-ui's components registered on a
 * runtime other rows also hold. It is idempotent instead, which is what makes a
 * reload safe. The settings read is not awaited here: every other renderer
 * draws without it, and the one that needs it waits on the promise itself.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'component-kit: dictionaries')
  ctx.inject(['componentRenderers'], (registryCtx) => {
    registryCtx.componentRenderers.register({
      components: componentKitRenderers(),
      // Widened at the boundary: the registry stores a translate whose key
      // domain is the contributing row's own, and this row narrows it back for
      // its own renderers at `ComponentRendererProps`. A translate accepting
      // every string is what any renderer can be handed, so the cast loses the
      // key check here and keeps it where the keys are written.
      t: registryCtx.locale.bind(NS) as Translate,
    })
  })
  installElementUI()
  void settleDataPageBasePath()
}
