/**
 * `ctx.componentCatalog`: which components this deployment offers, and which
 * package contributed each of them.
 *
 * The catalog was a table in `component-call.ts` while one package owned every
 * entry. It is a registry now because a component is two halves — a host
 * definition saying what a call may send and what comes back, and a renderer
 * that draws it — and both halves belong to whichever package ships the
 * component, not to the package that places it. A deployment composing no
 * component plugin therefore offers no component, and `show_component` is not
 * offered to the model at all.
 *
 * Registration is a batch because a contribution is one act: a package's
 * components arrive together or not at all, so a duplicate id in the fifth
 * entry leaves the first four unregistered rather than half a row in the table.
 * The refusal names both packages, because "duplicate id" without them names
 * neither the row to remove nor the row that was there first.
 *
 * Everything derivable from the catalog — the id index, the depth ceiling — is
 * derived once per change rather than per call, and handed out as one
 * {@link ComponentCatalog} value. Whoever holds that value is judging against a
 * catalog that cannot change under them mid-call; whoever wants the current one
 * reads {@link ComponentCatalogRegistry.catalog} again, or tracks it through
 * {@link trackCatalog}.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/catalog
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { EMPTY_CATALOG, readCatalog, type ComponentCatalog, type ComponentCatalogEntry } from './component-call.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    componentCatalog: ComponentCatalogRegistry
  }
}

/** The package one contribution came from, read from that package's own manifest. */
export interface ComponentSource {
  /** Its npm name. */
  readonly package: string
  /** Its version, as the same manifest spells it. */
  readonly version: string
}

/** One registered component: the definition its package wrote, and the package that wrote it. */
export interface CatalogedComponent {
  /** What a call may send it and what comes back. */
  readonly entry: ComponentCatalogEntry
  /** Which package contributed it. */
  readonly source: ComponentSource
}

/** One package's whole contribution, as it hands it over. */
export interface ComponentContribution {
  /** The components, in the order they are offered to the model. */
  readonly entries: readonly ComponentCatalogEntry[]
  /** The contributing package, read from its own `package.json` rather than written down here. */
  readonly source: ComponentSource
}

/**
 * Name one package in a refusal.
 * @param source - the contributing package.
 * @returns its name and version.
 */
function sourceName(source: ComponentSource): string {
  return `${source.package}@${source.version}`
}

/** What the row installing the registry states about this deployment's own offer. */
export interface ComponentCatalogConfig {
  /**
   * Catalog ids this deployment registers and will not place, which is what
   * {@link ComponentCatalogRegistry.offered} leaves out. Written by the row
   * that owns `show_component`, off the same config the tool's own offer is
   * read from; an id nothing registers is simply never seen.
   */
  withheld?: string[]
}

/**
 * {@link ComponentCatalogConfig} after the schema below has run: `withheld`
 * carries its own default, so a row that installs the registry without one
 * reaches the constructor with an empty list rather than with nothing.
 */
type ResolvedCatalogConfig = ComponentCatalogConfig & { readonly withheld: readonly string[] }

/**
 * `ctx.componentCatalog`: the components a `show_component` call may place.
 *
 * Registration is an effect on the calling context's fiber, so disposing the
 * component row takes its components out of the catalog and every reader —
 * the tool's description included — is rebuilt without them.
 */
export class ComponentCatalogRegistry extends Service {
  static Config: z<ComponentCatalogConfig> = z.object({
    withheld: z.array(z.string()).default([]),
  })

  /** Every registered component, in registration order, keyed by id for the duplicate check. */
  private readonly registered = new Map<string, CatalogedComponent>()

  /** Subscribers, in registration order, which is the order a change reaches them in. */
  private readonly watchers = new Set<(catalog: ComponentCatalog) => void>()

  /** The derived catalog, rebuilt whenever {@link registered} changes. */
  private derived: ComponentCatalog = EMPTY_CATALOG

  /** Ids {@link offered} leaves out, fixed for the life of the registry. */
  private readonly withheld: ReadonlySet<string>

  /**
   * Create and install the registry as `ctx.componentCatalog`.
   * @param ctx - Cordis context that owns the service.
   * @param config - what the installing row states about this deployment's own
   *   offer, with the schema's own default already applied.
   */
  constructor(ctx: Context, config: ComponentCatalogConfig) {
    super(ctx, 'componentCatalog')
    this.withheld = new Set((config as ResolvedCatalogConfig).withheld)
  }

  /** The components this deployment offers, with the id index and the depth ceiling already derived. */
  get catalog(): ComponentCatalog {
    return this.derived
  }

  /** Every registered component with the package that contributed it, in registration order. */
  get components(): readonly CatalogedComponent[] {
    return [...this.registered.values()]
  }

  /**
   * The registered components this deployment will actually place.
   *
   * Registering a component is the contributing plugin's act; offering it is
   * the deployment's, and the two differ wherever a component needs something
   * the deployment did not turn on — the data page on a deployment that left
   * `dataPage` off is the one that does today. A reader asking what this
   * deployment can draw reads this rather than {@link components}, so a
   * withheld component counts as absent to everyone outside the tool's own
   * description, which leaves it out by the same rule.
   */
  get offered(): readonly CatalogedComponent[] {
    return [...this.registered.values()].filter(one => !this.withheld.has(one.entry.id))
  }

  /**
   * Register one package's components.
   * @param contribution - the components, and the package contributing them.
   * @returns the exact disposer that unregisters this contribution.
   * @throws {Error} when the contribution repeats an id within itself or claims
   * one another package already registered; the refusal names both packages and
   * nothing of the contribution is registered.
   */
  register(contribution: ComponentContribution): () => void {
    const { entries, source } = contribution
    const claimed = new Set<string>()
    for (const entry of entries) {
      const id = entry.id as string
      const held = this.registered.get(id)
      if (held !== undefined) {
        throw new Error(`component-surface: ${sourceName(source)} registers component ${JSON.stringify(id)}, `
          + `which ${sourceName(held.source)} already registered`)
      }
      if (claimed.has(id)) {
        throw new Error(`component-surface: ${sourceName(source)} registers component ${JSON.stringify(id)} twice `
          + 'in one contribution')
      }
      claimed.add(id)
    }
    const withdraw = (): void => {
      for (const entry of entries) this.registered.delete(entry.id)
      this.resync()
    }
    const dispose = this.ctx.effect(() => {
      for (const entry of entries) this.registered.set(entry.id, { entry, source })
      try {
        this.resync()
      } catch (error) {
        // A reader refused the catalog this contribution makes — a configured
        // view naming a component nobody offers is the one that does it today.
        // The contribution is taken back out before the sentence reaches the
        // contributing row, so the deployment ends up with the catalog it had
        // rather than with half a contribution nothing has judged.
        withdraw()
        throw error
      }
      return withdraw
    }, `componentCatalog.register(${source.package})`)
    return () => void dispose()
  }

  /**
   * Watch the catalog for as long as the calling fiber lives.
   *
   * A subscription rather than a Cordis event because a refusal has to travel:
   * a listener that rejects the catalog a contribution makes refuses that
   * contribution, and a dispatched event contains its listeners' failures by
   * design. Subscribers are called in registration order, one after another,
   * with the catalog as it stands after the change — so the first one to refuse
   * it stops the rest, and the contribution is withdrawn before any of them is
   * told again.
   * @param listener - called on every change, never for the current catalog;
   *   read {@link catalog} for that.
   * @returns the disposer that stops the watch, which the calling fiber also runs.
   */
  onChange(listener: (catalog: ComponentCatalog) => void): () => void {
    const dispose = this.ctx.effect(() => {
      this.watchers.add(listener)
      return () => this.watchers.delete(listener)
    }, 'componentCatalog.onChange()')
    return () => void dispose()
  }

  /**
   * Rebuild the derived catalog and tell everyone watching it.
   * @throws whatever a watcher refuses the new catalog with.
   */
  private resync(): void {
    this.derived = readCatalog([...this.registered.values()].map(one => one.entry))
    for (const watcher of this.watchers) watcher(this.derived)
  }
}

/**
 * Hold one catalog-dependent registration in step with the catalog.
 *
 * The registration is built against a catalog value rather than against a live
 * reader, and rebuilt whenever the catalog changes: a tool description, a
 * content extractor and a projection fold are all fixed at the moment they are
 * registered, so one that read the catalog live would keep answering from
 * whichever catalog happened to be in place when its first caller arrived.
 * @param ctx - the injected context carrying `ctx.componentCatalog`.
 * @param install - build the registration against one catalog; returns its
 *   disposer, or `undefined` for a catalog this registration does not exist for.
 * @param label - effect label the fiber's diagnostics carry.
 */
export function trackCatalog(
  ctx: Context,
  install: (catalog: ComponentCatalog) => (() => void) | undefined,
  label: string,
): void {
  let held: (() => void) | undefined
  const rebuild = (): void => {
    held?.()
    held = install(ctx.componentCatalog.catalog)
  }
  ctx.effect(() => {
    rebuild()
    return () => {
      held?.()
      held = undefined
    }
  }, label)
  ctx.componentCatalog.onChange(rebuild)
}
