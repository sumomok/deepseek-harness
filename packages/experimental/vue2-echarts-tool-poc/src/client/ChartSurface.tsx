/**
 * The `chart` seat of the content column: the selected chart entry, painted
 * full height.
 *
 * The same engine as the transcript row, with the two things that belong to a
 * call rather than to a chart left out. No verdict is reported from here — the
 * call that would receive it settled when the transcript row answered it, and a
 * second report for a chart the user merely selected again would be about
 * nothing. No capture either, for the same reason.
 *
 * The seat stays mounted while another kind is on display, and renders nothing
 * then: the column hides it with `visibility`, so the engine keeps a laid-out
 * box and the chart it already painted.
 */
import { useMemo, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { EChartsOption } from '@deepseek-ai/dsh-experimental-vue2-echarts-poc/client'
import { readChartCall } from '../chart-call.ts'
import { darkPalette } from './palette.ts'
import { sanitizeChartOption } from './sanitize.ts'
import css from './ChartSurface.module.css'

/** Composed props: the kind-seat runtime share and this package's locale seat. */
export type ChartSurfaceProps =
  & PropsRuntime<'content.surface.kind', 'chart'>
  & PropsLocale<'showChart'>

/**
 * Read the option one surface entry puts on display.
 *
 * The payload crosses the host/browser edge as kind-owned JSON the column
 * itself never interprets, and it is model output besides, so it goes through
 * the same reader and the same sanitizer the transcript row uses.
 * @param payload - the entry's payload, as the column handed it over.
 * @returns the option safe to paint, or undefined when the payload carries none.
 */
function surfaceOption(payload: unknown): Record<string, unknown> | undefined {
  const call = readChartCall(payload)
  return call === undefined ? undefined : sanitizeChartOption(call.option)
}

/**
 * Render the chart seat.
 * @param props - the column's selection and the locale seat.
 * @returns the caption and the chart, or nothing while another kind is selected.
 */
export function ChartSurface({ entry, t }: ChartSurfaceProps) {
  const payload = entry?.payload
  // Memoized on the payload, not on the entry: the sanitized option is what
  // crosses the bridge, and a fresh object every render would make the chart
  // re-apply and re-render forever.
  const option = useMemo(() => (payload === undefined ? undefined : surfaceOption(payload)), [payload])
  // Read once: the shell writes the marker before the client tree boots, and a
  // seat that watched it would be subscribing to the document from a slot.
  const [dark] = useState(darkPalette)

  if (entry === undefined) return null
  if (option === undefined) {
    return (
      <div className={css.seat} data-chart-surface>
        <p className={css.notice} data-chart-surface-error>{t('row.unreadable')}</p>
      </div>
    )
  }
  return (
    <div className={css.seat} data-chart-surface>
      <p className={css.caption}>{entry.title}</p>
      <div className={css.stage} data-chart-surface-stage>
        <EChartsOption option={option} dark={dark} />
      </div>
    </div>
  )
}
