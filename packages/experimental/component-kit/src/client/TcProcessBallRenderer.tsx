/**
 * `el.metric` — one number, drawn as a ball filled to that number.
 *
 * The component is `TcProcessBall`, compiled outside this repository and
 * vendored as `@sumomok/toy-surface-kit`. One number over one caption is the
 * shape a console reaches for most often, and this is the one those libraries
 * already draw it in.
 *
 * A metric reports nothing and publishes nothing. `onAction`, `onOutput`, the
 * action state, and the translate go unread here, and the block draws the same
 * in every one of them.
 *
 * The three colors are the caller's, and they arrive already narrowed to a
 * hex or `rgb()`/`rgba()` value by the placement package's tightening pass —
 * this renderer hands them to the component's own inline styles and reads
 * nothing further into them. The component lightens the background for the top
 * of its gradient, and the vendored build's stand-in for that lightening leaves
 * a color keyword untouched, so a color spelled any other way draws a ball with
 * no gradient rather than failing.
 *
 * The component animates from the number it last drew to the new one on a chain
 * of timers. The vendored build stops that chain in `beforeDestroy` (patch
 * `0005`), so the bridge's own teardown is what keeps a block that goes away
 * from leaving a timer behind writing to a destroyed instance.
 */
import { useMemo } from 'react'
import { TcProcessBall } from '@sumomok/toy-surface-kit'
import { readBoolean, readNumber, readText } from './props.ts'
import { useVueComponent } from './vue2-bridge.tsx'
import type { ComponentRendererProps } from './renderer.ts'

/** The catalog id a block names to get this component. */
const COMPONENT_ID = 'el.metric'

/** What `TcProcessBall` receives, as this renderer builds it. */
type TcProcessBallVueProps = {
  /** Diameter in pixels; the component's own default applies when absent. */
  readonly size?: number
  /** The number, drawn as itself and read as a percentage for the fill level. */
  readonly process?: number
  /** The caption under the number. */
  readonly text?: string
  /** Ball color, and the lower end of its gradient. */
  readonly background?: string
  /** Color of the glow around the ball. */
  readonly borderColor?: string
  /** Color of the five dots beside the ball. */
  readonly pointColor?: string
  /** Whether those dots are drawn at all. */
  readonly isPointShow?: boolean
}

/**
 * Narrow a block's properties to what `TcProcessBall` declares.
 * @param props - the block's already-validated properties.
 * @returns the component's prop record, with an absent optional left absent so the component's own default applies.
 */
function readTcProcessBall(props: ComponentRendererProps['props']): TcProcessBallVueProps {
  const size = readNumber(props['size'])
  const process = readNumber(props['process'])
  const text = readText(props['text'])
  const background = readText(props['background'])
  const borderColor = readText(props['borderColor'])
  const pointColor = readText(props['pointColor'])
  const isPointShow = readBoolean(props['isPointShow'])
  return {
    ...(size === undefined ? {} : { size }),
    ...(process === undefined ? {} : { process }),
    ...(text === undefined ? {} : { text }),
    ...(background === undefined ? {} : { background }),
    ...(borderColor === undefined ? {} : { borderColor }),
    ...(pointColor === undefined ? {} : { pointColor }),
    ...(isPointShow === undefined ? {} : { isPointShow }),
  }
}

/**
 * Render one metric block.
 * @param rendererProps - the block's identity and its properties. A metric
 * reports nothing, so the action sink, the output sink, the action state, and
 * the translate go unread.
 * @returns the host element the Vue component is mounted into.
 */
export function TcProcessBallRenderer({ nodeId, props }: ComponentRendererProps) {
  // Keyed on the block's property record: the placement package hands over the
  // same object until the call behind the block changes, so an unrelated React
  // commit does not restart the fill animation.
  const vueProps = useMemo(() => readTcProcessBall(props), [props])
  const host = useVueComponent<HTMLDivElement>({ component: TcProcessBall, props: vueProps })
  return <div ref={host} data-component-block={COMPONENT_ID} data-component-node={nodeId} />
}
