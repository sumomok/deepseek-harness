/**
 * The table of `show_chart` calls waiting for a browser to say what it painted.
 *
 * One entry per call id, and the id is the tool execution's own `callId`, which
 * is also what the transcript hands the row rendering that call. Settlement is
 * single-shot: the entry is removed before its waiter is resolved, so a second
 * report for the same id, a report for a call that already timed out, and a
 * report for a call this host never ran are all the same answer — nothing was
 * waiting.
 * @module @deepseek-ai/dsh-experimental-vue2-echarts-tool-poc/src/pending
 */

import type { ShowChartReport } from './route.ts'

/** Calls whose tool body is blocked on a browser verdict. */
export class PendingCharts {
  private readonly waiting = new Map<string, (report: ShowChartReport | undefined) => void>()

  /**
   * Wait for one call's report.
   * @param callId - the tool execution's call id.
   * @param timeoutMs - how long a browser has to answer before the call gives up.
   * @param signal - the execution's cancellation; an abort ends the wait like a timeout.
   * @returns the report a browser posted, or `undefined` when none arrived in time.
   */
  async settle(
    callId: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<ShowChartReport | undefined> {
    // One deadline for both ways this wait can end without an answer, so there
    // is a single settlement point rather than a timer racing a listener.
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    try {
      return await new Promise<ShowChartReport | undefined>((resolve) => {
        if (deadline.aborted) {
          resolve(undefined)
          return
        }
        this.waiting.set(callId, resolve)
        deadline.addEventListener('abort', () => { resolve(undefined) }, { once: true })
      })
    } finally {
      this.waiting.delete(callId)
    }
  }

  /**
   * Deliver one browser report to the call waiting for it.
   * @param report - the posted report.
   * @returns whether a waiting call took it.
   */
  report(report: ShowChartReport): boolean {
    const resolve = this.waiting.get(report.callId)
    if (resolve === undefined) return false
    this.waiting.delete(report.callId)
    resolve(report)
    return true
  }
}
