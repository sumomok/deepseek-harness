/**
 * `read_component` against the real tool runtime: its model-visible surface
 * (name, description, parameters, output schema, cards) and every ending a
 * call has — a reading that came back, a console that refused to read, a report
 * that answers some other tool's call, a claim that never came, a claimed call
 * that went quiet, and the runtime cancelling the wait.
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
import type { CallSettlement, CallTable, CallTimeouts } from '@deepseek-ai/dsh-experimental-content-frame/src/access/pending.ts'
import type { ActOutcome, ChannelOutcome, ComponentReadOutcome, ReadOutcome } from '@deepseek-ai/dsh-experimental-content-frame/src/access/wire.ts'
import { MAX_ENTRY_ID_LENGTH } from '../src/component-call.ts'
import { READ_COMPONENT_TOOL_NAME } from '../src/read-component-call.ts'
import { unclaimedRefusal, unverifiedRefusal } from '../src/read-component-text.ts'
import { readComponentTool } from '../src/read-component-tool.ts'

/** The deadlines every case here opens its wait with. */
const TIMEOUTS: CallTimeouts = { claimTimeoutMs: 5000, answerTimeoutMs: 15000, pinMs: 30_000 }

/** The entry id every accepted call names. */
const ENTRY = 'demo'

/** One accepted call's arguments. */
const ARGS = { entry: ENTRY, node: 'toolbar' }

/** The reading a console that read the entry posts. */
const READ: ComponentReadOutcome = {
  status: 'read',
  page: { id: ENTRY, title: 'Demo' },
  text: 'Read the component entry "Demo" (demo).\nBlocks: toolbar.\nControls: none.\nFields: none.\nNo dialog is open.',
}

/** What a reading looks like through the tool's own value. */
const READ_VALUE = {
  status: 'done',
  entry: { id: ENTRY, title: 'Demo' },
  text: READ.text,
}

/** A report of steps that ran, which is no answer to this call. */
const ACT: ActOutcome = {
  status: 'done',
  page: { id: ENTRY, title: 'Demo' },
  title: 'Demo',
  steps: [{ index: 1, status: 'ok' }],
  text: 'Acted.',
  truncated: false,
}

/** A page read's outcome, which is no answer to this call either. */
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
async function bench(settlement: CallSettlement): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const open = vi.fn((): Promise<CallSettlement> => Promise.resolve(settlement))
  const table: CallTable = { open, sessionOf: () => undefined }
  const definition = readComponentTool(table, TIMEOUTS)
  ctx.tools.register(definition)
  const session = Session.create(SessionId('read-component-tool'))
  return {
    definition,
    calls: { open },
    run: args => ctx.tools.execute({
      callId: `call-${++calls}` as ToolCallId,
      name: READ_COMPONENT_TOOL_NAME,
      arguments: args,
      agent: { id: session.id, session } as NonNullable<ToolExecutionInput['agent']>,
      signal: new AbortController().signal,
    }),
  }
}

/** Run one call with no owning session at all. */
async function runWithoutAgent(args: unknown): Promise<ToolExecutionResult> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const table: CallTable = {
    open: vi.fn((): Promise<CallSettlement> => Promise.resolve({ kind: 'unclaimed' })),
    sessionOf: () => undefined,
  }
  ctx.tools.register(readComponentTool(table, TIMEOUTS))
  return ctx.tools.execute({
    callId: 'call-no-agent' as ToolCallId,
    name: READ_COMPONENT_TOOL_NAME,
    arguments: args,
    signal: new AbortController().signal,
  })
}

describe('the read_component offer', () => {
  it('names the tool and carries its own two parameters', async () => {
    const { definition } = await bench({ kind: 'unclaimed' })
    expect(definition.name).toBe(READ_COMPONENT_TOOL_NAME)
    expect(definition.description).toContain('Read what the component entry the user is looking at')
    expect(definition.parameters).toMatchObject({
      type: 'object',
      required: ['entry'],
      properties: {
        entry: { type: 'string' },
        node: { type: 'string' },
      },
    })
  })

  it('declares the output schema the answer is read against', async () => {
    const { definition } = await bench({ kind: 'unclaimed' })
    expect(definition.output?.schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['status', 'text'],
      properties: {
        status: { type: 'string', enum: ['done', 'unverified'] },
        entry: { type: 'object', additionalProperties: false, required: ['id', 'title'] },
        text: { type: 'string' },
      },
    })
  })

  it('runs beside another call, because a read writes nothing and only waits', async () => {
    const { definition } = await bench({ kind: 'unclaimed' })
    expect(definition.isConcurrencySafe?.(ARGS)).toBe(true)
  })

  it('describes the pending card from the parsed call, and truncates raw arguments it cannot read', async () => {
    const { definition } = await bench({ kind: 'unclaimed' })
    expect(definition.presentCall?.(ARGS) as GenericCallView | undefined).toEqual({
      card: 'generic',
      title: 'Read the component entry in the content panel',
      kind: 'other',
      rawInput: 'demo: toolbar',
    })
    expect((definition.presentCall?.({ entry: ENTRY }) as GenericCallView | undefined)?.rawInput).toBe(ENTRY)
    const long = definition.presentCall?.({ entry: '', node: 'a'.repeat(400) }) as GenericCallView | undefined
    expect(long?.rawInput).toHaveLength(201)
    expect(String(long?.rawInput).endsWith('…')).toBe(true)
    const short = definition.presentCall?.({ entry: '', node: 'a b' }) as GenericCallView | undefined
    expect(short?.rawInput).toBe('{"entry":"","node":"a b"}')
    expect(definition.presentCall?.({ node: 'toolbar' })).toBeUndefined()
  })

  it('draws the settled card from the first line of the model-facing text', async () => {
    const { definition } = await bench({ kind: 'unclaimed' })
    const content = [{ type: 'text' as const, text: 'Read the component entry "Demo" (demo).\nBlocks: none.' }]
    expect(definition.presentResult?.(ARGS, { content, isError: false, value: null } as never))
      .toEqual({ card: 'generic', title: 'Read the component entry "Demo" (demo).' })
    expect(definition.presentResult?.(ARGS, { content: [], isError: false, value: null } as never))
      .toEqual({ card: 'generic', title: 'Read the component entry in the content panel' })
  })
})

describe('a call the tool refuses before any console is asked', () => {
  it('refuses an entry and a block this tool cannot read', async () => {
    const { run, calls: opened } = await bench({ kind: 'unclaimed' })
    const cases: [unknown, string][] = [
      [{ entry: '' }, 'entry must be the id of a component entry in the content panel.'],
      [{ entry: 'a'.repeat(MAX_ENTRY_ID_LENGTH + 1) }, 'entry must be the id of a component entry in the content panel.'],
      [{ entry: ENTRY, node: 'a b' }, 'node must be a block id of letters, digits, underscores and hyphens, as the placement wrote it.'],
      [{ entry: ENTRY, node: 'a'.repeat(65) }, 'node must be a block id of letters, digits, underscores and hyphens, as the placement wrote it.'],
    ]
    for (const [args, message] of cases) {
      const result = await run(args)
      expect({ args, isError: result.isError }).toEqual({ args, isError: true })
      if (result.isError) expect(result.error.message).toBe(message)
    }
    // None of them opened a wait, so no console was ever asked.
    expect(opened.open).not.toHaveBeenCalled()
    // The registered parameter schema refuses a call with no `entry` before the
    // body runs, which is the first of the two readings it would get.
    const missing = await run({ node: 'toolbar' })
    expect(missing.isError).toBe(true)
    if (missing.isError) expect(missing.error.message).toContain('missing required property "entry"')
  })

  it('refuses a call with no owning session, which has no column to read', async () => {
    const result = await runWithoutAgent(ARGS)
    expect(result.isError).toBe(true)
    if (result.isError) {
      expect(result.error.message).toBe('read_component needs a session: the entry it reads belongs to a session\'s content column.')
    }
  })
})

describe('what a settlement becomes', () => {
  it('answers with the reading a console reported, through the output schema', async () => {
    const { run, calls: opened } = await bench({ kind: 'reported', outcome: READ })
    const result = await run(ARGS)
    expect(opened.open).toHaveBeenCalledTimes(1)
    expect(result.isError).toBe(false)
    if (!result.isError) {
      expect(result.value).toEqual(READ_VALUE)
      expect(result.content).toEqual([{ type: 'text', text: READ.text }])
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
      if (result.isError) expect(result.error.message).toBe(`read_component did not read: ${message}`)
    }
  })

  it('refuses a report that answers with another tool\'s document', async () => {
    for (const outcome of [ACT, PAGE_READ] as ChannelOutcome[]) {
      const { run } = await bench({ kind: 'reported', outcome })
      const result = await run(ARGS)
      expect(result.isError).toBe(true)
      if (result.isError) {
        expect(result.error.message).toBe('The console answered a read_component call with something other than a reading.')
      }
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
        text: unverifiedRefusal(TIMEOUTS.answerTimeoutMs),
      })
    }
  })

  it('refuses a call the runtime cancelled while it waited', async () => {
    const { run } = await bench({ kind: 'aborted' })
    const result = await run(ARGS)
    expect(result.isError).toBe(true)
    if (result.isError) expect(result.error.message).toBe('The read_component call was cancelled.')
  })
})
