/**
 * The return channel's host half: what the seat may say, what the host does
 * with it, and what the agent is told.
 *
 * Two things are pinned here that a later change would otherwise take away
 * quietly. Every word the notice carries is read out of the catalog and out of
 * the entry's own logged spec, so a seat that lied about its labels could not
 * put words in the user's mouth; and the wake budget is refilled by human input
 * only, so a session's fourth press does not degrade to silence forever.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { emitAgentEvent, Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import { CallId } from '@deepseek-ai/dsh-llm/brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ContentSurfaceRegistry from '@deepseek-ai/dsh-experimental-content-surface'
import type { ContentSurfaceExtractor } from '@deepseek-ai/dsh-experimental-content-surface'
import { actionMemory, componentActionCommand, deliverAction } from '../src/command.ts'
import {
  catalogAction,
  catalogEntry,
  COMPONENT_ACTION_COMMAND,
  COMPONENT_ACTION_PLUGIN,
  COMPONENT_KIND,
  CONFIRM_BAR_ID,
  CONFIRM_BAR_PRESS_ID,
  formatComponentActionLine,
  FILTER_BAR_ID,
  FILTER_CHANGE_ID,
  FILTER_SUBMIT_ID,
  MAX_ACTION_PAYLOAD_BYTES,
  MAX_FILTER_CONDITIONS,
  MAX_TABLE_ROWS,
  parseComponentActionLine,
  readComponentAction,
  TABLE_ID,
  TABLE_OPERATION_ID,
  TABLE_ROW_CLICK_ID,
  TABLE_SELECT_ID,
  TABLE_SORT_ID,
  WAKE_BUDGET,
  type ComponentAction,
} from '../src/component-call.ts'
import * as ShowComponent from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

const signal = new AbortController().signal

/** The bar one entry draws through this suite: two buttons, both named in Chinese. */
const SPEC = {
  nodes: [{
    id: 'bar',
    component: CONFIRM_BAR_ID,
    props: {
      message: '这条记录会被删掉。',
      buttons: [{ id: 'delete', label: '删除', tone: 'danger' }, { id: 'keep', label: '保留' }],
    },
  }],
}

/** The action a press of that bar's first button reports. */
const PRESS: ComponentAction = {
  entryId: 'budget',
  componentId: CONFIRM_BAR_ID,
  actionId: CONFIRM_BAR_PRESS_ID,
  nodeId: 'bar',
  payload: { buttonId: 'delete' },
}

/** What the agent is told a press was, verbatim. */
const PRESS_TEXT = 'The user pressed "删除" in content panel entry "budget" ("确认删除"), on the 确认条 block "bar".'

/** What the user reads on the collapsed transcript row, verbatim. */
const PRESS_SUMMARY = '用户在「确认删除」里点了「删除」'

/** What a press that only reached the inbox is answered with, verbatim. */
const ACTION_QUEUED = '已记下，你下次发消息时对话会看到。'

/** What a gesture carrying more than its action accepts is answered with, verbatim. */
const ACTION_TOO_LARGE = '内容太多了，少选几项或写短一些再试。'

/** What a gesture that reached nobody is answered with, verbatim. */
const ACTION_NOT_RECORDED = '这个动作没能记下来。'

/**
 * A composition carrying the tool, the entry stream, the command registry, and
 * this row.
 * @param ghost - a record a second `component` producer folds in over the
 *   `budget` entry, standing in for a persisted checkpoint this build cannot
 *   read; omitted for the ordinary composition.
 * @returns the loaded context.
 */
async function setup(ghost?: { data: unknown }): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ContentSurfaceRegistry)
  await ctx.plugin(ShowComponent)
  if (ghost !== undefined) {
    // A second extractor claiming one kind is composable — the package's own
    // invariant companion exists for exactly this — and it is the reachable
    // way a `component` record carries data this build's reader refuses.
    const rogue: ContentSurfaceExtractor<unknown> = {
      kind: COMPONENT_KIND,
      dataVersion: 1,
      // Over an entry an accepted call already recorded, so the row's own
      // invariant — no entry without a call — still holds while its data does not.
      read: event => (event.type === 'command/run' ? { entryId: 'budget', data: ghost.data } : undefined),
      resolve: () => ({ title: '确认删除', payload: undefined }),
    }
    ctx.contentSurface.register(rogue)
  }
  return ctx
}

/** One session on the loaded composition. */
function newSession(ctx: Context): Session {
  return (ctx.get('sessions') as unknown as SessionStore).create()
}

/**
 * A fake agent over a real session and a real {@link Inbox}: the command
 * registry needs an agent, what this suite asserts is which delivery method the
 * handler reached for, and the one thing it must not fake is the inbox — a
 * superseded notice is replaced only while the inbox still holds it, which is
 * `Inbox.replace`'s answer and nothing this file could stand in for.
 *
 * Both delivery methods route through that inbox exactly as the live agent's
 * do, so a spy handed here counts the deliveries that appended a notice and not
 * the ones that rewrote a notice already pending.
 */
function fakeAgent(
  ctx: Context,
  session: Session,
  delivery: {
    inject?: (message: UserMessage) => void
    followup?: (message: UserMessage) => void
    status?: 'idle' | 'running'
  } = {},
): Agent {
  const scopeFiber = ctx.plugin(() => {})
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  const agent = {
    id: session.id,
    ctx: scopeFiber.ctx,
    session,
    inbox,
    inject: (message: UserMessage): void => {
      inbox.splice('next-step', Infinity, 0, [message])
      delivery.inject?.(message)
    },
    followup: (message: UserMessage): void => {
      inbox.splice('next-turn', Infinity, 0, [message])
      delivery.followup?.(message)
    },
    status: delivery.status ?? 'idle',
  } as unknown as Agent
  ctx.agents.register(agent)
  return agent
}

/**
 * Record one accepted `show_component` call, which is what makes the entry.
 * @param session - the session the call is logged into.
 * @param id - the entry the call owns.
 * @param title - the line the user reads.
 * @param spec - what the call places; the confirmation bar unless stated.
 */
function show(session: Session, id: string, title: string, spec: unknown = SPEC): void {
  session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: CallId(`call-${id}`),
    name: 'show_component',
    arguments: JSON.stringify({ id, title, spec }),
  })
}

/** Run one action line through the real command registry. */
async function run(ctx: Context, agent: Agent, line: string): Promise<{ kind: string; text?: string }> {
  const execution = await ctx.commands.execute(agent, line, [], signal)
  if (execution === undefined) throw new Error(`the composition offers no ${line.split(' ')[0]}`)
  return execution.result
}

describe('the action document', () => {
  it('writes and reads back one whole action', () => {
    const line = formatComponentActionLine(PRESS)
    expect(line).toBe(`/${COMPONENT_ACTION_COMMAND} {"entryId":"budget","componentId":"el.confirm-bar","actionId":"press","nodeId":"bar","payload":{"buttonId":"delete"}}`)
    expect(parseComponentActionLine(line.slice(`/${COMPONENT_ACTION_COMMAND} `.length))).toEqual(PRESS)
  })

  it('reads nothing out of a line that is not one action document', () => {
    expect(parseComponentActionLine('not json')).toBeUndefined()
    expect(readComponentAction(null)).toBeUndefined()
    expect(readComponentAction([PRESS])).toBeUndefined()
    expect(readComponentAction('press')).toBeUndefined()
    expect(readComponentAction({ ...PRESS, nodeId: 7 })).toBeUndefined()
    expect(readComponentAction({ ...PRESS, payload: 'delete' })).toBeUndefined()
    expect(readComponentAction({ ...PRESS, payload: null })).toBeUndefined()
  })

  it('reads nothing out of a document carrying a property it does not know', () => {
    // The same rule the payload is held to, one level up: an extra top-level
    // property is refused whole rather than dropped on the way through.
    expect(readComponentAction({ ...PRESS, componentLabel: '确认条' })).toBeUndefined()
    expect(parseComponentActionLine(JSON.stringify({ ...PRESS, componentLabel: '确认条' }))).toBeUndefined()
  })
})

describe('the catalog of actions', () => {
  it('declares the press the confirmation bar reports, and nothing else', () => {
    const bar = catalogEntry(CONFIRM_BAR_ID)
    expect(bar?.actions.map(action => [action.id, action.report])).toEqual([[CONFIRM_BAR_PRESS_ID, 'wake']])
    expect(Object.keys(bar?.actions[0]?.payloadSchema ?? {})).toEqual(['buttonId'])
  })

  it('knows no action a component does not declare', () => {
    const bar = catalogEntry(CONFIRM_BAR_ID)
    expect(bar !== undefined && catalogAction(bar, 'submit')).toBeUndefined()
  })
})

describe('delivering one resolved action', () => {
  const notice = { text: PRESS_TEXT, summary: PRESS_SUMMARY }

  /** Which block's which gesture, as the resolved identifiers spell it. */
  const KEY = JSON.stringify(['budget', 'bar', CONFIRM_BAR_PRESS_ID])

  it('tells the agent nothing about a silent action, and says nothing landed', async () => {
    const ctx = await setup()
    const inject = vi.fn()
    const followup = vi.fn()
    const landed = deliverAction(fakeAgent(ctx, newSession(ctx), { inject, followup }), actionMemory(), { notice, report: 'silent', key: KEY })
    expect(landed).toBe('none')
    expect(inject).not.toHaveBeenCalled()
    expect(followup).not.toHaveBeenCalled()
  })

  it('stages a context action without opening a turn, and reports it as the delivery it asked for', async () => {
    const ctx = await setup()
    const inject = vi.fn()
    const followup = vi.fn()
    // Not `queued`: nobody is waiting on an answer to it, so the handler owes
    // the person who made the gesture no sentence about where it went.
    const landed = deliverAction(fakeAgent(ctx, newSession(ctx), { inject, followup }), actionMemory(), { notice, report: 'context', key: KEY })
    expect(landed).toBe('context')
    expect(followup).not.toHaveBeenCalled()
    expect(inject).toHaveBeenCalledTimes(1)
    const message = inject.mock.calls[0]?.[0] as UserMessage
    expect(message.content).toEqual([{ type: 'text', text: PRESS_TEXT }])
    expect(message.source).toEqual({
      kind: 'plugin',
      plugin: COMPONENT_ACTION_PLUGIN,
      form: 'notice',
      summary: PRESS_SUMMARY,
    })
  })

  it('wakes an idle agent, and stages the same notice into a busy one', async () => {
    const ctx = await setup()
    const idleFollowup = vi.fn()
    const opened = deliverAction(fakeAgent(ctx, newSession(ctx), { followup: idleFollowup }), actionMemory(), { notice, report: 'wake', key: KEY })
    expect(opened).toBe('opened')
    expect(idleFollowup).toHaveBeenCalledTimes(1)

    const busyInject = vi.fn()
    const busyFollowup = vi.fn()
    const busy = fakeAgent(ctx, newSession(ctx), { inject: busyInject, followup: busyFollowup, status: 'running' })
    // The declared grade is still `wake`; where it landed is not, which is the
    // whole reason the delivery is reported rather than the grade.
    expect(deliverAction(busy, actionMemory(), { notice, report: 'wake', key: KEY })).toBe('queued')
    expect(busyFollowup).not.toHaveBeenCalled()
    expect(busyInject).toHaveBeenCalledTimes(1)
  })

  it('queues every wake that missed its turn, one notice each', async () => {
    const ctx = await setup()
    const memory = actionMemory()
    const busy = fakeAgent(ctx, newSession(ctx), { status: 'running' })
    // A wake is the user answering something the agent stopped for, so two of
    // them are two answers: only the working gestures are superseded.
    expect(deliverAction(busy, memory, { notice, report: 'wake', key: KEY })).toBe('queued')
    expect(deliverAction(busy, memory, { notice, report: 'wake', key: KEY })).toBe('queued')
    expect(busy.inbox.nextStep).toHaveLength(2)
  })
})

describe('the /component-action command', () => {
  it('records the line verbatim and tells nobody about a malformed one', async () => {
    const ctx = await setup()
    const session = newSession(ctx)
    const inject = vi.fn()
    const followup = vi.fn()
    const agent = fakeAgent(ctx, session, { inject, followup })

    expect(await run(ctx, agent, `/${COMPONENT_ACTION_COMMAND} {"nope":1}`))
      .toEqual({ kind: 'error', text: ACTION_NOT_RECORDED })
    expect(inject).not.toHaveBeenCalled()
    expect(followup).not.toHaveBeenCalled()
    // The record is the command registry's, written before the handler ran:
    // this package appends no session event of its own in either direction.
    const run1 = session.events.find(event => event.type === 'command/run')
    expect(run1?.data).toMatchObject({ name: COMPONENT_ACTION_COMMAND, args: ' {"nope":1}' })
    expect(session.events.map(event => event.type)).toEqual(['command/run', 'command/done'])
  })

  it('refuses an action too large to carry, and still leaves it in the log', async () => {
    const ctx = await setup()
    const session = newSession(ctx)
    const followup = vi.fn()
    const agent = fakeAgent(ctx, session, { followup })
    show(session, 'budget', '确认删除')
    const oversized = formatComponentActionLine({ ...PRESS, payload: { buttonId: 'd'.repeat(MAX_ACTION_PAYLOAD_BYTES) } })

    expect(await run(ctx, agent, oversized)).toEqual({ kind: 'error', text: ACTION_TOO_LARGE })
    expect(followup).not.toHaveBeenCalled()
    expect(session.events.some(event => event.type === 'command/run')).toBe(true)
  })

  it('names the pressed button from the entry\'s own spec, and wakes the agent', async () => {
    const ctx = await setup()
    const session = newSession(ctx)
    const followup = vi.fn()
    const agent = fakeAgent(ctx, session, { followup })
    show(session, 'budget', '确认删除')

    expect(await run(ctx, agent, formatComponentActionLine(PRESS))).toEqual({ kind: 'success' })
    const message = followup.mock.calls[0]?.[0] as UserMessage
    expect(message.content).toEqual([{ type: 'text', text: PRESS_TEXT }])
    expect(message.source).toEqual({
      kind: 'plugin',
      plugin: COMPONENT_ACTION_PLUGIN,
      form: 'notice',
      summary: PRESS_SUMMARY,
    })
  })

  it('reports nothing for a gesture that names nothing on display', async () => {
    const ctx = await setup()
    const session = newSession(ctx)
    const inject = vi.fn()
    const followup = vi.fn()
    const agent = fakeAgent(ctx, session, { inject, followup })
    show(session, 'budget', '确认删除')
    const refused = [
      { ...PRESS, entryId: 'other' },
      { ...PRESS, nodeId: 'other' },
      // A component this deployment really has, reporting a gesture of a block
      // that draws another one: the identifiers are resolved against the entry's
      // own spec rather than believed.
      { ...PRESS, componentId: 'toy.table' },
      { ...PRESS, componentId: 'toy.chart' },
      { ...PRESS, actionId: 'submit' },
      { ...PRESS, payload: { buttonId: 'delete', buttonLabel: '删除' } },
      { ...PRESS, payload: { buttonId: 'never-drawn' } },
    ]
    for (const action of refused) {
      expect(await run(ctx, agent, formatComponentActionLine(action)))
        .toEqual({ kind: 'error', text: ACTION_NOT_RECORDED })
    }
    expect(inject).not.toHaveBeenCalled()
    expect(followup).not.toHaveBeenCalled()
  })

  it('reports nothing against an entry this build cannot read', async () => {
    const ctx = await setup({ data: null })
    const session = newSession(ctx)
    const followup = vi.fn()
    const agent = fakeAgent(ctx, session, { followup })
    show(session, 'budget', '确认删除')

    expect(await run(ctx, agent, formatComponentActionLine(PRESS)))
      .toEqual({ kind: 'error', text: ACTION_NOT_RECORDED })
    expect(followup).not.toHaveBeenCalled()
  })

  it('reports nothing against an entry whose stored spec this build refuses', async () => {
    const ctx = await setup({ data: { title: '确认删除', spec: { nodes: [] } } })
    const session = newSession(ctx)
    const followup = vi.fn()
    const agent = fakeAgent(ctx, session, { followup })
    show(session, 'budget', '确认删除')

    expect(await run(ctx, agent, formatComponentActionLine(PRESS)))
      .toEqual({ kind: 'error', text: ACTION_NOT_RECORDED })
    expect(followup).not.toHaveBeenCalled()
  })

  it('reports nothing where no entry stream is composed at all', async () => {
    const ctx = await setup()
    const session = newSession(ctx)
    const followup = vi.fn()
    const agent = fakeAgent(ctx, session, { followup })
    show(session, 'budget', '确认删除')
    // The command is absent from such a composition, so its handler is built
    // directly here: a projection registry carrying no entry stream must be a
    // refusal rather than a throw.
    const bare = new Context()
    contexts.push(bare)
    await bare.plugin(SessionProjectionRegistry)
    const standalone = componentActionCommand(bare, actionMemory())

    expect(standalone.handler({
      commandId: CommandId('cmd-1'),
      agent,
      rawInput: JSON.stringify(PRESS),
      attachments: [],
      signal,
    })).toEqual({ kind: 'error', text: ACTION_NOT_RECORDED })
    expect(followup).not.toHaveBeenCalled()
  })
})

describe('a table reporting back', () => {
  /** One table entry: two rows and one custom operation. */
  const TABLE_SPEC = {
    nodes: [{
      id: 'grid',
      component: TABLE_ID,
      props: {
        tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label', alias: '名称' }] },
        displayValueList: [{ zh_label: 'A-1' }, { zh_label: 'A-2' }],
        customOperations: [{ key: 'export', label: '导出' }],
      },
    }],
  }

  /** One action reported out of that table. */
  function gesture(actionId: string, payload: Record<string, unknown>): ComponentAction {
    return { entryId: 'devices', componentId: TABLE_ID, actionId, nodeId: 'grid', payload }
  }

  it('opens a turn for a pressed operation, and stages a change of selection', async () => {
    const ctx = await setup()
    const session = newSession(ctx)
    const inject = vi.fn()
    const followup = vi.fn()
    const agent = fakeAgent(ctx, session, { inject, followup })
    show(session, 'devices', '设备列表', TABLE_SPEC)

    expect(await run(ctx, agent, formatComponentActionLine(gesture(TABLE_OPERATION_ID, { opId: 'export', rowIndex: 1 }))))
      .toEqual({ kind: 'success' })
    expect((followup.mock.calls[0]?.[0] as UserMessage).content).toEqual([{
      type: 'text',
      text: 'The user pressed "导出" on row "A-2" in content panel entry "devices" ("设备列表"), on the 数据表 block "grid".',
    }])

    // A selection is news the agent should have at its next step, not an answer
    // it stopped for: it waits in the inbox, and it is answered with no
    // sentence at all, because a receipt for it would put a line in the
    // conversation for every row the user ticks.
    expect(await run(ctx, agent, formatComponentActionLine(gesture(TABLE_SELECT_ID, { rowIndexes: [0] }))))
      .toEqual({ kind: 'success' })
    expect(inject).toHaveBeenCalledTimes(1)
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('leaves one unclaimed notice for a block ticked three times, and never rewrites a claimed one', async () => {
    const ctx = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(ctx, session)
    show(session, 'devices', '设备列表', TABLE_SPEC)

    for (const rowIndexes of [[0], [], [0, 1]]) {
      expect(await run(ctx, agent, formatComponentActionLine(gesture(TABLE_SELECT_ID, { rowIndexes }))))
        .toEqual({ kind: 'success' })
    }
    // What the user has selected is one fact, not three, and the inbox has no
    // ceiling of its own: the two earlier notices were replaced rather than
    // queued beside this one, which is also why the survivor is the latest.
    expect(agent.inbox.nextStep).toHaveLength(1)
    expect(agent.inbox.nextStep[0]?.content).toEqual([{
      type: 'text',
      text: 'The user selected 2 rows in content panel entry "devices" ("设备列表"), on the 数据表 block "grid": "A-1", "A-2".',
    }])

    // A gesture of its own keeps its own place: the key is the block and the
    // action together, so an opened row does not overwrite a selection.
    expect(await run(ctx, agent, formatComponentActionLine(gesture(TABLE_ROW_CLICK_ID, { rowIndex: 1 }))))
      .toEqual({ kind: 'success' })
    expect(agent.inbox.nextStep).toHaveLength(2)

    // Claiming is what the model reading a notice looks like from here — the
    // loop's own step-boundary read. A notice the model has already been given
    // is not something a later tick may rewrite, so the tick after it appends.
    const claimed = agent.inbox.claim('next-step', 1)
    expect(claimed).toHaveLength(2)
    expect(await run(ctx, agent, formatComponentActionLine(gesture(TABLE_SELECT_ID, { rowIndexes: [1] }))))
      .toEqual({ kind: 'success' })
    expect(agent.inbox.nextStep).toHaveLength(1)
    expect(claimed[0]?.content).toEqual([{
      type: 'text',
      text: 'The user selected 2 rows in content panel entry "devices" ("设备列表"), on the 数据表 block "grid": "A-1", "A-2".',
    }])
  })

  it('tells the agent nothing at all about a sort', async () => {
    const ctx = await setup()
    const session = newSession(ctx)
    const inject = vi.fn()
    const followup = vi.fn()
    const agent = fakeAgent(ctx, session, { inject, followup })
    show(session, 'devices', '设备列表', TABLE_SPEC)

    expect(await run(ctx, agent, formatComponentActionLine(gesture(TABLE_SORT_ID, { prop: 'zh_label', order: 'asc' }))))
      .toEqual({ kind: 'success' })
    expect(inject).not.toHaveBeenCalled()
    expect(followup).not.toHaveBeenCalled()
  })

  it('reports nothing for a row the entry does not draw', async () => {
    const ctx = await setup()
    const session = newSession(ctx)
    const followup = vi.fn()
    const agent = fakeAgent(ctx, session, { followup })
    show(session, 'devices', '设备列表', TABLE_SPEC)

    expect(await run(ctx, agent, formatComponentActionLine(gesture(TABLE_OPERATION_ID, { opId: 'export', rowIndex: 7 }))))
      .toEqual({ kind: 'error', text: ACTION_NOT_RECORDED })
    expect(followup).not.toHaveBeenCalled()
  })

  it('carries a selection of every row a full table draws', async () => {
    const ctx = await setup()
    const session = newSession(ctx)
    const inject = vi.fn()
    const agent = fakeAgent(ctx, session, { inject })
    const rows = Array.from({ length: MAX_TABLE_ROWS }, (_unused, index) => ({ zh_label: `A-${index}` }))
    show(session, 'devices', '设备列表', {
      nodes: [{
        id: 'grid',
        component: TABLE_ID,
        props: {
          tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label', alias: '名称' }] },
          displayValueList: rows,
          selectMode: 'checkbox',
        },
      }],
    })
    // The header checkbox of a full table, which is the one gesture the two
    // row ceilings have to agree about: ticking every drawn row must reach the
    // agent rather than be answered as too much.
    const all = gesture(TABLE_SELECT_ID, { rowIndexes: rows.map((_unused, index) => index) })

    expect(await run(ctx, agent, formatComponentActionLine(all))).toEqual({ kind: 'success' })
    expect((inject.mock.calls[0]?.[0] as UserMessage).content).toEqual([{
      type: 'text',
      text: `The user selected ${MAX_TABLE_ROWS} rows in content panel entry "devices" ("设备列表"), on the 数据表 block "grid": `
        + '"A-0", "A-1", "A-2", "A-3", "A-4" and 495 more.',
    }])
  })

  it('says there is too much where a selection carries more rows than any table draws', async () => {
    const ctx = await setup()
    const session = newSession(ctx)
    const inject = vi.fn()
    const agent = fakeAgent(ctx, session, { inject })
    show(session, 'devices', '设备列表', TABLE_SPEC)
    const past = gesture(TABLE_SELECT_ID, { rowIndexes: Array.from({ length: MAX_TABLE_ROWS + 1 }, () => 0) })

    expect(await run(ctx, agent, formatComponentActionLine(past))).toEqual({ kind: 'error', text: ACTION_TOO_LARGE })
    expect(inject).not.toHaveBeenCalled()
  })
})

describe('a filter bar reporting back', () => {
  /** One filter entry: two attributes and the two strategies the call narrowed to. */
  const FILTER_SPEC = {
    nodes: [{
      id: 'query',
      component: FILTER_BAR_ID,
      props: {
        relatedMeta: 'device',
        metaConfig: {
          attributes: [
            { attributeEnName: 'zh_label', alias: '名称' },
            { attributeEnName: 'state', alias: '状态' },
          ],
        },
        attrEqEnums: [{ value: 'EQ', label: '等于' }],
      },
    }],
  }

  /** One action reported out of that bar. */
  function gesture(actionId: string, payload: Record<string, unknown>): ComponentAction {
    return { entryId: 'devices', componentId: FILTER_BAR_ID, actionId, nodeId: 'query', payload }
  }

  it('keeps taking edits past the count a submitted filter carries', async () => {
    const ctx = await setup()
    const session = newSession(ctx)
    const inject = vi.fn()
    const followup = vi.fn()
    const agent = fakeAgent(ctx, session, { inject, followup })
    show(session, 'devices', '设备列表', FILTER_SPEC)
    // The condition editor adds rows without limit and reports every committed
    // edit on its own, so an edit standing past the submit ceiling is an
    // ordinary silent report rather than a refusal the user never asked for.
    const editing = gesture(FILTER_CHANGE_ID, { count: MAX_FILTER_CONDITIONS + 1 })

    expect(await run(ctx, agent, formatComponentActionLine(editing))).toEqual({ kind: 'success' })
    expect(inject).not.toHaveBeenCalled()
    expect(followup).not.toHaveBeenCalled()
  })

  it('says there is too much where a submitted filter carries more conditions than it may', async () => {
    const ctx = await setup()
    const session = newSession(ctx)
    const followup = vi.fn()
    const agent = fakeAgent(ctx, session, { followup })
    show(session, 'devices', '设备列表', FILTER_SPEC)
    const conditions = Array.from({ length: MAX_FILTER_CONDITIONS + 1 }, () => ({ key: 'state', op: 'EQ', value: '在用' }))

    expect(await run(ctx, agent, formatComponentActionLine(gesture(FILTER_SUBMIT_ID, { conditions }))))
      .toEqual({ kind: 'error', text: ACTION_TOO_LARGE })
    expect(followup).not.toHaveBeenCalled()
  })
})

describe('the wake budget', () => {
  it('degrades to quiet context once the budget is spent, and is refilled by the user', async () => {
    const ctx = await setup()
    const session = newSession(ctx)
    const inject = vi.fn()
    const followup = vi.fn()
    const agent = fakeAgent(ctx, session, { inject, followup })
    show(session, 'budget', '确认删除')
    const line = formatComponentActionLine(PRESS)

    for (let press = 0; press < WAKE_BUDGET; press += 1) {
      expect(await run(ctx, agent, line)).toEqual({ kind: 'success' })
    }
    // The press past the budget is the one a user would otherwise wait on: it
    // is answered with the sentence saying the agent will read it next time.
    expect(await run(ctx, agent, line)).toEqual({ kind: 'success', text: ACTION_QUEUED })
    expect(followup).toHaveBeenCalledTimes(WAKE_BUDGET)
    expect(inject).toHaveBeenCalledTimes(1)

    // A notice this package itself queued must not refill the budget it spent.
    emitAgentEvent(ctx, agent, 'agent/inbox/claimed', {
      message: createUserMessage({
        content: [{ type: 'text', text: PRESS_TEXT }],
        source: { kind: 'plugin', plugin: COMPONENT_ACTION_PLUGIN, form: 'notice', summary: PRESS_SUMMARY },
      }),
      turn: 1,
    })
    await run(ctx, agent, line)
    expect(followup).toHaveBeenCalledTimes(WAKE_BUDGET)
    expect(inject).toHaveBeenCalledTimes(2)

    emitAgentEvent(ctx, agent, 'agent/inbox/claimed', {
      message: createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }),
      turn: 2,
    })
    await run(ctx, agent, line)
    expect(followup).toHaveBeenCalledTimes(WAKE_BUDGET + 1)
    expect(inject).toHaveBeenCalledTimes(2)
  })
})
