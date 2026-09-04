/**
 * The `component` seat of the content column: the blocks the selected call
 * placed, stacked in the order it wrote them.
 *
 * The seat re-reads the payload before drawing it. That is not distrust of the
 * host it shares a repository with: an entry's payload can come from a persisted
 * checkpoint written by another composition, whose catalog and ceilings were not
 * this build's, so the type it arrives with is a claim rather than a guarantee.
 * The check is the same module the tool judged the call with, which is why that
 * module imports nothing.
 *
 * While another kind holds the column, the column hands the seat no entry and the
 * seat draws nothing; what `visibility` keeps mounted is the column's own wrapper
 * for the kind, not the blocks. Their DOM goes with the draw, so nothing a user
 * typed into a block survives a switch to another kind or to another entry.
 */
import { useMemo } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  COMPONENT_RENDERERS,
  type ComponentActionHandler,
  type ComponentKitTranslate,
  type ComponentRenderer,
} from '@deepseek-ai/dsh-experimental-component-kit/client'
import { type CatalogId, type ComponentNode, type ComponentSurfacePayload } from '../component-call.ts'
import { validateComponentSpec } from '../validate.ts'
import css from './ComponentSurface.module.css'

/**
 * Every component this seat can draw.
 *
 * `CatalogId` is derived from `COMPONENT_CATALOG` itself, so this line is where
 * the two tables are tied together: a catalog entry this deployment has no
 * renderer for leaves the union carrying a key the renderer table lacks, and
 * fails to compile here instead of becoming a blank block a user has to report.
 * A renderer no catalog entry names is unreachable rather than wrong, and passes.
 */
const RENDERERS = COMPONENT_RENDERERS satisfies Record<CatalogId, ComponentRenderer>

/** The same table, keyed for lookup by the id a validated node names. */
const RENDERER_BY_ID: ReadonlyMap<string, ComponentRenderer> = new Map(Object.entries(RENDERERS))

/**
 * Where a pressed button goes today, which is nowhere.
 *
 * A block reports what the user did; carrying that report back to the agent is a
 * separate channel this package does not have yet. Until it does, the seat is
 * the sink, and the tool description tells the model in as many words that what
 * the user does with a block does not come back.
 */
const REPORT_NOTHING: ComponentActionHandler = () => {}

/** Composed props: the kind-seat runtime share and the component row's locale seat. */
export type ComponentSurfaceProps =
  & PropsRuntime<'content.surface.kind', 'component'>
  & PropsLocale<'componentKit'>

/**
 * Read the blocks one surface entry puts on display.
 * @param payload - the entry's payload, as the column handed it over.
 * @returns the blocks to draw, or undefined when the payload carries no spec this build accepts.
 */
function surfaceNodes(payload: unknown): readonly ComponentNode[] | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const result = validateComponentSpec((payload as Partial<ComponentSurfacePayload>).spec)
  return result.ok ? result.spec.nodes : undefined
}

/** One block's own render inputs. */
interface ComponentBlockProps {
  /** The entry the block belongs to. */
  readonly entryId: string
  /** Log sequence of the call that currently owns the entry. */
  readonly seq: number
  /** The block. */
  readonly node: ComponentNode
  /** The component row's translate, for the copy a renderer owns. */
  readonly t: ComponentKitTranslate
}

/**
 * Render one block.
 *
 * The memo is per block rather than per entry so that the identity of what one
 * renderer receives is a fact about that block alone: a block is rebuilt when
 * its own entry is replaced, and a redraw somewhere else in the stack leaves it
 * holding exactly the props it already had.
 * @param props - the block, its entry's identity, and the translate.
 * @returns the component the block names, or the notice for one this build cannot draw.
 */
function ComponentBlock({ entryId, seq, node, t }: ComponentBlockProps) {
  return useMemo(() => {
    const Renderer = RENDERER_BY_ID.get(node.component)
    if (Renderer === undefined) {
      return (
        <p className={css.notice} data-component-surface-unsupported={node.component}>
          {t('block.unsupported')}
        </p>
      )
    }
    return <Renderer nodeId={node.id} props={node.props} onAction={REPORT_NOTHING} t={t} />
  }, [entryId, seq, node, t])
}

/**
 * Render the component seat.
 * @param props - the column's selection and the locale seat.
 * @returns the caption and the blocks, or nothing while another kind is selected.
 */
export function ComponentSurface({ entry, t }: ComponentSurfaceProps) {
  const payload = entry?.payload
  // Memoized on the payload: the validated node list is what every block's props
  // identity hangs from, and a fresh list every render would rebuild the stack.
  const nodes = useMemo(() => (payload === undefined ? undefined : surfaceNodes(payload)), [payload])

  if (entry === undefined) return null
  if (nodes === undefined) {
    return (
      <div className={css.seat} data-component-surface>
        <p className={css.notice} data-component-surface-error>{t('block.unreadable')}</p>
      </div>
    )
  }
  return (
    <div className={css.seat} data-component-surface>
      <p className={css.caption}>{entry.title}</p>
      <div className={css.stack} data-component-surface-stack>
        {nodes.map(node => (
          <ComponentBlock key={node.id} entryId={entry.entryId} seq={entry.seq} node={node} t={t} />
        ))}
      </div>
    </div>
  )
}
