/**
 * The `show_chart` row: one tool call's option, painted where the call sits in
 * the transcript, and the verdict sent back to the call still waiting for it.
 *
 * The row is a pure function of the call slice, the session's `showCharts`
 * projection, and its own verdict state. It reads `id`, `title`, and `option`
 * from the arguments the log carries, so it draws a running call as soon as its
 * arguments exist and redraws a settled one on replay; it subscribes to nothing
 * and derives nothing from a previous render.
 *
 * A call naming an `id` an earlier call already used replaces that earlier
 * chart. Both rows stay in the transcript — the log is what happened — but the
 * superseded one collapses to a one-line notice: no canvas, no engine, and no
 * verdict, because the call it would answer settled long ago. Which row is the
 * current one comes from the projection, which folds the whole log; a row
 * cannot see the calls after it on its own.
 *
 * The stage is laid out but invisible until a verdict says the option painted.
 * `visibility` rather than `display`, because ECharts sizes its canvas from a
 * laid-out element — a hidden-by-layout host would hand it a zero-sized one and
 * the verdict would never be about the chart the user ends up seeing.
 *
 * Where a content column is composed, the same chart is already on display
 * beside the conversation, so the row hands the picture over and keeps only a
 * compact card. It still mounts the engine, because the verdict and the capture
 * are the call's and no other placement reports them — off the layout flow at a
 * fixed size, so a conversation full of charts costs no height, and unmounted
 * the moment the verdict is in. A failed chart is the exception: the column
 * cannot show what did not paint, so the error line stays in the conversation.
 *
 * One report per call id, guarded here rather than at the host: a re-render, a
 * palette rebuild, and a second `finished` all reach the same guard, and the
 * host ignores whatever slips past it anyway.
 */
import { useMemo, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { EChartsOption, type ChartVerdict } from '@deepseek-ai/dsh-experimental-vue2-echarts-poc/client'
// Type-only: pulls the content surface's `contentSurface` SessionProjectionMap merge.
import type {} from '@deepseek-ai/dsh-experimental-content-surface/types'
// Type-only: pulls this package's own `showCharts` SessionProjectionMap merge.
import type {} from '../types.ts'
import { parseChartCall } from '../chart-call.ts'
import { SHOW_CHART_REPORT_ROUTE, type ShowChartReport } from '../route.ts'
import { darkPalette } from './palette.ts'
import { sanitizeChartOption } from './sanitize.ts'
import css from './show-chart.module.css'

/** Plain data this registration injects. */
export interface ShowChartFace {
  /** Whether this deployment asked for the painted PNG, as the node half configured it. */
  screenshot: boolean
}

/** Composed props: the toolview runtime share, the injected face, and this package's locale seat. */
export type ShowChartRowProps = ToolCallViewProps & ShowChartFace & PropsLocale<'showChart'>

/** The raw argument JSON of a call in either lifecycle form. */
function argumentsOf(block: ToolCallBlock): string | undefined {
  return 'kind' in block ? block.call?.argsRaw : block.argsRaw
}

/** Post one verdict to the node half; a lost report is the tool's own deadline to answer. */
function postReport(report: ShowChartReport): void {
  void fetch(SHOW_CHART_REPORT_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report),
  }).catch(() => {
    // Nothing else consumes this promise: a report that never lands leaves the
    // waiting call to its own verdict deadline, which answers `not verified`.
  })
}

/**
 * Render one `show_chart` call.
 * @param props - the toolview runtime share, the injected face, and the locale seat.
 * @returns the chart row.
 */
export function ShowChartRow({ callId, block, screenshot, useProjection, t }: ShowChartRowProps) {
  const argsRaw = argumentsOf(block)
  // Memoized on the raw arguments, not on the node: the sanitized option is
  // what crosses the bridge, and a fresh object every render would make the
  // chart re-apply, re-report, and re-render forever.
  const call = useMemo(() => {
    const parsed = argsRaw === undefined ? undefined : parseChartCall(argsRaw)
    return parsed === undefined ? undefined : { ...parsed, option: sanitizeChartOption(parsed.option) }
  }, [argsRaw])
  const charts = useProjection('showCharts')
  // The presence of the projection is the whole question, so the selector reads
  // it as one boolean: every entry the column lists moves it, and the row has
  // no business re-rendering for a page another package put there.
  const delegated = useProjection('contentSurface', view => view !== undefined)
  const [verdict, setVerdict] = useState<ChartVerdict | undefined>(undefined)
  // Read once: the shell writes the marker before the client tree boots, and a
  // row that watched it would be subscribing to the document from a slot.
  const [dark] = useState(darkPalette)
  const captured = useRef<string | undefined>(undefined)
  const reported = useRef<string | undefined>(undefined)

  if (call === undefined) {
    return (
      <div className={css.row}>
        <p className={css.error} data-show-chart-error>{t('row.unreadable')}</p>
      </div>
    )
  }

  const caption = call.title ?? t('row.title')
  // An absent projection is not a superseded row: the value lags its log by a
  // frame, and a composition without a projection registry never publishes one.
  const owner = charts?.latest[call.id ?? callId]
  if (owner !== undefined && owner !== callId) {
    return (
      <div className={css.row}>
        <p className={css.superseded} data-show-chart-superseded>{t('row.superseded', { title: caption })}</p>
      </div>
    )
  }

  const sendVerdict = (answer: ChartVerdict): void => {
    setVerdict(answer)
    if (reported.current === callId) return
    reported.current = callId
    postReport({
      callId,
      verdict: answer,
      ...captured.current === undefined ? {} : { dataUrl: captured.current },
    })
  }

  // A document the engine refused: the column has no chart to show either, so
  // the conversation keeps the engine's own message where the call sits.
  if (verdict?.ok === false) {
    return (
      <div className={css.row}>
        <p className={css.caption}>{caption}</p>
        <p className={css.error} data-show-chart-error>{t('row.failed', { error: verdict.error })}</p>
      </div>
    )
  }

  const engine = (
    <EChartsOption
      option={call.option}
      dark={dark}
      capture={screenshot}
      onCapture={(dataUrl) => { captured.current = dataUrl }}
      onVerdict={sendVerdict}
    />
  )

  if (delegated) {
    return (
      <div className={css.row}>
        <p className={css.delegated} data-show-chart-delegated={verdict === undefined ? 'pending' : 'shown'}>
          {verdict === undefined ? t('row.delegating', { title: caption }) : t('row.delegated', { title: caption })}
        </p>
        {/* Off the flow at a fixed size while the call waits for its verdict,
            and gone once it has one: the picture belongs to the column, the
            verdict and the capture belong to this call. */}
        {verdict === undefined && (
          <div className={`${css.stage} ${css.offstage}`} data-show-chart-stage data-verified="no">
            {engine}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={css.row}>
      <p className={css.caption}>{caption}</p>
      {verdict === undefined && <p className={css.caption}>{t('row.rendering')}</p>}
      <div className={css.stage} data-show-chart-stage data-verified={verdict === undefined ? 'no' : 'yes'}>
        {engine}
      </div>
    </div>
  )
}
