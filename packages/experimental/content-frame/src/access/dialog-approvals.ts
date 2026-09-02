/**
 * The call ids whose approval request said the page's own confirmation would be
 * confirmed too.
 *
 * `dialogs: 'accept'` is the one argument of `content_act` that changes what
 * the user agreed to: an approval covering "click 删除" does not cover the
 * confirmation box that follows it. The `tools/pre-execute` listener composes
 * the request and records the call here; the tool body refuses to answer a
 * native dialog for a call this has no record of. Every path that reaches the
 * body without the request the user read — a standing allowance, a policy that
 * never asks, a listener that allowed the call earlier in the waterfall — is
 * therefore a path on which the page's dialog is cancelled rather than
 * confirmed.
 *
 * One record is spent by the call that reads it, so it can never cover a second
 * call, and the table forgets its oldest records past {@link ASKED_MEMORY}
 * rather than growing for the life of the process.
 * @module @deepseek-ai/dsh-experimental-content-frame/access/dialog-approvals
 */

/**
 * How many asked-for call ids the table remembers. A call is recorded when the
 * user is asked and spent when its body runs, so the bound only matters where
 * asked calls never execute — a user leaving requests unanswered. Past it the
 * oldest record is dropped and that call, if it is ever approved, cancels the
 * page's dialog instead of confirming it, which is this table's safe answer.
 */
const ASKED_MEMORY = 64

/** The record of which calls were approved with a native dialog named. */
export class DialogApprovals {
  /** Call ids asked with the dialog clause, oldest first. */
  private readonly asked = new Set<string>()

  /**
   * Record that this call's approval request said a native dialog would be confirmed.
   * @param callId - the call being asked about.
   */
  ask(callId: string): void {
    this.asked.add(callId)
    if (this.asked.size <= ASKED_MEMORY) return
    for (const oldest of this.asked.keys()) {
      this.asked.delete(oldest)
      break
    }
  }

  /**
   * Spend this call's record, if it has one.
   * @param callId - the call about to run.
   * @returns whether the user was asked to approve confirming a native dialog.
   */
  confirmed(callId: string): boolean {
    return this.asked.delete(callId)
  }
}
