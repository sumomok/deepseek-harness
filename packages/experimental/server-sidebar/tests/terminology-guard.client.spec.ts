// @vitest-environment jsdom
/**
 * `installTerminologyGuard`'s stylesheet lifecycle: one `<style>` element
 * injected, replaced rather than duplicated on a second install (HMR
 * re-apply), and removed by its own disposer. Each rule is asserted as the
 * literal selector it couples on, since none of the couplings has a
 * compile-time signal on the owning side: a class substring and a DOM position
 * for `ui-conversation`, and a Chat Node kind string for `ui-chat`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatNodeKind } from '@deepseek-ai/dsh-client-ui-chat/client'
// Empty type imports: each carries that package's own `ChatNodeDataMap` merge
// into this program, so `ChatNodeKind` below is the union this console
// actually composes rather than ui-chat's own members alone. A package the
// console gains must be added here, which is what makes the exhaustiveness
// check answer for the whole composition.
import type {} from '@deepseek-ai/dsh-client-ui-workflow-run/client'
import type {} from '@deepseek-ai/dsh-client-ui-goal/client'
import { installTerminologyGuard } from '../src/client/terminology-guard.ts'

/** Every Chat Node kind this stylesheet hides outright, by `data-chat-flow-kind`. */
const HIDDEN_KINDS = [
  'system-prompt', 'turn-process', 'tool-call', 'command', 'manual-compaction',
  'compaction', 'context', 'model-retry', 'command-input', 'workflow-run', 'unknown',
] as const satisfies readonly ChatNodeKind[]

/**
 * Every Chat Node kind the console keeps on screen. `turn-tail` is kept as a
 * row; the footer rule below takes two controls inside it.
 */
const KEPT_KINDS = [
  'user', 'steering', 'assistant-step', 'turn-error', 'turn-max-tokens', 'turn-tail',
] as const satisfies readonly ChatNodeKind[]

/**
 * Compile-time exhaustiveness over `ChatNodeDataMap`
 * (`packages/client/ui-chat/src/client/contract/chat-nodes.ts:16-19`), which is
 * merge-extensible: a kind added by any composed package, and left out of both
 * lists above, resolves to that kind's own string literal here and fails to
 * assign, so a new flow row cannot reach a customer unreviewed.
 */
type UnaccountedKind = Exclude<ChatNodeKind, (typeof HIDDEN_KINDS)[number] | (typeof KEPT_KINDS)[number]>
const UNACCOUNTED: UnaccountedKind extends never ? true : UnaccountedKind = true

afterEach(() => {
  document.getElementById('dsh-server-sidebar-terminology-guard')?.remove()
})

describe('installTerminologyGuard', () => {
  it('injects a style element hiding the stats row', () => {
    installTerminologyGuard()
    const style = document.getElementById('dsh-server-sidebar-terminology-guard')
    expect(style).not.toBeNull()
    expect(style?.textContent).toContain('[data-composer-card] + *')
  })

  it('also hides the hero fish mark, preview badge, and workspace row, and swaps in the brand headline', () => {
    installTerminologyGuard()
    const css = document.getElementById('dsh-server-sidebar-terminology-guard')?.textContent ?? ''
    expect(css).toContain('[data-phase=\'hero\'] [class*="fishHitbox"]')
    expect(css).toContain('[data-phase=\'hero\'] [class*="previewBadge"]')
    expect(css).toContain('[data-phase=\'hero\'] [class*="headlineText"] { font-size: 0 !important; }')
    expect(css).toContain('[data-phase=\'hero\'] [class*="headlineText"]::after')
    expect(css).toContain('工作台小助手')
    expect(css).toContain('[class*="heroWorkspaceRow"]')
  })

  it('hides the composer\'s permission-preset chip, scoped to the seat\'s own row', () => {
    installTerminologyGuard()
    const css = document.getElementById('dsh-server-sidebar-terminology-guard')?.textContent ?? ''
    expect(css).toContain('[data-composer-card] [class*="modes"] [class*="trigger"] { display: none !important; }')
  })

  it('hides every process row the conversation column carries, by Chat Node kind', () => {
    installTerminologyGuard()
    const css = document.getElementById('dsh-server-sidebar-terminology-guard')?.textContent ?? ''
    for (const kind of HIDDEN_KINDS) {
      expect(css).toContain(`[data-chat-flow-kind="${kind}"] { display: none !important; }`)
    }
    // Every kind is in exactly one list, and the kept ones carry no rule of
    // their own. The compile-time half is `UNACCOUNTED` above.
    expect(UNACCOUNTED).toBe(true)
    for (const kind of KEPT_KINDS) {
      expect(css).not.toContain(`[data-chat-flow-kind="${kind}"] { display: none !important; }`)
    }
    expect(new Set([...HIDDEN_KINDS, ...KEPT_KINDS]).size).toBe(HIDDEN_KINDS.length + KEPT_KINDS.length)
    // Reasoning is not a kind of its own: it renders inside the kept
    // `assistant-step` seat, so its rule keys on `ReasoningRow`'s attribute.
    expect(css).toContain('[data-variant="think"] { display: none !important; }')
  })

  it('hides the reply footer\'s two metric pills and nothing else in that row', () => {
    installTerminologyGuard()
    const css = document.getElementById('dsh-server-sidebar-terminology-guard')?.textContent ?? ''
    // `:has(> …)` selects each pill's own wrapper span through the button's
    // class, so the pill leaves no flex slot behind; the `trigger` substring
    // is `TurnUsagePanel.module.css`'s own local name.
    expect(css).toContain('[data-turn-tail] :has(> [class*="trigger"]) { display: none !important; }')
    // The row itself, the deliverables tail beside it, and every control that
    // is not a metric pill stay: no rule may take the actions row wholesale.
    expect(css).not.toContain('[data-turn-tail] > [class*="actions"]')
    expect(css).not.toContain('[data-turn-tail] [class*="actions"]')
  })

  it('swaps the composer placeholder copy only where the composer accepts input', () => {
    installTerminologyGuard()
    const css = document.getElementById('dsh-server-sidebar-terminology-guard')?.textContent ?? ''
    const scope = '[data-composer-input]:not([data-phase=\'inert\']):not([aria-disabled]) + [data-composer-placeholder]'
    expect(css).toContain(`${scope} {`)
    expect(css).toContain(`${scope}::after`)
    expect(css).toContain('说说要做什么')
    // The inert composer's own diagnostic ("Choose a workspace to start")
    // shares this element and is not an invitation to type — an unscoped rule
    // would paint over it.
    expect(css).not.toContain('\n[data-composer-placeholder]')
  })

  it('replaces the refusing composer\'s session vocabulary without inviting input', () => {
    installTerminologyGuard()
    const css = document.getElementById('dsh-server-sidebar-terminology-guard')?.textContent ?? ''
    const refusing = '[data-composer-input][aria-disabled] + [data-composer-placeholder]'
    expect(css).toContain(`${refusing} { font-size: 0 !important; }`)
    expect(css).toContain(`${refusing}::after`)
    // `placeholder.unavailable` is 会话不可用 / "Session unavailable" and
    // `placeholder.parentOffline` names a 父会话 — banned vocabulary in a
    // namespace no plugin may register into, so the swap is the only reach.
    expect(css).toContain('暂时无法输入')
    // The two placeholder rules partition the states rather than overlap: the
    // invitation excludes exactly what this one selects.
    expect(css).toContain(':not([aria-disabled]) + [data-composer-placeholder]')
  })

  it('re-texts the running indicator and drops its brand gradient, without touching its clock', () => {
    installTerminologyGuard()
    const css = document.getElementById('dsh-server-sidebar-terminology-guard')?.textContent ?? ''
    // `TurnStatus` is a direct child of the flow column, not a `ChatNodeSeat`
    // wrapper, so no `data-chat-flow-kind` rule reaches it; the combinator
    // also keeps the nested `turnStatusClock` span out of the match.
    expect(css).toContain('[data-chat-flow] > [class*="turnStatus"] {')
    expect(css).toContain('[data-chat-flow] > [class*="turnStatus"]::after')
    expect(css).toContain('正在处理…')
    expect(css).toContain('-webkit-text-fill-color: var(--dsw-alias-label-primary) !important;')
    expect(css).not.toContain('深度求索')
  })

  it('replaces rather than duplicates an existing stylesheet', () => {
    installTerminologyGuard()
    installTerminologyGuard()
    expect(document.querySelectorAll('#dsh-server-sidebar-terminology-guard')).toHaveLength(1)
  })

  it('removes the stylesheet through the returned disposer', () => {
    const dispose = installTerminologyGuard()
    dispose()
    expect(document.getElementById('dsh-server-sidebar-terminology-guard')).toBeNull()
  })
})
