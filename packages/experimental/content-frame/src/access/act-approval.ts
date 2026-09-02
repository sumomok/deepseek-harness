/**
 * The approval request every `content_act` call is asked under.
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
 * @module @deepseek-ai/dsh-experimental-content-frame/access/act-approval
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { approvalReason } from './act-text.ts'
import type { DialogApprovals } from './dialog-approvals.ts'
import { CONTENT_ACT_TOOL_NAME, parseActArgs } from './wire.ts'

/**
 * Ask before every set of steps runs, and record the calls whose request said a
 * native dialog would be confirmed.
 * @param ctx - the plugin context the listener is registered on; disposing it drops the listener.
 * @param approvals - the record the tool body checks before it answers a native dialog.
 */
export function registerActApproval(ctx: Context, approvals: DialogApprovals): void {
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.name !== CONTENT_ACT_TOOL_NAME) return await next()
    const args = parseActArgs(exec.arguments)
    // The tool's own body refuses arguments this cannot read, with a sentence
    // naming the step to fix; asking the user about them first would put a
    // request in front of them for a call that cannot run either way.
    if (args === undefined) return await next()
    // Delegated first so a listener that would deny the call — a policy, a
    // hook, a guard — still can; only an allowance is escalated to a request.
    const downstream = await next()
    if (downstream.kind === 'deny') return downstream
    if (args.dialogs === 'accept') approvals.ask(exec.callId)
    return { kind: 'ask', reason: approvalReason(args) }
  })
}
