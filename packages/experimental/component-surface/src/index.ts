/**
 * @deepseek-ai/dsh-experimental-component-surface — the agent places a block of
 * interface in the content panel.
 *
 * The host half offers `show_component` to the model, judges each call against
 * a fixed catalog before anything is drawn, claims the `component` kind of the
 * [content surface](../content-surface/README.md)'s entry stream, and takes back
 * what the user does inside a drawn block through the `/component-action`
 * command. What the column draws is a component package's — a browser row claims
 * the `component` key of the `content.surface.kind` slot and receives each
 * entry's validated spec as its payload.
 *
 * A call can also fill a data table from the deployment's own backend instead
 * of writing its rows out. That half is off unless `dataSource` says otherwise,
 * and where it is on the tool waits for both the backend and an approval
 * answerer before it is offered at all: the description would otherwise promise
 * a parameter nothing can honour. It is the one path in this package that asks
 * the user a question and the one that appends a record for a call — the rows
 * are not in the `tool/call`, so `content-component/resolved` is what the column
 * replays from.
 *
 * The same column also takes blocks nobody asked the model for: a deployment
 * writes views of its own in `views`, the sidebar lists them off this row's
 * `/component-surface/views` route, and a click runs `/show-content-view`,
 * which appends the one session event this package writes. Everything after
 * that append is the path a call already took — one judgement, one extractor,
 * one seat.
 *
 * A call that writes its own rows appends no session event. Its record is the
 * `tool/call` the loop already writes, and an action's is the `command/run` the
 * command registry already writes, so both directions replay from the log the
 * agent actually wrote and removing this row leaves every past session
 * readable.
 *
 * The catalog, the ceilings, and the judgement live in three modules of their
 * own — `component-call.ts`, `sanitize.ts` and `validate.ts` — because the
 * browser seat runs the identical pass over the payload arriving on the wire and
 * must not pull a tool runtime into a page to do it. `component-call.ts`
 * therefore imports nothing at all, `sanitize.ts` imports only it, and
 * `validate.ts` imports only those two.
 *
 * Trust: `spec` is model output that becomes a rendered block inside the
 * shell's own origin. It is bounded rather than trusted, and the bound is the
 * catalog's property schema — which cannot express markup or a function body, so
 * there is no such value for a later pass to have to recognize. The one thing a
 * schema cannot say is what a string means, so a component reading one as a
 * path, a color, or a renderer name declares that beside the schema and
 * `sanitize.ts` drops what falls outside it (see the README's trust section).
 * @module @deepseek-ai/dsh-experimental-component-surface
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: resolves ctx.contentSurface for the optional extractor child.
import type {} from '@deepseek-ai/dsh-experimental-content-surface'
// Type-only: resolves ctx.commands for the optional /component-action child.
import type {} from '@deepseek-ai/dsh-commands'
// Type-only: resolves ctx.webServer for the optional view-catalog route.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: resolves ctx.bizBackend, which the optional data-source child reads through.
import type {} from '@deepseek-ai/dsh-experimental-biz-backend'
// Type-only: resolves ctx.approval, which that child asks the user through.
import type {} from '@deepseek-ai/dsh-user-approval'
import { ComponentCatalogRegistry, trackCatalog } from './catalog.ts'
import { MAX_TABLE_ROWS, type ComponentCatalog } from './component-call.ts'
import { ComponentViewRegistry } from './component-views.ts'
import { installComponentAction } from './command.ts'
import { PendingLoads } from './data-page.ts'
import { viewCatalogRoute, type ComponentViewsDocument } from './route.ts'
import { componentExtractor } from './surface.ts'
import { offeredEntries, showComponentTool, withheldComponents, type ShowComponentOptions } from './tool.ts'
import type { ContentView } from './types.ts'
import { showContentViewCommand } from './view-command.ts'
import type { ViewIndex } from './views.ts'

// The `content-component/shown` declaration lives in src/types.ts (its one
// home); this re-export projects the type face onto the package root and keeps
// the module edge in the emitted index.d.ts.
export type * from './types.ts'
export { ComponentCatalogRegistry, trackCatalog } from './catalog.ts'
export { ComponentViewRegistry } from './component-views.ts'
export type { ComponentViewOptions, ComponentViewSource } from './component-views.ts'
export type { ContributedView, ViewJudgement, ViewRefusal } from './views.ts'
export type {
  CatalogedComponent,
  ComponentCatalogConfig,
  ComponentContribution,
  ComponentSource,
} from './catalog.ts'
export {
  catalogId,
  COMPONENT_KIT_ENTRIES,
  DATA_PAGE_ID,
  DATA_PAGE_MODEL_PROP_NAMES,
  DATA_PAGE_ROW_OPERATIONS,
  DATA_PAGE_TOOLBAR_BUTTONS,
  DATA_PAGE_VIEW_PROP_NAMES,
  readCatalog,
  type CatalogId,
  type ComponentCatalog,
  type ComponentCatalogEntry,
} from './component-call.ts'
export {
  BINDING_HINT,
  BINDING_KEY,
  BLOCK_KEYS,
  describeSchema,
  LAYOUT_DIRECTIONS,
  LAYOUT_GAPS,
  MAX_ENTRY_ID_LENGTH,
  MAX_FLEX,
  MAX_LAYOUT_CHILDREN,
  MAX_LAYOUT_DEPTH,
  MAX_NODE_ID_LENGTH,
  MAX_NODES,
  MAX_OUTPUT_ID_LENGTH,
  MAX_SPEC_BYTES,
  MAX_TITLE_LENGTH,
  STACK_KEYS,
  TOKEN_CHARSET,
  TOKEN_HINT,
} from './component-call.ts'
export { PARAM_KEY } from './params.ts'
export { withheldComponents } from './tool.ts'
export { unbindableReason } from './validate.ts'

/** Stable Cordis plugin name. */
export const name = 'show-component'

/**
 * Service required before the offer exists at all. The extractor is an optional
 * child instead: a deployment with no content column still gets the tool, and
 * the calls it records are still in the log for a composition that later grows
 * one.
 */
export const inject = ['tools']

/** Plugin config: the views this deployment offers the user, and whether a call may read its own rows. */
export interface Config {
  /**
   * Blocks a person wrote, offered to the user through the sidebar rather than
   * to the model. Each carries the same three values a `show_component` call
   * does — an entry id, a title, and a spec — and is judged by the same pass at
   * load. Omit it, or leave it empty, for a deployment where the agent is the
   * only one who puts anything in the column.
   */
  views?: ContentView[]
  /**
   * View the sidebar shows automatically the first time a session lands on a
   * blank draft, so a new conversation opens onto a populated column instead of
   * an empty one. Must name a configured view. Omit to leave a blank draft's
   * column empty until the user or the agent chooses. The value is read by
   * `@deepseek-ai/dsh-experimental-server-sidebar` off this row's route, and
   * what it drives is a real `show-content-view` invocation, so it leaves the
   * same durable record a real click would.
   */
  homeView?: string
  /**
   * Whether a call may fill a data table from this deployment's own data
   * backend. Off by default, because the read spends the signed-in visitor's
   * own credential and a deployment has to say that it wants that.
   *
   * Where it is on, the tool is offered only once `bizBackend` and `approval`
   * are both composed — the offer names a parameter, and a parameter with no
   * backend behind it or no way to ask the user is an offer that cannot be
   * kept.
   */
  dataSource?: boolean
  /**
   * Rows one read asks for when the call names no count of its own, which is
   * also the number the user is shown on the approval card. A deployment whose
   * tables are wide wants a smaller one; the ceiling is the table's own
   * {@link MAX_TABLE_ROWS}.
   */
  dataDefaultPageSize?: number
  /**
   * Whether a call may open this deployment's own full data page for one
   * table (`toy.data-page`) in the panel. Off by default, because the page reads
   * its table from the browser with the signed-in visitor's own credential and
   * a deployment has to say that it wants that.
   *
   * Where it is on, the tool is offered only once `approval` is composed —
   * every page is put to the user before it opens, and a component nobody can
   * be asked about is one nobody may place. The host reads nothing for this
   * kind; what the page requests, it requests from the browser under the base
   * path `@deepseek-ai/dsh-experimental-component-kit` is configured with.
   */
  dataPage?: boolean
  /**
   * How long a call that opened a data page waits for the browser to report
   * the page's columns before answering without them, in milliseconds. The
   * columns then reach the model as a notice once the page has loaded. A
   * composition no browser attaches to sets it low, because every such call
   * pays the whole deadline.
   */
  dataPageLoadTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  views: z.array(z.object({
    id: z.string().required(),
    title: z.string().required(),
    spec: z.any().required(),
  })).default([]),
  homeView: z.string(),
  dataSource: z.boolean().default(false),
  dataDefaultPageSize: z.natural().default(200),
  dataPage: z.boolean().default(false),
  dataPageLoadTimeoutMs: z.natural().default(10_000),
})

/**
 * {@link Config} after the schema above has run: `views` carries its own
 * default, so a deployment that omits the field reaches `apply` with an empty
 * list rather than with nothing. `homeView` has no default and stays optional.
 */
type ResolvedConfig = Config & {
  readonly views: readonly ContentView[]
  readonly dataSource: boolean
  readonly dataDefaultPageSize: number
  readonly dataPage: boolean
  readonly dataPageLoadTimeoutMs: number
}

/**
 * Read the four offer fields into what the tool takes, refusing every deadline
 * and ceiling this row cannot run on.
 * @param config - the validated config, with its defaults already applied.
 * @returns what this composition's `show_component` offers.
 * @throws {Error} when the default row count is outside what a table can draw, or either deadline is zero.
 */
function offerOptions(config: ResolvedConfig): ShowComponentOptions {
  if (config.dataDefaultPageSize < 1 || config.dataDefaultPageSize > MAX_TABLE_ROWS) {
    throw new Error(
      `component-surface: dataDefaultPageSize must be between 1 and ${MAX_TABLE_ROWS}, received ${config.dataDefaultPageSize}`)
  }
  // Loud at load: a zero deadline would answer every page as unreported, with
  // no diagnostic pointing at the row that set it.
  if (config.dataPageLoadTimeoutMs < 1) {
    throw new Error(
      `component-surface: dataPageLoadTimeoutMs must be a positive number of milliseconds, received ${config.dataPageLoadTimeoutMs}`)
  }
  return {
    dataSource: config.dataSource,
    defaultPageSize: config.dataDefaultPageSize,
    dataPage: config.dataPage,
    dataPageLoadTimeoutMs: config.dataPageLoadTimeoutMs,
  }
}

/**
 * The services one offer needs before the tool is registered at all.
 *
 * Both services or no tool, as for the data source alone: a deployment that
 * announced a data source has to be offered one that works, and one that
 * announced the data page has to be able to ask about it. A description
 * promising either with nothing behind it is worse than a row that never
 * loaded.
 * @param options - what this composition offers.
 * @returns the service names, empty for a composition that offers neither.
 */
function offerNeeds(options: ShowComponentOptions): readonly string[] {
  return [
    ...options.dataSource ? ['bizBackend'] : [],
    ...options.dataSource || options.dataPage ? ['approval'] : [],
  ]
}

/*
 * The ceilings are not configuration.
 *
 * The numbers a deployment might want to move — the spec byte ceiling, the node
 * ceiling, the nesting ceiling, the action byte ceiling — are enforced twice:
 * here, and again by the browser seat over the value that arrives on the wire.
 * The seat receives no Cordis configuration (`content-frame`'s `route.ts`
 * records why), so a per-deployment ceiling would be a ceiling the two halves
 * disagree on: a block silently missing from the column instead of a refusal the
 * model can act on. They stay protocol constants in `component-call.ts` until
 * the seat can read a deployment's settings, at which point the ceilings and the
 * route that serves them arrive together.
 *
 * An action's report grade is not a ceiling and is not configuration either. It
 * says what a gesture means — a pressed confirmation is the answer the agent
 * stopped for — so it is declared beside the action in the catalog, and a
 * deployment that moved it would be changing what the agent is told happened.
 */

/**
 * Offer `show_component` for as long as this deployment has a component to
 * place with it.
 *
 * Not offered at all while the catalog holds nothing this composition can
 * honour: the description's whole substance is the component list, and a tool
 * offering a list with no entries in it is an offer the model can only spend a
 * refused call discovering. Re-registered on every catalog change, which is how
 * the changed description reaches the log — the request header records the
 * assembled schemas verbatim, so a re-registration is a header the model's next
 * request is reconstructable from.
 * @param ctx - the injected context carrying the tool runtime and the catalog.
 * @param options - what this composition offers.
 * @param pending - the table a call opening a data page waits in.
 * @param needs - the services this offer waited for, named in the effect label.
 */
function installOffer(
  ctx: Context,
  options: ShowComponentOptions,
  pending: PendingLoads,
  needs: readonly string[],
): void {
  trackCatalog(
    ctx,
    (catalog: ComponentCatalog) => (offeredEntries(catalog, options).length === 0
      ? undefined
      : ctx.tools.register(showComponentTool(ctx, catalog, options, pending))),
    needs.length === 0
      ? 'show-component: the show_component tool'
      : `show-component: the show_component tool, with ${needs.join(' and ')}`,
  )
}

/**
 * Publish one index of views and the command that shows one from it.
 *
 * Both pieces exist only where views do, and each waits for the seam it needs
 * the way every other piece of this row does. A deployment that configures
 * views composes the console's webserver and command registry — the overlay
 * that inserts this row is what guarantees it — and one that composes neither
 * has no sidebar to click in either.
 * @param ctx - the injected context carrying the view registry.
 * @param views - the views to publish, as the registry judged them.
 * @param homeView - the `homeView` config value, when set.
 * @returns the disposer of both registrations, or `undefined` where there is nothing to publish.
 */
function publishViews(
  ctx: Context,
  views: ViewIndex,
  homeView: string | undefined,
): (() => void) | undefined {
  if (views.size === 0) return undefined
  const document: ComponentViewsDocument = {
    views: [...views.values()].map(view => ({ id: view.id, title: view.title })),
    ...homeView === undefined ? {} : { homeView },
  }
  const route = ctx.inject(['webServer'], (serverCtx) => {
    serverCtx.effect(
      () => serverCtx.webServer.register(viewCatalogRoute(document)),
      'show-component: the view catalog route',
    )
  })
  const command = ctx.inject(['commands'], (commandsCtx) => {
    commandsCtx.commands.register(showContentViewCommand(views))
  })
  return () => {
    void route.dispose()
    void command.dispose()
  }
}

/**
 * Install the view registry and keep the catalog route and the command in step
 * with what it holds.
 *
 * Judged against the catalog rather than at load, because what a view may place
 * is what the composed component plugins offer: a view is accepted by exactly
 * the pass a tool call takes, so a deployment writing one, a pack shipping one
 * and the model writing one are refused on identical terms and none can drift
 * from the others.
 *
 * A composition with no component registered publishes no views, for the reason
 * it is offered no tool: there is no component for a view to place, so a
 * refusal naming every view would say only that this deployment composed no
 * component plugin. The first catalog that holds one is where a broken
 * configured view fails, which is the earliest point the failure can be told
 * from that one.
 * @param ctx - the injected context carrying the catalog.
 * @param config - the validated config, with its defaults already applied.
 * @param options - what this composition offers, which decides whether a view may place the data page.
 * @param homeView - the `homeView` config value, when set.
 * @throws {Error} when a configured view is one the tool would have refused,
 * which is a menu row that shows an empty column when a user clicks it.
 */
function installViews(ctx: Context, config: ResolvedConfig, options: ShowComponentOptions, homeView: string | undefined): void {
  // The service installs itself on the context and is withdrawn with this
  // row's fiber, so nothing here holds the instance.
  new ComponentViewRegistry(ctx, {
    views: config.views,
    ...homeView === undefined ? {} : { homeView },
    dataPage: options.dataPage,
  })
  ctx.inject(['componentViews'], (viewsCtx) => {
    let held: (() => void) | undefined
    const rebuild = (): void => {
      held?.()
      held = publishViews(viewsCtx, viewsCtx.componentViews.index, homeView)
    }
    viewsCtx.effect(() => {
      rebuild()
      return () => {
        held?.()
        held = undefined
      }
    }, 'show-component: the view catalog and the command that shows one')
    viewsCtx.componentViews.onChange(rebuild)
  })
}

/**
 * Install the catalog registry, then claim the tool, the content kind and its
 * return channel wherever a column is composed, and — where the deployment
 * configured any — the view catalog and the command that shows one.
 *
 * Every one of those is a function of the catalog, and the catalog is a
 * function of which component plugins this deployment composed, so all of them
 * live under one child that waits for the registry and rebuilds when it moves.
 * @param ctx - plugin context carrying the tool runtime.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  const options = offerOptions(resolved)
  // One table for the tool and the command: a call that opened a data page
  // waits in it, and the page's report arrives through the command.
  const pending = new PendingLoads()
  const needs = offerNeeds(options)
  // The registry is installed with this deployment's own offer, so a reader
  // outside this package asking what can be drawn here is answered without
  // re-deriving a rule the tool's description already applies.
  ctx.plugin(ComponentCatalogRegistry, { withheld: [...withheldComponents(options)] })
  ctx.inject(['componentCatalog'], (catalogCtx) => {
    if (needs.length === 0) {
      installOffer(catalogCtx, options, pending, needs)
    } else {
      catalogCtx.inject([...needs], (offerCtx) => { installOffer(offerCtx, options, pending, needs) })
    }
    catalogCtx.inject(['contentSurface'], (surfaceCtx) => {
      // `register` scopes its own disposer to the injected child, which is what
      // releases the kind when the fiber goes away; the catalog decides which
      // recorded calls the extractor reads into entries, so it is re-registered
      // when the catalog moves and the column refolds.
      trackCatalog(
        surfaceCtx,
        catalog => surfaceCtx.contentSurface.register(componentExtractor(catalog)),
        'show-component: the component content kind',
      )
    })
    // The return channel needs all three: the registry the command lives in, the
    // router that made the entry, and the projection the entry is read out of.
    // Without a column there is nothing on screen for an action to name, so the
    // command is absent rather than answering every gesture with a refusal.
    catalogCtx.inject(['commands', 'contentSurface', 'sessionProjections'], (actionCtx) => {
      installComponentAction(actionCtx, pending)
    })
    installViews(catalogCtx, resolved, options, config.homeView)
  })
}
