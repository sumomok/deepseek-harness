/**
 * `show_chart` against the real tool runtime: the model-visible surface (name,
 * description, parameter schema, every result line) pinned verbatim, and the
 * three layers that decide a call — the deployment bounds, the render verdict
 * the call blocks on, and the opt-in screenshot.
 *
 * The browser is a fake here on purpose: the round trip's live half is what the
 * web e2e boots, and what a unit can prove is the correlation and the settlement
 * rules. Every verdict is delivered through {@link PendingCharts.report} under
 * the execution's own `callId`, which is the value a browser reads off the
 * transcript — the correlation spec below asserts they are the same string.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { PendingCharts } from '../src/pending.ts'
import { FakeAttachments } from './fake-attachments.client.ts'
import { describeShowChart, showChartTool, unverifiedText, type ShowChartPolicy } from '../src/tool.ts'

/** The deployment under test: bounds wide enough that only the case under test can fail. */
const POLICY: ShowChartPolicy = {
  maxOptionBytes: 65536,
  maxPoints: 2000,
  verdictTimeoutMs: 40,
  screenshot: false,
}

const BAR = { series: [{ type: 'bar', data: [1, 2, 3] }] }
/** A one-by-one transparent PNG, as a browser capture arrives. */
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='

let calls = 0

/** One booted deployment: the registered tool, the verdict table, and a runner. */
interface Bench {
  pending: PendingCharts
  attachments: FakeAttachments | undefined
  definition: ToolDefinition
  /** Dispatch one call and answer its wait through `answer`, which sees the live call id. */
  readonly run: (args: Record<string, unknown>, answer?: (callId: string) => void) => Promise<ToolExecutionResult>
}

/** Boot the tool over a real registry, optionally with an image store mounted. */
async function bench(
  overrides: Partial<ShowChartPolicy> = {},
  withAttachments = false,
): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const attachments = withAttachments ? new FakeAttachments(ctx) : undefined
  const pending = new PendingCharts()
  const definition = showChartTool(ctx, { ...POLICY, ...overrides }, pending)
  ctx.tools.register(definition)
  return {
    pending,
    attachments,
    definition,
    run: async (args, answer) => {
      const callId = `call-${++calls}` as ToolExecutionInput['callId']
      const settled = ctx.tools.execute({
        callId,
        name: 'show_chart',
        arguments: args,
        signal: new AbortController().signal,
      })
      // The browser answers only once the call is actually waiting; the wait is
      // registered inside the tool body, one microtask after dispatch.
      if (answer !== undefined) {
        await Promise.resolve()
        await Promise.resolve()
        answer(callId)
      }
      return await settled
    },
  }
}

/** The model-facing text of one settled execution. */
function text(result: ToolExecutionResult): string {
  return result.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

describe('show_chart model-visible surface', () => {
  it('offers one tool whose description states the supported set and the point ceiling', async () => {
    const { definition } = await bench()
    expect(definition.name).toBe('show_chart')
    expect(definition.description).toBe(
      'Draw a chart inside the conversation the user is reading. Pass a complete ECharts option '
      + 'document as JSON in `option`; it renders where this call appears in the transcript, and the '
      + 'result reports what was painted.\n\n'
      + 'Supported series types: bar, line, pie. JSON only — no functions and no expressions. '
      + 'Put the numbers inline in series[].data; at most 2000 data points across all series. '
      + 'Tooltips render as rich text, so tooltip markup is shown literally. The UI picks the theme; '
      + 'set explicit colors only when a specific color carries meaning.',
    )
  })

  it('states the deployment\'s own point ceiling rather than a fixed one', () => {
    expect(describeShowChart(50)).toContain('at most 50 data points across all series')
  })

  it('requires an option object carrying a series array', async () => {
    const { definition } = await bench()
    expect(definition.parameters).toEqual({
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short caption shown with the chart. Omit for none.' },
        option: {
          type: 'object',
          additionalProperties: true,
          description: 'The complete ECharts option document.',
          properties: {
            series: {
              type: 'array',
              description: 'One entry per series; each declares a "type" of bar, line, pie and inline "data".',
              items: {},
            },
          },
          required: ['series'],
        },
      },
      required: ['option'],
    })
  })

  it('rejects a call with no option before the tool body runs', async () => {
    const { run } = await bench()
    const result = await run({ title: 'nothing' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('option')
  })
})

describe('show_chart deployment bounds', () => {
  it('refuses an oversized option without waiting for a browser', async () => {
    const { run } = await bench({ maxOptionBytes: 40 })
    const result = await run({ option: { series: [{ type: 'bar', data: [1, 2, 3, 4, 5] }] } })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(
      'Error: show_chart: the option is 46 bytes; this deployment accepts at most 40. Send fewer points or shorter labels.',
    )
  })

  it('refuses an empty series list', async () => {
    const { run } = await bench()
    const result = await run({ option: { series: [] } })
    expect(text(result)).toBe('Error: show_chart: option.series must list at least one series.')
  })

  it('refuses an unsupported series type, naming the supported ones', async () => {
    const { run } = await bench()
    const result = await run({ option: { series: [{ type: 'sankey', data: [] }] } })
    expect(text(result)).toBe(
      'Error: show_chart: unsupported series type "sankey" at series[0]. Supported types: bar, line, pie.',
    )
  })

  it('refuses more points than the deployment accepts', async () => {
    const { run } = await bench({ maxPoints: 2 })
    const result = await run({ option: BAR })
    expect(text(result)).toBe(
      'Error: show_chart: the option carries 3 data points; this deployment accepts at most 2. Aggregate the data before charting it.',
    )
  })
})

describe('show_chart render verdict', () => {
  it('reports what the browser painted, under the caption the call gave', async () => {
    const { pending, run } = await bench()
    const result = await run({ title: 'Weekly revenue', option: BAR }, (callId) => {
      pending.report({ callId, verdict: { ok: true, seriesCount: 1, pointCount: 3 } })
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('Rendered: Weekly revenue — 1 series, 3 points')
    expect(result.value).toEqual({ status: 'rendered', text: 'Rendered: Weekly revenue — 1 series, 3 points' })
  })

  it('names an untitled call `chart`', async () => {
    const { pending, run } = await bench()
    const result = await run({ option: BAR }, (callId) => {
      pending.report({ callId, verdict: { ok: true, seriesCount: 2, pointCount: 9 } })
    })
    expect(text(result)).toBe('Rendered: chart — 2 series, 9 points')
  })

  it('waits on the execution\'s own call id, which is what a browser reads off the transcript', async () => {
    const { pending, run } = await bench()
    const seen: string[] = []
    await run({ option: BAR }, (callId) => {
      seen.push(callId)
      // The transcript hands a row this exact string as `callId`; a verdict
      // under any other id reaches no call.
      expect(pending.report({ callId: `${callId}-other`, verdict: { ok: true, seriesCount: 1, pointCount: 3 } })).toBe(false)
      expect(pending.report({ callId, verdict: { ok: true, seriesCount: 1, pointCount: 3 } })).toBe(true)
    })
    expect(seen).toHaveLength(1)
  })

  it('fails the call with the engine\'s own message so the model can retry', async () => {
    const { pending, run } = await bench()
    const result = await run({ option: BAR }, (callId) => {
      pending.report({ callId, verdict: { ok: false, error: 'Series data is not an array' } })
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Error: Render failed: Series data is not an array')
  })

  it('answers unverified when no browser reports before the deadline', async () => {
    const { run } = await bench({ verdictTimeoutMs: 20 })
    const result = await run({ option: BAR })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('Shown; not verified (no client reported within 0.02s)')
    expect(unverifiedText(8000)).toBe('Shown; not verified (no client reported within 8s)')
  })

  it('ignores a second report for the same call', async () => {
    const { pending, run } = await bench()
    const result = await run({ option: BAR }, (callId) => {
      expect(pending.report({ callId, verdict: { ok: true, seriesCount: 1, pointCount: 3 } })).toBe(true)
      // A replayed row, a second browser tab, or a palette rebuild: the call is
      // already settled, so the second verdict changes nothing.
      expect(pending.report({ callId, verdict: { ok: false, error: 'ignored' } })).toBe(false)
    })
    expect(text(result)).toBe('Rendered: chart — 1 series, 3 points')
  })

  it('ignores a report for a call this host never ran', async () => {
    const { pending } = await bench()
    expect(pending.report({ callId: 'call_from_a_replayed_log', verdict: { ok: true, seriesCount: 1, pointCount: 1 } }))
      .toBe(false)
  })
})

describe('show_chart screenshot', () => {
  it('commits the capture and returns it as an image block', async () => {
    const world = await bench({ screenshot: true }, true)
    const result = await world.run({ option: BAR }, (callId) => {
      world.pending.report({
        callId,
        verdict: { ok: true, seriesCount: 1, pointCount: 3 },
        dataUrl: PNG_DATA_URL,
      })
    })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([
      { type: 'text', text: 'Rendered: chart — 1 series, 3 points' },
      {
        type: 'image',
        attachment: {
          attachmentId: 'sha256-chart',
          mediaType: 'image/png',
          bytes: 16,
          width: 640,
          height: 320,
        },
      },
    ])
    expect(world.attachments?.saved[0]?.mediaType).toBe('image/png')
    expect(world.attachments?.saved[0]?.name).toMatch(/^show_chart-call-\d+\.png$/)
    expect(world.attachments?.saved[0]?.data).toEqual(Buffer.from(PNG_DATA_URL.split(',')[1] as string, 'base64'))
  })

  it('drops a capture the store refuses and keeps the verdict', async () => {
    const world = await bench({ screenshot: true }, true)
    if (world.attachments !== undefined) {
      world.attachments.refusal = new AttachmentError('too many pixels', 'IMAGE_TOO_MANY_PIXELS')
    }
    const result = await world.run({ option: BAR }, (callId) => {
      world.pending.report({
        callId,
        verdict: { ok: true, seriesCount: 1, pointCount: 3 },
        dataUrl: PNG_DATA_URL,
      })
    })
    expect(result.content).toEqual([{ type: 'text', text: 'Rendered: chart — 1 series, 3 points' }])
  })

  it('fails the call on a store fault that is not an admission decision', async () => {
    const world = await bench({ screenshot: true }, true)
    if (world.attachments !== undefined) world.attachments.refusal = new Error('disk is gone')
    const result = await world.run({ option: BAR }, (callId) => {
      world.pending.report({
        callId,
        verdict: { ok: true, seriesCount: 1, pointCount: 3 },
        dataUrl: PNG_DATA_URL,
      })
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Error: disk is gone')
  })

  it('drops a capture that is not a PNG data URL', async () => {
    const world = await bench({ screenshot: true }, true)
    const result = await world.run({ option: BAR }, (callId) => {
      world.pending.report({
        callId,
        verdict: { ok: true, seriesCount: 1, pointCount: 3 },
        dataUrl: 'https://example.invalid/chart.png',
      })
    })
    expect(result.content).toEqual([{ type: 'text', text: 'Rendered: chart — 1 series, 3 points' }])
    expect(world.attachments?.saved).toEqual([])
  })

  it('drops a capture whose payload is empty', async () => {
    const world = await bench({ screenshot: true }, true)
    const result = await world.run({ option: BAR }, (callId) => {
      world.pending.report({
        callId,
        verdict: { ok: true, seriesCount: 1, pointCount: 3 },
        dataUrl: 'data:image/png;base64,',
      })
    })
    expect(result.content).toEqual([{ type: 'text', text: 'Rendered: chart — 1 series, 3 points' }])
    expect(world.attachments?.saved).toEqual([])
  })

  it('stores nothing while the deployment leaves screenshots off', async () => {
    const world = await bench({ screenshot: false }, true)
    const result = await world.run({ option: BAR }, (callId) => {
      // Even a client that sent one anyway: the switch is the host's.
      world.pending.report({
        callId,
        verdict: { ok: true, seriesCount: 1, pointCount: 3 },
        dataUrl: PNG_DATA_URL,
      })
    })
    expect(result.content).toEqual([{ type: 'text', text: 'Rendered: chart — 1 series, 3 points' }])
    expect(world.attachments?.saved).toEqual([])
  })

  it('keeps the verdict when screenshots are on and no store is mounted', async () => {
    const world = await bench({ screenshot: true })
    const result = await world.run({ option: BAR }, (callId) => {
      world.pending.report({
        callId,
        verdict: { ok: true, seriesCount: 1, pointCount: 3 },
        dataUrl: PNG_DATA_URL,
      })
    })
    expect(result.content).toEqual([{ type: 'text', text: 'Rendered: chart — 1 series, 3 points' }])
  })
})

describe('show_chart presentation', () => {
  it('titles the pending card with the tool name and the caption', async () => {
    const { definition } = await bench()
    expect(definition.presentCall?.({ title: 'Weekly revenue', option: BAR })).toEqual({
      card: 'generic',
      title: 'show_chart Weekly revenue',
      kind: 'other',
    })
    expect(definition.presentCall?.({ option: BAR })).toEqual({
      card: 'generic',
      title: 'show_chart chart',
      kind: 'other',
    })
  })

  it('titles the settled card with the verdict line', async () => {
    const { definition } = await bench()
    const result = { content: [{ type: 'text' as const, text: 'Rendered: chart — 1 series, 3 points' }], isError: false }
    expect(definition.presentResult?.({ option: BAR }, result)).toEqual({
      card: 'generic',
      title: 'Rendered: chart — 1 series, 3 points',
    })
    expect(definition.presentResult?.({ option: BAR }, { content: [], isError: false })).toEqual({
      card: 'generic',
      title: 'chart',
    })
  })

  it('lets two charts in one step wait side by side', async () => {
    const { definition } = await bench()
    expect(definition.isConcurrencySafe?.({ option: BAR })).toBe(true)
  })
})

describe('show_chart cancellation', () => {
  it('answers unverified when the caller aborts before the browser does', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const pending = new PendingCharts()
    // A deadline long enough that only the abort can end the wait.
    ctx.tools.register(showChartTool(ctx, { ...POLICY, verdictTimeoutMs: 30_000 }, pending))
    const controller = new AbortController()
    const settled = ctx.tools.execute({
      callId: `call-${++calls}` as ToolExecutionInput['callId'],
      name: 'show_chart',
      arguments: { option: BAR },
      signal: controller.signal,
    })
    await Promise.resolve()
    await Promise.resolve()
    controller.abort(new Error('caller went away'))
    await expect(settled).resolves.toBeDefined()
  })

  it('answers unverified immediately for a wait that starts already aborted', async () => {
    const pending = new PendingCharts()
    const aborted = AbortSignal.abort(new Error('gone'))
    await expect(pending.settle('call-x', 30_000, aborted)).resolves.toBeUndefined()
  })

  it('takes no report once a wait has ended', async () => {
    const pending = new PendingCharts()
    await pending.settle('call-y', 1, new AbortController().signal)
    expect(pending.report({ callId: 'call-y', verdict: { ok: true, seriesCount: 1, pointCount: 1 } })).toBe(false)
  })
})

describe('show_chart output rendering', () => {
  it('renders the stored capture beside its verdict line', async () => {
    const { definition } = await bench()
    const rendered = definition.output.render({ option: BAR }, {
      status: 'rendered',
      text: 'Rendered: chart — 1 series, 3 points',
      image: { attachmentId: 'sha256-x', mediaType: 'image/png', bytes: 12, width: 2, height: 2 },
    })
    expect(rendered).toEqual([
      { type: 'text', text: 'Rendered: chart — 1 series, 3 points' },
      {
        type: 'image',
        attachment: { attachmentId: 'sha256-x', mediaType: 'image/png', bytes: 12, width: 2, height: 2 },
      },
    ])
  })
})
