/**
 * The approval request every `content_act` call is asked under, and the one
 * deployment choice about who does the asking.
 *
 * A `tools/pre-execute` listener rather than anything the tool declares,
 * because the decision is the deployment's: this one escalates every call of
 * this tool to a request, and the kernel is what turns a request with no
 * approval service behind it into a denial.
 *
 * The request is composed from the arguments and nothing else. Nothing has
 * reached a browser when it is written — no seat has claimed the call, no page
 * has been read — so it names the column's front entry the way the user sees it
 * rather than a page title the host has not got. That is also why `label` is
 * required on every step: the user is told what will be clicked and filled, and
 * the only place those names can come from is the call itself.
 *
 * A deployment that runs a reviewer of its own earlier on the waterfall says so
 * in its row, and this listener then delegates rather than asking a second
 * time. What it never delegates is the dialog clause: `dialogs: 'accept'` is
 * asked here whoever else is on the waterfall, because the request composed
 * here is the mechanism the tool body checks — see
 * [the dialog record](./dialog-approvals.ts).
 * @module @deepseek-ai/dsh-experimental-content-frame/access/act-approval
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { approvalReason, noReviewerRefusal } from './act-text.ts'
import type { DialogApprovals } from './dialog-approvals.ts'
import { CONTENT_ACT_TOOL_NAME, parseActArgs } from './wire.ts'

/**
 * Who decides whether one allowed set of steps reaches a person, resolved from
 * the deployment's row before the listener is registered.
 */
export type ActApproval =
  /** Every allowed call is escalated to a request of this package's own. */
  | { kind: 'always' }
  /**
   * Every allowed call but the one carrying the dialog clause is left to
   * whatever the rest of the waterfall decided, and the deployment's named
   * reviewer must be mounted for any of them to run.
   */
  | { kind: 'judged'; judgedBy: string }

/**
 * Whether a plugin under this name is mounted anywhere in this composition.
 *
 * A runtime's name is the display name its first registered shape carried,
 * which for a row the loader mounted is the module's exported `name`
 * (`vendor/cordis/src/registry.ts`, `RegistryService.plugin`); the record is
 * dropped as the last fiber of that plugin disposes
 * (`vendor/cordis/src/fiber.ts`), so a record found here has a live fiber
 * behind it.
 * @param ctx - any context of this composition; one registry serves the root.
 * @param pluginName - the cordis plugin name the deployment named.
 * @returns whether a plugin of that name is mounted right now.
 */
function isMounted(ctx: Context, pluginName: string): boolean {
  for (const runtime of ctx.registry.values()) {
    if (runtime.name === pluginName) return true
  }
  return false
}

/**
 * Ask before every set of steps runs — or leave that to the deployment's own
 * reviewer — and record the calls whose request said a native dialog would be
 * confirmed.
 * @param ctx - the plugin context the listener is registered on; disposing it drops the listener.
 * @param approvals - the record the tool body checks before it answers a native dialog.
 * @param maxSteps - the deployment's bound on how many steps one call has, which
 * this reads for the same reason the body does: a call past it is refused
 * either way, and asking about it first is asking about nothing.
 * @param actApproval - who decides, as the row resolved it.
 */
export function registerActApproval(
  ctx: Context,
  approvals: DialogApprovals,
  maxSteps: number,
  actApproval: ActApproval,
): void {
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.name !== CONTENT_ACT_TOOL_NAME) return await next()
    const args = parseActArgs(exec.arguments)
    // The tool's own body refuses arguments this cannot read and calls with more
    // steps than the deployment allows, each with a sentence naming what to fix;
    // asking the user about them first would put a request in front of them for
    // a call that cannot run either way — and would put the wrong sentence in
    // front of a model whose call was refused for its size.
    if (args === undefined || args.steps.length > maxSteps) return await next()
    // Checked per call rather than at load, because nothing fixes the order in
    // which this row and the reviewer's row mount: a row loading first would
    // find an absent reviewer that arrives a moment later. The refusal is
    // returned without delegating, because a reviewer that judges this call
    // registers ahead of this listener rather than behind it: nothing `next()`
    // can still reach could supply what is missing, and every listener it does
    // reach would be deciding a call that is refused either way.
    if (actApproval.kind === 'judged' && !isMounted(ctx, actApproval.judgedBy)) {
      return { kind: 'deny', reason: noReviewerRefusal(actApproval.judgedBy) }
    }
    // Delegated first so a listener that would deny the call — a policy, a
    // hook, a guard — still can; only an allowance is escalated to a request.
    const downstream = await next()
    if (downstream.kind === 'deny') return downstream
    // The dialog clause is this package's own to ask whatever else is on the
    // waterfall: the body answers a native dialog only for a call the record
    // holds, and only the request composed here writes that record.
    if (actApproval.kind === 'judged' && args.dialogs !== 'accept') return downstream
    if (args.dialogs === 'accept') approvals.ask(exec.callId)
    return { kind: 'ask', reason: approvalReason(args) }
  })
}
