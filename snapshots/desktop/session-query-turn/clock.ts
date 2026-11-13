/** Deterministic event clocks in this scenario's isolated CLI process; native timers remain live. */
import type { Context } from '@deepseek-ai/cordis'

/** Scenario-local fixture plugin. */
export const name = 'desktop-session-query-clock'

/**
 * Fix the clock before Session creation and restore it when the fixture unloads.
 * @param ctx - owner of the isolated snapshot process fixture.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const original = Date.now
    Date.now = () => Date.parse('2026-01-01T00:00:00.000Z')
    return () => { Date.now = original }
  }, 'desktop session-query clock')
}
