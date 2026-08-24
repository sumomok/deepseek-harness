/**
 * `show_chart` — the agent draws in the conversation and hears back what was
 * drawn.
 *
 * Three layers answer one call, in order, and each one can end it:
 *
 * 1. The chart id, the deployment bounds, and the supported series set
 *    (`validate.ts`). A refusal here costs one round trip and reaches no browser.
 * 2. The render verdict. The call blocks on the browser that painted this call
 *    id until it answers or the deadline passes, so `Rendered:` means a real
 *    engine accepted the document, and `Render failed:` carries the engine's
 *    own message back for the retry.
 * 3. The opt-in screenshot, committed through the attachment service and
 *    returned as an image block, so a vision-capable model sees the picture.
 *
 * The call id the tool waits on is `exec.callId` — the same value the transcript
 * hands the row that renders this call, which is what lets a browser answer for
 * exactly one call. The optional `id` is a different identity: it names the
 * chart across calls, so a corrected call replaces the row an earlier one drew.
 * Which row that is comes out of the `showCharts` projection, not from here —
 * this tool records the id and nothing else.
 * @module @deepseek-ai/dsh-experimental-vue2-echarts-tool-poc/src/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, GenericResultView, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { MAX_CHART_ID_LENGTH, SHOW_CHART_TOOL_NAME } from './chart-call.ts'
import type { PendingCharts } from './pending.ts'
import { storeChartImage, type ChartImageValue } from './screenshot.ts'
import { SUPPORTED_SERIES_LIST, validateChartId, validateChartOption, type ChartOptionArgument } from './validate.ts'

/** Everything one deployment's `show_chart` reads from its plugin row. */
export interface ShowChartPolicy {
  /** Largest accepted `JSON.stringify(option)` in UTF-8 bytes. */
  readonly maxOptionBytes: number
  /** Largest accepted total of `series[i].data` entries. */
  readonly maxPoints: number
  /** How long a browser has to report a verdict before the call answers unverified. */
  readonly verdictTimeoutMs: number
  /** Whether a reporting row captures the painted PNG and the result carries it. */
  readonly screenshot: boolean
}

/** Caption used when a call names none, in both the result text and the call card. */
const UNTITLED = 'chart'

/** The canonical outcome declared by the `show_chart` output schema. */
export interface ShowChartValue {
  /** Whether a browser confirmed the paint. */
  status: 'rendered' | 'unverified'
  /** The model-facing verdict line. */
  text: string
  /** The captured chart, when the deployment enables screenshots and one was stored. */
  image?: ChartImageValue
}

/**
 * Build the model-facing description for one deployment's bounds.
 * @param maxPoints - the deployment's point ceiling, stated so a first call can respect it.
 * @returns the complete description.
 */
export function describeShowChart(maxPoints: number): string {
  return 'Draw a chart inside the conversation the user is reading. Pass a complete ECharts option '
    + 'document as JSON in `option`; it renders where this call appears in the transcript, and the '
    + 'result reports what was painted.\n\n'
    + `Supported series types: ${SUPPORTED_SERIES_LIST}. JSON only — no functions and no expressions. `
    + `Put the numbers inline in series[].data; at most ${maxPoints} data points across all series. `
    + 'Tooltips render as rich text, so tooltip markup is shown literally. The UI picks the theme; '
    + 'set explicit colors only when a specific color carries meaning.\n\n'
    + 'The chart is drawn in a conversation column roughly 500×340 CSS pixels. Put the legend at the '
    + 'bottom and let ECharts place the chart itself; absolute `grid` offsets collide at that size.'
}

/**
 * What the model is asked to do with an attached screenshot. Appended to the
 * result only when a capture was actually stored: the picture without the
 * instruction is read as confirmation and never looked at.
 */
const SCREENSHOT_INSTRUCTION = 'A screenshot of the painted chart is attached — inspect it for layout '
  + 'problems (overlapping legend, labels, or axes; clipped text) and, if any, call show_chart again '
  + 'with a corrected option, reusing the same id.'

/**
 * Build the result line for a call no browser answered.
 * @param verdictTimeoutMs - the deadline that passed.
 * @returns the model-facing line.
 */
export function unverifiedText(verdictTimeoutMs: number): string {
  return `Shown; not verified (no client reported within ${verdictTimeoutMs / 1000}s). `
    + 'The chart is in the transcript and paints when the user views it — do not re-issue the same '
    + 'chart because of this.'
}

/** Re-brand a stored capture into the durable reference an image block carries. */
function imageBlock(image: ChartImageValue): ContentBlock {
  return {
    type: 'image',
    attachment: {
      attachmentId: AttachmentId(image.attachmentId),
      mediaType: image.mediaType,
      bytes: image.bytes,
      width: image.width,
      height: image.height,
    },
  }
}

/**
 * Build the `show_chart` tool for one deployment.
 * @param ctx - the registration scope; execution resolves the optional
 *   `attachments` service from it when a screenshot arrives.
 * @param policy - the deployment's validated bounds and switches.
 * @param pending - the table calls wait on for their browser verdict.
 * @returns the definition to hand to `ctx.tools.register`.
 */
export function showChartTool(ctx: Context, policy: ShowChartPolicy, pending: PendingCharts): ToolDefinition {
  return defineTool({
    name: SHOW_CHART_TOOL_NAME,
    description: describeShowChart(policy.maxPoints),
    parameters: {
      id: {
        type: 'string',
        description: 'Stable id of the chart, at most '
          + `${MAX_CHART_ID_LENGTH} characters. Reuse an earlier chart's id when correcting or `
          + 'updating it: the newer call replaces the older one where the user is reading. Omit it '
          + 'for a chart that stands on its own.',
      },
      title: {
        type: 'string',
        description: 'Short caption shown with the chart. Omit for none.',
      },
      option: {
        type: 'object',
        additionalProperties: true,
        required: true,
        description: 'The complete ECharts option document.',
        properties: {
          series: {
            type: 'array',
            required: true,
            description: `One entry per series; each declares a "type" of ${SUPPORTED_SERIES_LIST} and inline "data".`,
            items: { type: 'json' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: {
            type: 'string',
            enum: ['rendered', 'unverified'],
            required: true,
            description: 'Whether a browser confirmed the paint.',
          },
          text: { type: 'string', required: true, description: 'The verdict line.' },
          image: {
            type: 'object',
            additionalProperties: false,
            description: 'The captured chart, when this deployment enables screenshots.',
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', enum: ['image/png'], required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
            },
          },
        },
      },
      // Two text blocks rather than one: the verdict line alone titles the
      // settled call card, and the instruction is for the model only.
      render: (_args, value) => [
        { type: 'text', text: value.text },
        ...value.image === undefined
          ? []
          : [{ type: 'text' as const, text: SCREENSHOT_INSTRUCTION }, imageBlock(value.image)],
      ],
    },
    // The tool writes nothing and only waits on a browser, so two charts in one
    // step paint and report side by side instead of queueing two deadlines.
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<ShowChartValue> {
      const refusal = validateChartId(args.id)
        ?? validateChartOption(args.option as ChartOptionArgument, policy)
      if (refusal !== undefined) throw new Error(refusal)

      const report = await pending.settle(exec.callId, policy.verdictTimeoutMs, exec.signal)
      if (report === undefined) {
        return { status: 'unverified', text: unverifiedText(policy.verdictTimeoutMs) }
      }
      if (!report.verdict.ok) throw new Error(`Render failed: ${report.verdict.error}`)

      const text = `Rendered: ${args.title ?? UNTITLED} — ${report.verdict.seriesCount} series, `
        + `${report.verdict.pointCount} points`
      const attachments = ctx.get('attachments')
      // Screenshots that no store can hold are dropped rather than refused: the
      // verdict is the tool's answer, and the picture is an addition to it.
      const image = policy.screenshot && report.dataUrl !== undefined && attachments !== undefined
        ? await storeChartImage(attachments, report.dataUrl, exec.callId)
        : undefined
      return { status: 'rendered', text, ...image === undefined ? {} : { image } }
    },
    presentCall: (args): GenericCallView => ({
      card: 'generic',
      title: `show_chart ${args.title ?? UNTITLED}`,
      kind: 'other',
    }),
    presentResult: (_args, result): GenericResultView => ({
      card: 'generic',
      title: result.content.find(block => block.type === 'text')?.text ?? UNTITLED,
    }),
  })
}
