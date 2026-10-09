/**
 * `act_component` against the real tool runtime: its model-visible surface
 * (name, description, parameters, output schema, cards) and every ending a
 * call has — steps that ran, a console that refused to run any, a report that
 * answers some other call, a claim that never came, a claimed call that went
 * quiet, and the runtime cancelling the wait.
 *
 * The channel table is a stand-in here: what this file owns is what the tool
 * does with each settlement and what it refuses before one is opened. The chain
 * through the real channel, claim and report routes is
 * `act-component-chain.client.spec.tsx`.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolDefinition, ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { CallTable, CallTimeouts } from '@deepseek-ai/dsh-experimental-content-frame/src/access/pending.ts'
import type { ActOutcome, ChannelOutcome, ReadOutcome } from '@deepseek-ai/dsh-experimental-content-frame/src/access/wire.ts'
import { ACT_COMPONENT_TOOL_NAME, MAX_ACT_COMPONENT_STEPS } from '../src/act-component-call.ts'
import { tooManyStepsRefusal, unclaimedRefusal, unverifiedRefusal } from '../src/act-component-text.ts'
import { ACT_COMPONENT_BOUNDS, actComponentTool } from '../src/act-component-tool.ts'

/** The deadlines every case here opens its wait with. */
const TIMEOUTS: CallTimeouts = { claimTimeoutMs: 5000, answerTimeoutMs: 15000, pinMs: 30_000 }

/** The entry id every accepted call names. */
const ENTRY = 'demo'

/** One accepted call's arguments. */
const ARGS = { entry: ENTRY, steps: [{ action: 'click', key: 'add' }] }

/** The report a console that ran the steps posts. */
const DONE: ActOutcome = {
  status: 'done',
  page: { id: ENTRY, title: 'Demo' },
  title: 'Demo',
  steps: [{ index: 1, status: 'ok' }],
  text: 'Acted on the component entry "Demo" (demo).\n- click on "add": done',
  truncated: false,
}

/** What a report with steps that ran looks like through the tool's own value. */
const DONE_VALUE = {
  status: 'done',
  entry: { id: ENTRY, title: 'Demo' },
  steps: [{ index: 1, status: 'ok' }],
  text: DONE.text,
}

/** A page read's outcome, which is no answer to this call. */
const PAGE_READ: ReadOutcome = {
  status: 'ok',
  page: { id: ENTRY, title: 'Demo' },
  snapshot: { kind: 'outline', url: 'u', title: 't', text: '', truncated: false, shown: 0, total: 0, settled: true },
}

/** One booted deployment: the registered definition and a runner over the real registry. */
interface Bench {
  definition: ToolDefinition
  calls: { open: ReturnType<typeof vi.fn> }
  run: (args: unknown, withAgent?: boolean) => Promise<ToolExecutionResult>
}

let calls = 0

/**
 * Boot the tool over a real tool registry and a channel table that answers one
 * settlement.
 * @param settlement - what the table's `open` resolves to.
 * @returns the definition, the table, and a runner.
 */
async function bench(settlement: unknown): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const open = vi.fn(() => Promise.resolve(settlement))
  const table = { open, sessionOf: () => undefined } as unknown as CallTable
  const definition = actComponentTool(table, TIMEOUTS, MAX_ACT_COMPONENT_STEPS)
  ctx.tools.register(definition)
  const session = Session.create(SessionId('act-component-tool'))
  return {
    definition,
    calls: { open },
    run: args => ctx.tools.execute({
      callId: `call-${++calls}` as ToolCallId,
      name: ACT_COMPONENT_TOOL_NAME,
      arguments: args,
      agent: { id: session.id, session } as unknown as NonNullable<ToolExecutionInput['agent']>,
      signal: new AbortController().signal,
    }),
  }
}

/** Run one call with no owning session at all. */
async function runWithoutAgent(args: unknown): Promise<ToolExecutionResult> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const table = { open: vi.fn(), sessionOf: () => undefined } as unknown as CallTable
  ctx.tools.register(actComponentTool(table, TIMEOUTS, MAX_ACT_COMPONENT_STEPS))
  return ctx.tools.execute({
    callId: 'call-no-agent' as ToolCallId,
    name: ACT_COMPONENT_TOOL_NAME,
    arguments: args,
    signal: new AbortController().signal,
  })
}

describe('the act_component offer', () => {
  it('names the tool and carries the addressing vocabulary and the parameter schema', async () => {
    const { definition } = await bench({ kind: 'unclaimed' })
    expect(definition.name).toBe('act_component')
    expect(definition.description).toContain('Act inside the component entry the user is looking at')
    expect(definition.parameters).toMatchObject({
      type: 'object',
      required: ['entry', 'steps'],
      properties: {
        entry: { type: 'string' },
        steps: {
          type: 'array',
          items: {
            additionalProperties: false,
            required: ['action'],
            properties: {
              action: { type: 'string', enum: ['click', 'set', 'wait'] },
              node: { type: 'string' },
              key: { type: 'string' },
              name: { type: 'string' },
              value: { type: 'string' },
              timeoutMs: { type: 'integer' },
            },
          },
        },
      },
    })
  })

  it('declares the output schema the answer is read against', async () => {
    const { definition } = await bench({ kind: 'unclaimed' })
    expect(definition.output?.schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['status', 'steps', 'text'],
      properties: {
        status: { type: 'string', enum: ['done', 'failed', 'unverified'] },
        entry: { type: 'object', additionalProperties: false, required: ['id', 'title'] },
        steps: { type: 'array' },
        text: { type: 'string' },
      },
    })
    expect(ACT_COMPONENT_BOUNDS).toEqual({
      maxSteps: MAX_ACT_COMPONENT_STEPS,
      maxTargetChars: 64,
      maxValueChars: 4096,
      maxWaitMs: 10_000,
    })
  })

  it('runs one call of this tool at a time, because two would interleave in one entry', async () => {
    const { definition } = await bench({ kind: 'unclaimed' })
    expect(definition.isConcurrencySafe?.(ARGS)).toBe(false)
    // The runtime refuses an unreadable call before this row's own answer is
    // asked for, which is the same arm a concurrent one would take.
    expect(definition.isConcurrencySafe?.({})).toBe(false)
  })

  it('describes the pending card from the parsed call, and truncates raw arguments it cannot read', async () => {
    const { definition } = await bench({ kind: 'unclaimed' })
    expect(definition.presentCall?.(ARGS) as GenericCallView | undefined).toEqual({
      card: 'generic',
      title: 'Act inside the component in the content panel',
      kind: 'other',
      rawInput: 'demo: 1 step(s)',
    })
    // An entry the schema admits and this tool's own reading refuses is what
    // reaches the raw card: the presentation validates softly so that replaying
    // a call an older schema accepted still draws something.
    const long = definition.presentCall?.({ entry: '', steps: [{ action: 'click', key: 'a'.repeat(400) }] }) as GenericCallView | undefined
    expect(long?.rawInput).toHaveLength(201)
    expect(String(long?.rawInput).endsWith('…')).toBe(true)
    const short = definition.presentCall?.({ entry: '', steps: [{ action: 'click', key: 'add' }] }) as GenericCallView | undefined
    expect(short?.rawInput).toBe('{"entry":"","steps":[{"action":"click","key":"add"}]}')
    // The schema refuses it before this card is even asked for.
    expect(definition.presentCall?.({ steps: [] })).toBeUndefined()
  })

  it('draws the settled card from the first line of the model-facing text', async () => {
    const { definition } = await bench({ kind: 'unclaimed' })
    const content = [{ type: 'text' as const, text: 'Acted on the component entry "Demo" (demo).\n- click: done' }]
    expect(definition.presentResult?.(ARGS, { content, isError: false, value: null } as never))
      .toEqual({ card: 'generic', title: 'Acted on the component entry "Demo" (demo).' })
    expect(definition.presentResult?.(ARGS, { content: [], isError: false, value: null } as never))
      .toEqual({ card: 'generic', title: 'Act inside the component in the content panel' })
  })
})

describe('a call the tool refuses before any console is asked', () => {
  it('refuses an entry this tool cannot read, a call with no steps, and one past the ceiling', async () => {
    const { run, calls: opened } = await bench({ kind: 'unclaimed' })
    const cases: [unknown, string][] = [
      [{ entry: '', steps: ARGS.steps }, 'entry must be the id `show_component` placed the entry under.'],
      [{ entry: 'a'.repeat(65), steps: ARGS.steps }, 'entry must be the id `show_component` placed the entry under.'],
      [{ entry: ENTRY, steps: [] }, 'act_component needs at least one step.'],
      [
        { entry: ENTRY, steps: Array.from({ length: MAX_ACT_COMPONENT_STEPS + 1 }, () => ({ action: 'click', key: 'add' })) },
        tooManyStepsRefusal(MAX_ACT_COMPONENT_STEPS),
      ],
    ]
    for (const [args, message] of cases) {
      const result = await run(args)
      expect({ args, isError: result.isError }).toEqual({ args, isError: true })
      if (result.isError) expect(result.error.message).toBe(message)
    }
    // The registered parameter schema refuses a call with no `entry` before
    // the body runs, which is the first of the two readings it would get.
    const missing = await run({ steps: ARGS.steps })
    expect(missing.isError).toBe(true)
    if (missing.isError) expect(missing.error.message).toContain('missing required property "entry"')
    // `maxSteps` here is the protocol ceiling, so eight steps is the last set
    // that gets as far as a claim.
    const atCeiling = await run({
      entry: ENTRY,
      steps: Array.from({ length: MAX_ACT_COMPONENT_STEPS }, () => ({ action: 'click', key: 'add' })),
    })
    expect(opened.open).toHaveBeenCalledTimes(1)
    expect(atCeiling.isError).toBe(true)
  })

  it('names the step that is not one, and refuses the whole call for it', async () => {
    const { run } = await bench({ kind: 'unclaimed' })
    const result = await run({ entry: ENTRY, steps: [{ action: 'click', key: 'add' }, { action: 'wait' }] })
    expect(result.isError).toBe(true)
    if (result.isError) expect(result.error.message).toBe('step 2: a step must name `click`, `set`, or `wait`, with the block, key, name, or value that action takes, in the components\' own alphabet of letters, digits, underscores and hyphens.')
  })

  it('refuses a call with no owning session, which has no column to act on', async () => {
    const result = await runWithoutAgent(ARGS)
    expect(result.isError).toBe(true)
    if (result.isError) {
      expect(result.error.message).toBe('act_component needs a session: the entry it acts on belongs to a session\'s content column.')
    }
  })
})

describe('what a settlement becomes', () => {
  it('answers with the steps a console reported, through the output schema', async () => {
    const { run } = await bench({ kind: 'reported', outcome: DONE })
    const result = await run(ARGS)
    expect(result.isError).toBe(false)
    if (!result.isError) {
      expect(result.value).toEqual(DONE_VALUE)
      expect(result.content).toEqual([{ type: 'text', text: DONE.text }])
    }
  })

  it('carries the failing step\'s own sentence and marks the rest not run', async () => {
    const failed: ActOutcome = {
      ...DONE,
      status: 'failed',
      steps: [{ index: 1, status: 'failed', message: 'control "add" is not part of the entry on display.' }],
    }
    const { run } = await bench({ kind: 'reported', outcome: failed })
    const result = await run(ARGS)
    expect(result.isError).toBe(false)
    if (!result.isError) {
      expect(result.value).toMatchObject({
        status: 'failed',
        steps: [{ index: 1, status: 'failed', message: 'control "add" is not part of the entry on display.' }],
      })
    }
  })

  it('turns a console\'s refusal into the call\'s own rejection, keeping its sentence', async () => {
    for (const [code, message] of [
      ['empty', 'No component entry is in front, so there is nothing to act on.'],
      ['front-changed', 'The entry in front is "other", not the one this call named.'],
      ['engine', 'the engine threw'],
    ] as const) {
      const { run } = await bench({ kind: 'reported', outcome: { status: 'error', code, message } })
      const result = await run(ARGS)
      expect({ code, isError: result.isError }).toEqual({ code, isError: true })
      if (result.isError) expect(result.error.message).toBe(`act_component did not run: ${message}`)
    }
  })

  it('refuses a report that answers with something other than steps', async () => {
    const { run } = await bench({ kind: 'reported', outcome: PAGE_READ as ChannelOutcome })
    const result = await run(ARGS)
    expect(result.isError).toBe(true)
    if (result.isError) {
      expect(result.error.message).toBe('The console answered an act_component call with something other than its steps.')
    }
  })

  it('says no console claimed the call, with the deadline it waited', async () => {
    const { run } = await bench({ kind: 'unclaimed' })
    const result = await run(ARGS)
    expect(result.isError).toBe(true)
    if (result.isError) expect(result.error.message).toBe(unclaimedRefusal(TIMEOUTS.claimTimeoutMs))
  })

  it('answers unverified rather than failing when a claimed console went quiet', async () => {
    const { run } = await bench({ kind: 'unanswered' })
    const result = await run(ARGS)
    expect(result.isError).toBe(false)
    if (!result.isError) {
      expect(result.value).toEqual({
        status: 'unverified',
        steps: [],
        text: unverifiedRefusal(TIMEOUTS.answerTimeoutMs),
      })
    }
  })

  it('refuses a call the runtime cancelled while it waited', async () => {
    const { run } = await bench({ kind: 'aborted' })
    const result = await run(ARGS)
    expect(result.isError).toBe(true)
    if (result.isError) expect(result.error.message).toBe('The act_component call was cancelled.')
  })
})
