/**
 * What every renderer in this row receives, and what the row's table is.
 *
 * The props are the whole contract between a placement package and a component:
 * an identity, the block's already-validated properties, one callback for
 * whatever the user did, and the row's own translate. Nothing reactive, nothing
 * from a context, and no service — a renderer is a pure function of these four
 * values, which is what lets the same component draw inside a content column, a
 * transcript row, or a test with no runtime at all.
 * @module @deepseek-ai/dsh-experimental-component-kit/src/client/renderer
 */

import type { ComponentType } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComponentKitKey } from './locales.ts'

/** Translate bound to this row's namespace, as a renderer receives it. */
export type ComponentKitTranslate = Translate<ComponentKitKey>

/**
 * What one user gesture inside a block reports.
 *
 * The block never acts on it: a component in this row performs no navigation,
 * no network call, and no write. It says what happened and the placement
 * package decides whether anything comes of it.
 * @param actionId - the id declared by whichever control the user used.
 * @param nodeId - {@link ComponentRendererProps.nodeId} of the block it happened in.
 */
export type ComponentActionHandler = (actionId: string, nodeId: string) => void

/** One block's props. */
export interface ComponentRendererProps<P = Readonly<Record<string, unknown>>> {
  /**
   * Identity of the block within one placement, unique there and stable across
   * the calls that replace one another. Renderers pass it back with every
   * action so a placement holding several blocks knows which one spoke.
   */
  readonly nodeId: string
  /**
   * The block's properties, already checked against the schema that admitted
   * the component: every declared property is present or absent as declared,
   * and no undeclared property survived.
   */
  readonly props: P
  /** Where a user gesture goes. */
  readonly onAction: ComponentActionHandler
  /** This row's translate, for the copy a renderer owns rather than receives. */
  readonly t: ComponentKitTranslate
}

/** A component this row offers, as the table stores it. */
export type ComponentRenderer = ComponentType<ComponentRendererProps>
