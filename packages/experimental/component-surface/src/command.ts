/**
 * `/component-action` — the one way anything the user does inside a drawn block
 * reaches the agent.
 *
 * The seat reports a gesture by running a command, and a command's input is
 * already a durable record: `command/run` carries the action document verbatim,
 * log-only, before this handler is entered. That is the whole reason this
 * package still appends no session event of its own — what the model is later
 * told is reconstructable from a record the command registry already wrote,
 * and the notice the handler builds is itself logged as the `user/message` the
 * loop writes when the agent claims it.
 *
 * The handler does four things and no more: read the document, resolve it
 * against the entry the log says is on display, build the two accounts of it
 * from the catalog and that entry's own spec, and deliver it at the grade the
 * action declares. It reaches no backend, calls no tool, and asks for no
 * approval — an approval cannot even be requested from here, because a command
 * handler can run with no turn open. What the model does in the turn a `wake`
 * opens goes through the ordinary tool path, gates included.
 *
 * Nothing the seat wrote is ever displayed as written. The pressed button's
 * name is read back out of the spec the model itself wrote, so a page that
 * lies about its own labels cannot put words in the user's mouth; the seat's
 * `componentId` and `nodeId` are identifiers checked against that spec rather
 * than text.
 *
 * What the handler answers with is the delivery, not the grade: a gesture that
 * only reached the inbox is answered with the one sentence saying so, because
 * a user told "sent to the conversation" while nothing is going to happen until
 * they write again is a user left waiting. That answer is durable too — it is
 * the `command/done` this command's own fold reads back (`action-state.ts`), so
 * a block that has been pressed keeps saying what became of the press after the
 * seat drawing it has been unmounted and drawn again.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/command
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: resolves ctx.sessionProjections, which the entry is read through.
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ContentSurfaceRecord } from '@deepseek-ai/dsh-experimental-content-surface/types'
import {
  catalogAction,
  catalogEntry,
  COMPONENT_ACTION_COMMAND,
  COMPONENT_ACTION_PLUGIN,
  COMPONENT_KIND,
  MAX_ACTION_PAYLOAD_BYTES,
  parseComponentActionLine,
  WAKE_BUDGET,
  type ActionReport,
  type ComponentAction,
  type ComponentActionNotice,
} from './component-call.ts'
import { componentActionsProjection } from './action-projection.ts'
import { readComponentSurfaceData } from './surface.ts'
import { acceptsActionPayload, validateComponentSpec } from './validate.ts'

/**
 * What a gesture that reaches nobody is answered with.
 *
 * One sentence for every unresolvable action, in the language and register the
 * end user reads: an unknown entry, a node that is not on screen, a button the
 * bar does not carry, and a payload the action does not declare are all the
 * same event from where the person is sitting — they clicked and nothing came
 * of it. The distinctions matter to the two halves of this package, which read
 * the same declarations and are wrong together or right together.
 */
const ACTION_NOT_RECORDED = '这个动作没能记下来。'

/** What an action too large to carry is answered with. */
const ACTION_TOO_LARGE = '选中的内容太多了，少选一些再试。'

/**
 * What a gesture that reached the agent's inbox rather than a turn is answered
 * with.
 *
 * The one delivery a user would otherwise wait on forever: the notice is
 * recorded and will be read, but nothing is going to happen until they write
 * again. The two deliveries that need no sentence say so by carrying none —
 * a turn is open, or the action declared that nothing should follow it.
 */
const ACTION_QUEUED = '已记下，你下次发消息时对话会看到。'

/** No entry stream is composed: the shared empty table every lookup then misses in. */
const NO_RECORDS: readonly ContentSurfaceRecord[] = Object.freeze([])

/** One resolved action: what to tell the agent, and how urgently. */
export interface ResolvedAction {
  /** The two accounts the catalog built. */
  readonly notice: ComponentActionNotice
  /** The grade the action declares. */
  readonly report: ActionReport
}

/**
 * Resolve one reported action against the entry the log says is on display.
 *
 * Every step is a lookup rather than a check on the seat's own text, which is
 * what makes the account trustworthy: an action survives only if the entry
 * exists, the node is one the entry draws, the component is the one that node
 * names, the action is one that component declares, and the payload is what
 * that action declares.
 * @param records - the session's folded content-surface records.
 * @param action - the reported action, as the command line carried it.
 * @returns the resolved action, or `undefined` when it names nothing on display.
 */
function resolveAction(
  records: readonly ContentSurfaceRecord[],
  action: ComponentAction,
): ResolvedAction | undefined {
  const record = records.find(one => one.kind === COMPONENT_KIND && one.entryId === action.entryId)
  if (record === undefined) return undefined
  // The record is a fold cell that a persisted checkpoint may have seeded, so
  // its declared type is a claim; the spec is re-judged rather than trusted,
  // and that judgement is what gives the node its accepted properties.
  const stored = readComponentSurfaceData(record.data)
  if (stored === undefined) return undefined
  const spec = validateComponentSpec(stored.spec)
  if (!spec.ok) return undefined
  const component = catalogEntry(action.componentId)
  if (component === undefined) return undefined
  const node = spec.spec.nodes.find(one => one.id === action.nodeId)
  if (node === undefined) return undefined
  /* v8 ignore start -- the catalog holds one component today, so a resolvable
     componentId cannot disagree with a validated node's own; the check is what
     keeps a seat from reporting one component's gesture as another's once the
     catalog holds more. */
  if (node.component !== component.id) return undefined
  /* v8 ignore stop */
  const definition = catalogAction(component, action.actionId)
  if (definition === undefined) return undefined
  if (!acceptsActionPayload(action.payload, definition.payloadSchema)) return undefined
  const notice = definition.describe({
    entryId: record.entryId,
    entryTitle: stored.title,
    node,
    component,
    payload: action.payload,
  })
  if (notice === undefined) return undefined
  return { notice, report: definition.report }
}

/**
 * Where one delivered action actually landed.
 *
 * Not the grade the catalog declared but what became of it, because the two
 * differ exactly where a user would otherwise be left waiting: a `wake` past
 * the budget, or one on an agent already working, is `queued`. The handler
 * turns this into what the person who pressed is told.
 */
export type ActionDelivery =
  /** The action declared that nothing should follow it; the agent was told nothing. */
  | 'none'
  /** A turn was opened for it and the agent will read it now. */
  | 'opened'
  /** It waits in the agent's inbox until something else claims a step. */
  | 'queued'

/**
 * Deliver one resolved action at the grade it declares.
 *
 * The three grades, and nothing between them. `silent` reaches the agent not at
 * all, so it costs no inbox entry and no budget. `context` waits in the
 * next-step inbox, which a running turn reads without a turn boundary of its
 * own. `wake` opens a turn while the agent is idle and within budget, because
 * an answer the agent stopped for is one it never hears if nothing claims it;
 * past the budget, and on an agent already working, it degrades to `context`.
 * @param agent - the agent whose seat reported the action.
 * @param spentWakes - turns each agent's actions have opened since it last claimed human input.
 * @param resolved - the accounts to deliver, and the grade to deliver them at.
 * @returns where the action landed, which is what the press is answered with.
 */
export function deliverAction(
  agent: Agent,
  spentWakes: WeakMap<Agent, number>,
  resolved: ResolvedAction,
): ActionDelivery {
  if (resolved.report === 'silent') return 'none'
  const message = createUserMessage({
    content: [{ type: 'text', text: resolved.notice.text }],
    source: {
      kind: 'plugin',
      plugin: COMPONENT_ACTION_PLUGIN,
      form: 'notice',
      summary: boundContextSummary(resolved.notice.summary),
    },
  })
  const spent = spentWakes.get(agent) ?? 0
  if (resolved.report === 'wake' && agent.status === 'idle' && spent < WAKE_BUDGET) {
    spentWakes.set(agent, spent + 1)
    agent.followup(message)
    return 'opened'
  }
  agent.inject(message)
  return 'queued'
}

/**
 * Build the `/component-action` command.
 *
 * The wake budget is passed in rather than owned here so that the refill
 * listener and the spending site share one table; {@link installComponentAction}
 * is what wires the pair together.
 * @param ctx - context carrying the projection registry the entry is resolved through.
 * @param spentWakes - turns each agent's actions have opened since it last claimed human input.
 * @returns the definition to hand to `ctx.commands.register`.
 */
export function componentActionCommand(ctx: Context, spentWakes: WeakMap<Agent, number>): CommandDefinition {
  return {
    name: COMPONENT_ACTION_COMMAND,
    // Chinese, and free of this package's vocabulary: the command registry has
    // no way to keep a row out of the slash menu, so this sentence is read by
    // an end user scrolling that menu, and by nobody else — `commands.list` is
    // a Remote method and reaches no model. What it has to say is that the row
    // is not an instruction they are meant to type.
    description: '内容面板里的按钮把按下结果送回对话，由页面自动发出。',
    input: { hint: '<json>' },
    handler: (invocation): CommandResult => {
      const rawInput = invocation.rawInput.trim()
      if (new TextEncoder().encode(rawInput).length > MAX_ACTION_PAYLOAD_BYTES) {
        return { kind: 'error', text: ACTION_TOO_LARGE }
      }
      const action = parseComponentActionLine(rawInput)
      if (action === undefined) return { kind: 'error', text: ACTION_NOT_RECORDED }
      const session: Session = invocation.agent.session
      const records = ctx.sessionProjections.stateOf(session, 'contentSurface') ?? NO_RECORDS
      const resolved = resolveAction(records, action)
      if (resolved === undefined) return { kind: 'error', text: ACTION_NOT_RECORDED }
      // The delivery, not the grade: a press that only reached the inbox is
      // answered with the sentence saying so, and the block that drew it shows
      // that sentence rather than claiming the conversation already has it.
      const delivery = deliverAction(invocation.agent, spentWakes, resolved)
      return delivery === 'queued' ? { kind: 'success', text: ACTION_QUEUED } : { kind: 'success' }
    },
  }
}

/**
 * Register the action command together with the wake budget's refill and the
 * fold that keeps a pressed block looking pressed.
 *
 * The refill is not optional decoration: without it an agent's budget is spent
 * once and never returned, so a session's fourth press and every press after it
 * degrade to quiet context permanently, with nothing anywhere saying why.
 *
 * The fold belongs here rather than beside the entry extractor because it folds
 * this command's own records: where the command exists, the browser can read
 * back what each press became, and where it does not, there are no presses to
 * read.
 * @param ctx - context carrying the command registry and the projection registry.
 */
export function installComponentAction(ctx: Context): void {
  // Keyed by the exact Agent, so a same-session replacement starts with a full
  // budget and a disposed one is collected with its count.
  const spentWakes = new WeakMap<Agent, number>()
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    // Claiming is the point human input actually enters a step; a notice this
    // package queued must not refill the budget it just spent.
    if (message.source.kind === 'user') spentWakes.delete(agent)
  })
  ctx.effect(
    () => ctx.commands.register(componentActionCommand(ctx, spentWakes)),
    `show-component: the /${COMPONENT_ACTION_COMMAND} command`,
  )
  ctx.effect(
    () => ctx.sessionProjections.register(componentActionsProjection()),
    'show-component: the componentActions projection unit',
  )
}
