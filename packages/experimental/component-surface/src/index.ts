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
import { MAX_TABLE_ROWS } from './component-call.ts'
import { installComponentAction } from './command.ts'
import { viewCatalogRoute, type ComponentViewsDocument } from './route.ts'
import { componentExtractor } from './surface.ts'
import { showComponentTool, type ShowComponentOptions } from './tool.ts'
import type { ContentView } from './types.ts'
import { showContentViewCommand } from './view-command.ts'
import { indexViews } from './views.ts'

// The `content-component/shown` declaration lives in src/types.ts (its one
// home); this re-export projects the type face onto the package root and keeps
// the module edge in the emitted index.d.ts.
export type * from './types.ts'

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
}

/**
 * Read the two data-source fields into what the tool takes.
 * @param config - the validated config, with its defaults already applied.
 * @returns what this composition's `show_component` offers.
 * @throws {Error} when the default row count is outside what a table can draw.
 */
function dataSourceOptions(config: ResolvedConfig): ShowComponentOptions {
  if (config.dataDefaultPageSize < 1 || config.dataDefaultPageSize > MAX_TABLE_ROWS) {
    throw new Error(
      `component-surface: dataDefaultPageSize must be between 1 and ${MAX_TABLE_ROWS}, received ${config.dataDefaultPageSize}`)
  }
  return { dataSource: config.dataSource, defaultPageSize: config.dataDefaultPageSize }
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
 * Claim the tool, the content kind and its return channel wherever a column is
 * composed, and — where the deployment configured any — the view catalog and
 * the command that shows one.
 * @param ctx - plugin context carrying the tool runtime.
 * @param config - validated {@link Config}; the views are judged before anything is claimed.
 */
export function apply(ctx: Context, config: Config): void {
  // Loud at load: a view whose spec the tool would refuse is a menu row that
  // shows an empty column when a user clicks it, with nothing anywhere saying
  // why. The judgement is the tool's own, so what a deployment may write is
  // exactly what the model may send.
  const resolved = config as ResolvedConfig
  const views = indexViews(resolved.views, config.homeView)
  const options = dataSourceOptions(resolved)
  if (!options.dataSource) {
    ctx.effect(() => ctx.tools.register(showComponentTool(ctx, options)), 'show-component: the show_component tool')
  } else {
    // Both services or no tool: a deployment that announced a data source has
    // to be offered one that works, and a description promising a parameter
    // whose backend is absent is worse than a row that never loaded.
    ctx.inject(['bizBackend', 'approval'], (dataCtx) => {
      dataCtx.effect(
        () => dataCtx.tools.register(showComponentTool(dataCtx, options)),
        'show-component: the show_component tool, reading from the data source',
      )
    })
  }
  ctx.inject(['contentSurface'], (surfaceCtx) => {
    // `register` scopes its own disposer to the injected child, which is what
    // releases the kind when the fiber goes away.
    surfaceCtx.contentSurface.register(componentExtractor())
  })
  // The return channel needs all three: the registry the command lives in, the
  // router that made the entry, and the projection the entry is read out of.
  // Without a column there is nothing on screen for an action to name, so the
  // command is absent rather than answering every gesture with a refusal.
  ctx.inject(['commands', 'contentSurface', 'sessionProjections'], installComponentAction)
  if (views.size === 0) return
  // Both pieces exist only where views do, and each waits for the seam it needs
  // the way every other piece of this row does. A deployment that configures
  // views composes the console's webserver and command registry — the overlay
  // that inserts this row is what guarantees it — and one that composes neither
  // has no sidebar to click in either.
  const catalog: ComponentViewsDocument = {
    views: [...views.values()].map(view => ({ id: view.id, title: view.title })),
    ...config.homeView === undefined ? {} : { homeView: config.homeView },
  }
  ctx.inject(['webServer'], (serverCtx) => {
    serverCtx.effect(
      () => serverCtx.webServer.register(viewCatalogRoute(catalog)),
      'show-component: the view catalog route',
    )
  })
  ctx.inject(['commands'], (commandsCtx) => {
    commandsCtx.commands.register(showContentViewCommand(views))
  })
}
