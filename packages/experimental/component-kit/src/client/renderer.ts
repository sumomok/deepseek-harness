/**
 * This row's reading of the placement package's renderer contract.
 *
 * The contract itself belongs to whoever places a block — it is what the
 * content column's component seat promises every component plugin, and a second
 * component package implements the same one. What this row adds is its own
 * translate: the seat hands each contribution the translate it registered with,
 * and stating that here is what keeps a key this row's dictionary does not
 * carry a compile error inside its renderers.
 * @module @deepseek-ai/dsh-experimental-component-kit/src/client/renderer
 */

import type { ComponentRendererProps as PlacedRendererProps } from '@deepseek-ai/dsh-experimental-component-surface/client'
import type { ComponentKitTranslate } from './locales.ts'

export type {
  ComponentActionHandler,
  ComponentActionPayload,
  ComponentActionState,
  ComponentOutputHandler,
  ComponentRenderer,
} from '@deepseek-ai/dsh-experimental-component-surface/client'

/** One block's props as a renderer of this row receives them: the placement contract, with this row's translate. */
export type ComponentRendererProps<P = Readonly<Record<string, unknown>>> =
  & Omit<PlacedRendererProps<P>, 't'>
  & {
    /** This row's translate, for the copy a renderer owns rather than receives. */
    readonly t: ComponentKitTranslate
  }
