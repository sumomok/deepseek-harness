/**
 * `ctx.componentRenderers`: the browser half of the catalog seam — which
 * components this page can draw, and what draws each of them.
 *
 * The seat used to import one package's renderer table directly, which made
 * "which components exist" a fact of whichever package that was. It is a
 * registry now for the reason the host catalog is: a component is a definition
 * and a renderer contributed together, by the package that owns the component.
 * A page with no component plugin loaded draws nothing and says so, rather than
 * failing to build.
 *
 * Each contribution carries its own definitions, so the seat judges an arriving
 * payload against exactly the components it can draw — the same judgement the
 * host ran, over the catalog this page actually has, which is what keeps a
 * checkpoint written by another composition from drawing a block this build
 * knows nothing about.
 *
 * A contribution carries no package name and version, unlike the host's: a page
 * reads no manifest, and what the browser needs the catalog for is the
 * judgement rather than the diagnostics.
 * @module @deepseek-ai/dsh-experimental-component-surface/client/registry
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import {
  EMPTY_CATALOG,
  readCatalog,
  type ComponentCatalog,
  type ComponentCatalogEntry,
} from '../component-call.ts'
import type { ComponentRenderer } from './renderer.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    componentRenderers: ComponentRendererRegistry
  }
}

/** One component a package contributes to the page: what a call may send it, and what draws it. */
export interface BrowserComponent {
  /** The same definition this package's host half registers, so both halves judge one document alike. */
  readonly entry: ComponentCatalogEntry
  /** The React component the seat draws a validated block with. */
  readonly render: ComponentRenderer
}

/** One package's whole browser contribution. */
export interface BrowserContribution {
  /** Its components, in the order its host half offers them. */
  readonly components: readonly BrowserComponent[]
  /**
   * Translate bound to the contributing package's own dictionary namespace,
   * handed to every renderer of this contribution. The seat keeps its own for
   * the lines it draws in place of a block.
   */
  readonly t: Translate
}

/** One registered component as the seat reads it back. */
export interface RegisteredRenderer {
  /** The React component to draw. */
  readonly render: ComponentRenderer
  /** The translate its contributing package registered it with. */
  readonly t: Translate
}

/**
 * What the seat reads out of the registry: the catalog to judge a payload
 * against, and the renderer to draw each accepted block with.
 *
 * Narrower than the registry itself on purpose — the seat looks components up
 * and never registers one — so a case about what the seat draws builds a table
 * rather than a Cordis service.
 */
export interface ComponentRendererTable {
  /** The components this page can draw, as the judgement reads them. */
  readonly catalog: ComponentCatalog
  /**
   * Look one component's renderer up.
   * @param id - the `component` a validated block names.
   * @returns the renderer and its translate, or `undefined` for a component this page cannot draw.
   */
  rendererFor(id: string): RegisteredRenderer | undefined
}

/**
 * `ctx.componentRenderers`: the components this page can draw.
 *
 * Registration is an effect on the calling context's fiber, so disposing a
 * component row takes its components off the page and the seat draws its
 * "nothing here can draw this block" line for them instead.
 */
export class ComponentRendererRegistry extends Service implements ComponentRendererTable {
  /** Every registered renderer by catalog id, in registration order. */
  private readonly renderers = new Map<string, RegisteredRenderer>()

  /** The derived catalog, rebuilt whenever {@link renderers} changes. */
  private derived: ComponentCatalog = EMPTY_CATALOG

  /** The definitions behind {@link derived}, in registration order. */
  private readonly entries = new Map<string, ComponentCatalogEntry>()

  /**
   * Create and install the registry as `ctx.componentRenderers`.
   * @param ctx - client Cordis context that owns the service.
   */
  constructor(ctx: Context) {
    super(ctx, 'componentRenderers')
  }

  /** The components this page can draw, as the judgement reads them. */
  get catalog(): ComponentCatalog {
    return this.derived
  }

  /**
   * Look one component's renderer up.
   * @param id - the `component` a validated block names.
   * @returns the renderer and its translate, or `undefined` for a component this page cannot draw.
   */
  rendererFor(id: string): RegisteredRenderer | undefined {
    return this.renderers.get(id)
  }

  /**
   * Register one package's components.
   * @param contribution - the components and the translate their renderers receive.
   * @returns the exact disposer that unregisters this contribution.
   * @throws {Error} when the contribution claims an id this page already draws;
   * nothing of the contribution is registered.
   */
  register(contribution: BrowserContribution): () => void {
    const { components, t } = contribution
    for (const component of components) {
      const id = component.entry.id as string
      if (this.renderers.has(id)) {
        throw new Error(`component-surface: a component is already registered for ${JSON.stringify(id)}`)
      }
    }
    const dispose = this.ctx.effect(() => {
      for (const component of components) {
        const id = component.entry.id as string
        this.renderers.set(id, { render: component.render, t })
        this.entries.set(id, component.entry)
      }
      this.resync()
      return () => {
        for (const component of components) {
          const id = component.entry.id as string
          this.renderers.delete(id)
          this.entries.delete(id)
        }
        this.resync()
      }
    }, 'componentRenderers.register()')
    return () => void dispose()
  }

  /** Rebuild the catalog the seat judges against. */
  private resync(): void {
    this.derived = readCatalog([...this.entries.values()])
  }
}
