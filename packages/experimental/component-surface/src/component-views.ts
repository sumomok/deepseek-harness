/**
 * `ctx.componentViews`: which blocks this deployment offers the user, from the
 * two places one can come from.
 *
 * A deployment writes views in `cordis.yml`, and a skill pack ships views
 * beside its instructions. Both are the same three values a `show_component`
 * call carries, both are judged by the pass that judges a call, and both end up
 * in one index — so the sidebar lists them together and a click shows either
 * one the same way.
 *
 * What differs is what a refusal costs. A view the deployment wrote is its own
 * configuration: a refusal fails the row, loudly, because a menu row that shows
 * an empty column is worse than a deployment that did not come up. A view a
 * source contributed is somebody else's file: it is dropped from the index with
 * one line in the log, because failing the console over a pack's view would let
 * an installed file take the deployment down — and, since the whole judgement
 * runs inside the catalog's own change notification, would take the component
 * contribution that completed the catalog down with it.
 *
 * A registered source states its views rather than a way to fetch them. The
 * index is rebuilt from what is registered now, so a source whose own answer
 * moved registers again, and the one moment the index is out of date is a
 * source between its two calls.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/component-views
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { ComponentCall, ComponentCatalog } from './component-call.ts'
import type { ContentView } from './types.ts'
import { indexViews, judgeView, type ContributedView, type ViewIndex, type ViewJudgement } from './views.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    componentViews: ComponentViewRegistry
  }
}

/** One package's whole contribution of views, as it hands it over. */
export interface ComponentViewSource {
  /** The npm name of the contributing package, which a refusal names. */
  readonly owner: string
  /** The views it offers right now, in the order they are offered. */
  readonly views: readonly ContributedView[]
}

/** What the row installing the registry states about this deployment's own views. */
export interface ComponentViewOptions {
  /** The `views` config value, in declaration order. */
  readonly views: readonly ContentView[]
  /** The `homeView` config value, when the deployment names one. */
  readonly homeView?: string
  /**
   * Whether this deployment offers the data page at all, which decides whether
   * a view may place one: a view that opens a page the deployment did not turn
   * on is refused by name, exactly as a call for it is.
   */
  readonly crud: boolean
}

/** The npm name the deployment's own configured views are refused and reported under. */
const CONFIG_OWNER = 'cordis.yml'

/**
 * `ctx.componentViews`: the views the sidebar lists and `/show-content-view`
 * shows, judged against the catalog as it stands.
 */
export class ComponentViewRegistry extends Service {
  /** The deployment's own views, which cannot change without a reload. */
  private readonly options: ComponentViewOptions

  /** Contributed sources, in registration order, which is the order their views are offered in. */
  private readonly sources = new Set<ComponentViewSource>()

  /** Subscribers, in registration order, which is the order a change reaches them in. */
  private readonly watchers = new Set<() => void>()

  /** The derived index, rebuilt whenever the catalog or the sources change. */
  private derived: ViewIndex = new Map()

  /** The last announced report of dropped views, so a rebuild that changes nothing logs nothing. */
  private announced = ''

  /**
   * Create and install the registry as `ctx.componentViews`, and judge the
   * deployment's own views against the catalog as it stands.
   *
   * Constructed by the row rather than mounted as a child plugin, for two
   * reasons the composition specs pin: the service has to exist by the time the
   * first component contribution arrives, and the refusal a configured view
   * earns has to be logged under the row whose config is wrong.
   * @param ctx - Cordis context that owns the service, carrying the catalog.
   * @param options - the deployment's own views and what it offers.
   * @throws {Error} whatever the configured views are refused with, once the
   * catalog holds a component to judge them against.
   */
  constructor(ctx: Context, options: ComponentViewOptions) {
    super(ctx, 'componentViews')
    this.options = options
    // Judged against the first catalog that holds components rather than at
    // load, for the reason the tool is offered then: what a view may place is
    // what the composed component plugins offer, and this row cannot wait for
    // all of them.
    ctx.componentCatalog.onChange(() => { this.resync() })
    this.resync()
  }

  /** The views this deployment offers, configured ones first, each already tightened to what will be drawn. */
  get index(): ViewIndex {
    return this.derived
  }

  /** The ids the deployment's own configuration claims, which a contributed view may not take. */
  get configuredIds(): readonly string[] {
    return this.options.views.map(view => view.id)
  }

  /**
   * Judge one view against the catalog as it stands, without registering it.
   *
   * What a source asks before it contributes, so a view that cannot be drawn is
   * refused where the file it came from can be named rather than dropped here
   * with one log line.
   * @param view - the view as its writer wrote it.
   * @returns the accepted call, or the value that stopped it.
   */
  judge(view: ContributedView): ViewJudgement {
    return judgeView(this.ctx.componentCatalog.catalog, this.options.crud, view)
  }

  /**
   * Offer one package's views for as long as the calling fiber lives.
   * @param source - the contributing package and the views it offers now.
   * @returns the exact disposer that withdraws them.
   */
  register(source: ComponentViewSource): () => void {
    const dispose = this.ctx.effect(() => {
      this.sources.add(source)
      this.resync()
      return () => {
        this.sources.delete(source)
        this.resync()
      }
    }, `componentViews.register(${source.owner})`)
    return () => void dispose()
  }

  /**
   * Watch the index for as long as the calling fiber lives.
   * @param listener - called on every change, never for the current index; read {@link index} for that.
   * @returns the disposer that stops the watch, which the calling fiber also runs.
   */
  onChange(listener: () => void): () => void {
    const dispose = this.ctx.effect(() => {
      this.watchers.add(listener)
      return () => this.watchers.delete(listener)
    }, 'componentViews.onChange()')
    return () => void dispose()
  }

  /**
   * Rebuild the index and tell everyone watching it.
   * @throws whatever the configured views are refused with.
   */
  private resync(): void {
    this.derived = this.build()
    for (const watcher of this.watchers) watcher()
  }

  /**
   * Judge everything offered against the catalog as it stands.
   *
   * Configured views first and whole: they own their ids, so a contributed view
   * repeating one is the contribution's to fix. Sources follow in registration
   * order and their views in the order the source offers them, and the first
   * claim on an id wins — which is the same rule the component catalog applies
   * to a component id, for the same reason.
   * @returns the index; empty while the catalog holds nothing to judge against.
   * @throws {Error} whatever the configured views are refused with.
   */
  private build(): ViewIndex {
    const catalog: ComponentCatalog = this.ctx.componentCatalog.catalog
    if (catalog.entries.length === 0) return new Map()
    const index = new Map<string, ComponentCall>(this.judgeConfigured(catalog))
    const dropped: string[] = []
    for (const source of this.sources) {
      for (const view of source.views) {
        const held = index.get(view.id)
        if (held !== undefined) {
          dropped.push(`${source.owner} offers the view ${JSON.stringify(view.id)}, which ${this.holderOf(view.id)} already offers`)
          continue
        }
        const judged = judgeView(catalog, this.options.crud, view)
        if (!judged.ok) {
          dropped.push(`${source.owner}'s view ${JSON.stringify(view.id)} cannot be drawn: ${judged.refusal.reason}`)
          continue
        }
        index.set(judged.call.id, judged.call)
      }
    }
    this.announce(dropped)
    return index
  }

  /**
   * Judge the deployment's own views, and say so in the process log when they
   * fail.
   *
   * The sentence reaches nobody otherwise. The refusal travels back to the
   * registration that completed the catalog, and a contributing row's fiber
   * carries a rejection without printing it, so an operator whose `views` block
   * is wrong meets a deployment with no components, no views and no tool, and a
   * process log with nothing in it.
   * @param catalog - the components this deployment offers.
   * @returns the accepted configured views, indexed by id.
   * @throws {Error} whatever the judgement refused the config with, after logging it.
   */
  private judgeConfigured(catalog: ComponentCatalog): ViewIndex {
    try {
      return indexViews(catalog, this.options.views, this.options.homeView, this.options.crud)
    } catch (refusal) {
      this.ctx.logger.error(
        '%s; this deployment comes up with no components, no views and no show_component tool until that view is '
        + 'corrected or removed',
        refusal,
      )
      throw refusal
    }
  }

  /** Which contributor holds one id already, for the refusal that names both. */
  private holderOf(id: string): string {
    if (this.options.views.some(view => view.id === id)) return CONFIG_OWNER
    for (const source of this.sources) {
      if (source.views.some(view => view.id === id)) return source.owner
    }
    /* v8 ignore next -- an id is in the index only because one of the two loops above put it there. */
    return CONFIG_OWNER
  }

  /**
   * State every dropped view once, and again only when that report changes.
   *
   * At error level and under this row's own name: a contributed view that is
   * not in the index is a menu row the user never sees, and every other trace
   * of it is an absence.
   * @param dropped - one sentence per view left out of this index.
   */
  private announce(dropped: readonly string[]): void {
    const report = dropped.join(' | ')
    if (report === this.announced) return
    this.announced = report
    if (report !== '') this.ctx.logger.error('component-surface: %s', report)
  }
}
