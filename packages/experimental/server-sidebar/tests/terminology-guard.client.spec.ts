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
import { installTerminologyGuard } from '../src/client/terminology-guard.ts'

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
    for (const kind of ['system-prompt', 'turn-process', 'tool-call', 'command', 'manual-compaction', 'compaction']) {
      expect(css).toContain(`[data-chat-flow-kind="${kind}"] { display: none !important; }`)
    }
    // Reasoning is not a kind of its own: it renders inside the kept
    // `assistant-step` seat, so its rule keys on `ReasoningRow`'s attribute.
    expect(css).toContain('[data-variant="think"] { display: none !important; }')
  })

  it('hides the reply footer\'s action row and leaves the produced-files tail beside it', () => {
    installTerminologyGuard()
    const css = document.getElementById('dsh-server-sidebar-terminology-guard')?.textContent ?? ''
    expect(css).toContain('[data-turn-tail] > [class*="actions"] { display: none !important; }')
    // The direct-child combinator is the half that spares the tail: the
    // deliverables chain renders as `[data-turn-tail]`'s other child.
    expect(css).not.toContain('[data-turn-tail] [class*="actions"]')
  })

  it('swaps the composer placeholder copy for both composer states', () => {
    installTerminologyGuard()
    const css = document.getElementById('dsh-server-sidebar-terminology-guard')?.textContent ?? ''
    expect(css).toContain('[data-composer-placeholder] { font-size: 0 !important; }')
    expect(css).toContain('[data-composer-placeholder]::after')
    expect(css).toContain('说说要做什么')
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
