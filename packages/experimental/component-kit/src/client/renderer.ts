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
 * What one gesture carries beyond the id of the control that produced it.
 *
 * A record of values the user could already read on screen — the rows a table
 * has selected, the option a filter now holds — never the data a component was
 * given in full. Which properties one action may carry is the placement
 * package's catalog to declare, and keeping to it is this row's obligation:
 * a renderer puts nothing here that the catalog does not name for that action.
 * Every value must survive `JSON.stringify`, because the placement package
 * sends the record as one command line.
 */
export type ComponentActionPayload = Readonly<Record<string, unknown>>

/**
 * What one user gesture inside a block reports.
 *
 * The block never acts on it: a component in this row performs no navigation,
 * no network call, and no write. It says what happened and the placement
 * package decides whether anything comes of it.
 *
 * Nothing identifying the block travels through this call. The placement
 * package binds one handler per block and already holds
 * {@link ComponentRendererProps.nodeId}, so a renderer that reported it too
 * would give one fact two sources.
 * @param actionId - the id of the action this gesture is, as the placement package's catalog declares it.
 * @param payload - what the gesture carries; the empty record when the action declares no properties.
 */
export type ComponentActionHandler = (actionId: string, payload: ComponentActionPayload) => void

/**
 * What one block publishes for the blocks beside it to read.
 *
 * An output is the block's own current reading of itself — the rows a table has
 * ticked, the conditions a filter now holds — republished whenever it changes.
 * It is not a gesture: nothing is recorded, nothing reaches the agent, and a
 * block that publishes one has still reported nothing. Which outputs a
 * component publishes is the placement package's catalog to declare, exactly as
 * for an action, and keeping to that declaration is this row's obligation.
 *
 * Every value must survive `JSON.stringify` and be treated as read-only: the
 * placement package hands it straight to another block as a property, and a
 * value a publisher goes on mutating would be a property that changed under a
 * component nobody re-rendered.
 * @param outputId - the id of the output being published, as the placement package's catalog declares it.
 * @param value - its current value.
 */
export type ComponentOutputHandler = (outputId: string, value: unknown) => void

/**
 * How far the gesture a block last reported got, as the placement package folds
 * it out of the session's own records.
 *
 * A renderer is told rather than remembering: the placement package unmounts a
 * block whenever the user looks at something else, so a bar that kept its own
 * pressed flag would come back untouched and let one decision be reported
 * twice. `idle` is a block nobody has pressed and the only state besides
 * `refused` from which a gesture may still be reported.
 */
export type ComponentActionState =
  /** Nothing reported yet, or nothing reported for the call now on display. */
  | 'idle'
  /** Reported, and the record settling it has not come back yet. */
  | 'sending'
  /** The placement package handed it over and the agent is reading it now. */
  | 'sent'
  /** It is waiting for the agent, which will read it when the user writes again. */
  | 'queued'
  /** It reached nobody — refused where it was resolved, or never recorded at all; reporting it again is the only thing left to try. */
  | 'refused'

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
  /**
   * Where this block's current reading of itself goes, for the blocks beside it
   * to take a property from. A component that publishes nothing never calls it.
   */
  readonly onOutput: ComponentOutputHandler
  /**
   * How far this block's last reported gesture got. A renderer draws it and
   * decides from it whether a further gesture may be reported; it never keeps a
   * copy of its own.
   */
  readonly state: ComponentActionState
  /** This row's translate, for the copy a renderer owns rather than receives. */
  readonly t: ComponentKitTranslate
}

/** A component this row offers, as the table stores it. */
export type ComponentRenderer = ComponentType<ComponentRendererProps>
