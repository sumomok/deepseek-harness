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
 * What the handler answers with is the delivery, not the grade, and only one
 * delivery earns a sentence: a gesture the agent stopped for that reached the
 * inbox instead of a turn, because a user told "sent to the conversation" while
 * nothing is going to happen until they write again is a user left waiting.
 * Ticking a row is not that gesture — it is the user working, nobody is waiting
 * on a reply to it, and a sentence per tick would be a line of chat per tick —
 * so it is answered with a textless success, which the chat row draws nothing
 * for. That answer is durable either way — it is the `command/done` this
 * command's own fold reads back (`action-state.ts`), so a block that has been
 * pressed keeps saying what became of the press after the seat drawing it has
 * been unmounted and drawn again.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/command
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
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

/**
 * What an action too large to carry is answered with.
 *
 * Every way past a ceiling is the same event from where the person is sitting:
 * too many rows ticked, too many conditions built, or too much typed into one
 * of them. Reached both from the byte ceiling on the whole document and from a
 * declared ceiling inside it, so that a gesture nobody could have known was too
 * big is never reported as one that simply went nowhere.
 */
const ACTION_TOO_LARGE = '内容太多了，少选几项或写短一些再试。'

/**
 * What a gesture that asked for an answer and reached the agent's inbox instead
 * of a turn is answered with.
 *
 * The one delivery a user would otherwise wait on forever: they pressed a
 * button the agent stopped for, the notice is recorded and will be read, and
 * nothing is going to happen until they write again. The other three
 * deliveries need no sentence and carry none — a turn is open, the action
 * declared that nothing should follow it, or the gesture was the user working
 * rather than answering, which is news for the agent's next step and not
 * something its author is waiting on a reply to.
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
  /**
   * Which block's which gesture this is, as the resolved identifiers spell it:
   * the entry the log carries, the node its spec draws, and the action the
   * catalog declares. Two occurrences of one gesture on one block share it,
   * which is what lets the later one replace the earlier one's unclaimed
   * notice instead of queueing beside it.
   */
  readonly key: string
}

/**
 * What one reported action came to.
 *
 * Three outcomes rather than two, because the person who made the gesture is
 * answered with each of them differently: the notice is delivered, or the
 * gesture carried more than the action accepts and doing less would help, or it
 * named nothing on display and nothing they do will change that.
 */
export type ActionResolution =
  /** The accounts to deliver, and the grade to deliver them at. */
  | { readonly kind: 'resolved'; readonly action: ResolvedAction }
  /** A declared ceiling inside the payload was crossed. */
  | { readonly kind: 'too-large' }
  /** The document names nothing this session has on display, or nothing the catalog declares. */
  | { readonly kind: 'unresolved' }

/** The one outcome with nothing to carry, shared by every lookup that misses. */
const UNRESOLVED: ActionResolution = { kind: 'unresolved' }

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
 * @returns what the action came to.
 */
function resolveAction(
  records: readonly ContentSurfaceRecord[],
  action: ComponentAction,
): ActionResolution {
  const record = records.find(one => one.kind === COMPONENT_KIND && one.entryId === action.entryId)
  if (record === undefined) return UNRESOLVED
  // The record is a fold cell that a persisted checkpoint may have seeded, so
  // its declared type is a claim; the spec is re-judged rather than trusted,
  // and that judgement is what gives the node its accepted properties.
  const stored = readComponentSurfaceData(record.data)
  if (stored === undefined) return UNRESOLVED
  const spec = validateComponentSpec(stored.spec)
  if (!spec.ok) return UNRESOLVED
  const component = catalogEntry(action.componentId)
  if (component === undefined) return UNRESOLVED
  const node = spec.spec.nodes.find(one => one.id === action.nodeId)
  if (node === undefined) return UNRESOLVED
  // What keeps a seat from reporting one component's gesture as another's: the
  // named component must be the one that node actually draws.
  if (node.component !== component.id) return UNRESOLVED
  const definition = catalogAction(component, action.actionId)
  if (definition === undefined) return UNRESOLVED
  const verdict = acceptsActionPayload(action.payload, definition.payloadSchema)
  if (verdict === 'too-large') return { kind: 'too-large' }
  if (verdict === 'refused') return UNRESOLVED
  const notice = definition.describe({
    entryId: record.entryId,
    entryTitle: stored.title,
    node,
    component,
    payload: action.payload,
  })
  if (notice === undefined) return UNRESOLVED
  // Built from what the lookups returned rather than from what the document
  // said, so two seats spelling one gesture differently cannot land on two keys.
  const key = JSON.stringify([record.entryId, node.id, definition.id])
  return { kind: 'resolved', action: { notice, report: definition.report, key } }
}

/**
 * Where one delivered action actually landed.
 *
 * Not the grade the catalog declared but what became of it, because the two
 * differ exactly where a user would otherwise be left waiting: a `wake` past
 * the budget, or one on an agent already working, is `queued`, while a
 * `context` notice reaching that same inbox is the delivery its action asked
 * for. The handler turns this into what the person who made the gesture is
 * told, which is a sentence for `queued` alone.
 */
export type ActionDelivery =
  /** The action declared that nothing should follow it; the agent was told nothing. */
  | 'none'
  /** A turn was opened for it and the agent will read it now. */
  | 'opened'
  /** It asked for an answer and got the inbox: nothing follows it until the user writes again. */
  | 'queued'
  /** It is news for the agent's next step, and waits in the inbox as the action asked. */
  | 'context'

/**
 * What the command remembers between two gestures on one agent.
 *
 * Both tables are keyed by the live {@link Agent} object, so a same-session
 * replacement starts clean and a disposed one is collected with what it held;
 * neither survives a restart, which the README records as the wake budget's own
 * limitation and which costs a `context` gesture nothing but one extra notice.
 */
export interface ActionMemory {
  /** Turns each agent's actions have opened since it last claimed human input. */
  readonly spentWakes: WeakMap<Agent, number>
  /** The still-unclaimed `context` notice each gesture last left, by {@link ResolvedAction.key}. */
  readonly pendingContext: WeakMap<Agent, Map<string, MessageId>>
}

/**
 * Build the tables one installation's presses share.
 * @returns the empty tables, which the command and the budget's refill listener both hold.
 */
export function actionMemory(): ActionMemory {
  return { spentWakes: new WeakMap(), pendingContext: new WeakMap() }
}

/**
 * Hand one `context` notice to the agent, replacing the one the same gesture
 * left unclaimed.
 *
 * A tick, an untick and a third tick are one fact about what the user has
 * selected, not three, and the inbox has no ceiling of its own: without this,
 * a user working a table drives an unbounded queue of notices, every one of
 * them stating something the next already corrects. `Inbox.replace` cancels the
 * earlier notice and inserts this one in its place, which the agent log's own
 * accounting reads as work still pending rather than as work dropped unrun.
 *
 * The replacement is attempted only where this gesture left a notice that is
 * still pending: `replace` answers false for one the agent has already claimed
 * or cleared, and a claimed notice is one the model has read, so the new
 * gesture is appended as an ordinary injection instead.
 * @param agent - the agent whose seat reported the action.
 * @param pending - this agent's unclaimed notices, by gesture key.
 * @param key - which block's which gesture this is.
 * @param message - the notice to deliver.
 */
function deliverContext(agent: Agent, pending: Map<string, MessageId>, key: string, message: UserMessage): void {
  const previous = pending.get(key)
  if (previous === undefined || !agent.inbox.replace(previous, message)) agent.inject(message)
  pending.set(key, message.id)
}

/**
 * Deliver one resolved action at the grade it declares.
 *
 * The three grades, and nothing between them. `silent` reaches the agent not at
 * all, so it costs no inbox entry and no budget. `context` waits in the
 * next-step inbox, which a running turn reads without a turn boundary of its
 * own, and supersedes whatever the same gesture left there unclaimed. `wake`
 * opens a turn while the agent is idle and within budget, because an answer the
 * agent stopped for is one it never hears if nothing claims it; past the budget,
 * and on an agent already working, it takes that same inbox — and is reported as
 * `queued` rather than as `context`, because the person who pressed is waiting
 * on an answer that will not come until they write again.
 * @param agent - the agent whose seat reported the action.
 * @param memory - the tables this installation's presses share.
 * @param resolved - the accounts to deliver, the grade to deliver them at, and which gesture they are.
 * @returns where the action landed, which is what the press is answered with.
 */
export function deliverAction(
  agent: Agent,
  memory: ActionMemory,
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
  const spent = memory.spentWakes.get(agent) ?? 0
  if (resolved.report === 'wake' && agent.status === 'idle' && spent < WAKE_BUDGET) {
    memory.spentWakes.set(agent, spent + 1)
    agent.followup(message)
    return 'opened'
  }
  if (resolved.report === 'wake') {
    agent.inject(message)
    return 'queued'
  }
  const pending = memory.pendingContext.get(agent) ?? new Map<string, MessageId>()
  memory.pendingContext.set(agent, pending)
  deliverContext(agent, pending, resolved.key, message)
  return 'context'
}

/**
 * Build the `/component-action` command.
 *
 * The memory is passed in rather than owned here so that the budget's refill
 * listener and the spending site share one table; {@link installComponentAction}
 * is what wires the pair together.
 * @param ctx - context carrying the projection registry the entry is resolved through.
 * @param memory - the wake budget and the unclaimed context notices, per agent.
 * @returns the definition to hand to `ctx.commands.register`.
 */
export function componentActionCommand(ctx: Context, memory: ActionMemory): CommandDefinition {
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
      const records = ctx.sessionProjections.stateOf(session, 'contentSurface')?.records ?? NO_RECORDS
      const resolved = resolveAction(records, action)
      if (resolved.kind === 'too-large') return { kind: 'error', text: ACTION_TOO_LARGE }
      if (resolved.kind === 'unresolved') return { kind: 'error', text: ACTION_NOT_RECORDED }
      // The delivery, not the grade: a gesture the agent stopped for and that
      // only reached the inbox is answered with the sentence saying so, and the
      // block that drew it shows that sentence rather than claiming the
      // conversation already has it. The other three deliveries answer with no
      // sentence at all — a turn is open, nothing was to follow, or the user was
      // working rather than waiting — and a settlement carrying no sentence is
      // the one the chat row draws nothing for, so ticking rows leaves no
      // receipt behind in the conversation.
      const delivery = deliverAction(invocation.agent, memory, resolved.action)
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
  const memory = actionMemory()
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    // Claiming is the point human input actually enters a step; a notice this
    // package queued must not refill the budget it just spent.
    if (message.source.kind === 'user') memory.spentWakes.delete(agent)
  })
  ctx.effect(
    () => ctx.commands.register(componentActionCommand(ctx, memory)),
    `show-component: the /${COMPONENT_ACTION_COMMAND} command`,
  )
  ctx.effect(
    () => ctx.sessionProjections.register(componentActionsProjection()),
    'show-component: the componentActions projection unit',
  )
}
