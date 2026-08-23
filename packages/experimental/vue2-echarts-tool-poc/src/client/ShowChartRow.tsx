/**
 * The `show_chart` row: one tool call's option, painted where the call sits in
 * the transcript, and the verdict sent back to the call still waiting for it.
 *
 * The row is a pure function of the call slice plus its own verdict state. It
 * reads `title` and `option` from the arguments the log carries, so it draws a
 * running call as soon as its arguments exist and redraws a settled one on
 * replay; it subscribes to nothing and derives nothing from a previous render.
 *
 * The stage is laid out but invisible until a verdict says the option painted.
 * `visibility` rather than `display`, because ECharts sizes its canvas from a
 * laid-out element — a hidden-by-layout host would hand it a zero-sized one and
 * the verdict would never be about the chart the user ends up seeing.
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
import { SHOW_CHART_REPORT_ROUTE, type ShowChartReport } from '../route.ts'
import { sanitizeChartOption } from './sanitize.ts'
import css from './show-chart.module.css'

/** Plain data this registration injects. */
export interface ShowChartFace {
  /** Whether this deployment asked for the painted PNG, as the node half configured it. */
  screenshot: boolean
}

/** Composed props: the toolview runtime share, the injected face, and this package's locale seat. */
export type ShowChartRowProps = ToolCallViewProps & ShowChartFace & PropsLocale<'showChart'>

/**
 * The dark-palette marker on `document.body`. Written by whichever shell is
 * composed — `dsh-client-ui-layout`'s theme presenter under the shipped
 * surface, `dsh-experimental-server-layout`'s under the service-line one — so
 * the row reads the attribute rather than depending on either package.
 */
const DARK_ATTRIBUTE = 'data-ds-dark-theme'

/** One call's arguments, as this row needs them. */
interface ChartCall {
  /** Caption the model gave the chart, when it gave one. */
  readonly title?: string
  /** The option document to paint. */
  readonly option: Record<string, unknown>
}

/** The raw argument JSON of a call in either lifecycle form. */
function argumentsOf(block: ToolCallBlock): string | undefined {
  return 'kind' in block ? block.call?.argsRaw : block.argsRaw
}

/**
 * Read one call's chart arguments.
 * @param argsRaw - the raw argument JSON the log carries, if any.
 * @returns the caption and option, or `undefined` when the log carries neither.
 */
function chartCall(argsRaw: string | undefined): ChartCall | undefined {
  if (argsRaw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw)
  } catch (_argumentsAreNotJson) {
    // A log this row cannot read is the only thing this tells us; the error
    // row below says so, and there is nothing else to recover.
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const candidate = parsed as { title?: unknown; option?: unknown }
  if (candidate.option === null || typeof candidate.option !== 'object' || Array.isArray(candidate.option)) {
    return undefined
  }
  return {
    ...typeof candidate.title === 'string' ? { title: candidate.title } : {},
    option: candidate.option as Record<string, unknown>,
  }
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
export function ShowChartRow({ callId, block, screenshot, t }: ShowChartRowProps) {
  const argsRaw = argumentsOf(block)
  // Memoized on the raw arguments, not on the node: the sanitized option is
  // what crosses the bridge, and a fresh object every render would make the
  // chart re-apply, re-report, and re-render forever.
  const call = useMemo(() => {
    const parsed = chartCall(argsRaw)
    return parsed === undefined ? undefined : { ...parsed, option: sanitizeChartOption(parsed.option) }
  }, [argsRaw])
  const [verdict, setVerdict] = useState<ChartVerdict | undefined>(undefined)
  // Read once: the shell writes the marker before the client tree boots, and a
  // row that watched it would be subscribing to the document from a slot.
  const [dark] = useState(() => document.body.hasAttribute(DARK_ATTRIBUTE))
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

  return (
    <div className={css.row}>
      <p className={css.caption}>{caption}</p>
      {verdict?.ok === false
        ? <p className={css.error} data-show-chart-error>{t('row.failed', { error: verdict.error })}</p>
        : (
          <>
            {verdict === undefined && <p className={css.caption}>{t('row.rendering')}</p>}
            <div className={css.stage} data-show-chart-stage data-verified={verdict === undefined ? 'no' : 'yes'}>
              <EChartsOption
                option={call.option}
                dark={dark}
                capture={screenshot}
                onCapture={(dataUrl) => { captured.current = dataUrl }}
                onVerdict={sendVerdict}
              />
            </div>
          </>
        )}
    </div>
  )
}
