// @vitest-environment jsdom
/**
 * `installTerminologyGuard`'s stylesheet lifecycle: one `<style>` element
 * injected, replaced rather than duplicated on a second install (HMR
 * re-apply), and removed by its own disposer. Each rule is asserted as the
 * literal selector it couples on, since a class-substring or DOM-position
 * coupling has no compile-time signal on the `ui-conversation` side.
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
    expect(css).toContain('[data-phase=\'hero\'] [class*="titleGroup"] > :first-child { font-size: 0 !important; }')
    expect(css).toContain('[data-phase=\'hero\'] [class*="titleGroup"] > :first-child::after')
    expect(css).toContain('工作台小助手')
    expect(css).toContain('[class*="heroWorkspaceRow"]')
  })

  it('hides the composer\'s permission-preset chip, scoped to the seat\'s own row', () => {
    installTerminologyGuard()
    const css = document.getElementById('dsh-server-sidebar-terminology-guard')?.textContent ?? ''
    expect(css).toContain('[data-composer-card] [class*="modes"] [class*="trigger"] { display: none !important; }')
  })

  it('hides what the settings header\'s action row holds and leaves the row seating the close button', () => {
    installTerminologyGuard()
    const css = document.getElementById('dsh-server-sidebar-terminology-guard')?.textContent ?? ''
    expect(css).toContain(
      '[role=\'dialog\'][aria-modal=\'true\'] [class$="_header"] > [class$="_actions"] > * { display: none !important; }',
    )
  })

  it('matches the settings panel as SettingsRoot builds it, and nothing shallower', () => {
    // The rule's own selector, applied to the element tree `SettingsRoot.tsx`
    // renders: the dialog, its content div, the header row, and the action row
    // as that header's direct child, each class named the way tsdown's
    // `[hash]_[local]` naming emits it.
    const selector = '[role=\'dialog\'][aria-modal=\'true\'] [class$="_header"] > [class$="_actions"]'
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true">
        <div class="h1_content">
          <div class="h2_header"><div class="h3_actions"><button>打开配置文件</button></div></div>
          <div class="h4_options"><div class="h5_actions">a section's own actions</div></div>
        </div>
      </div>`
    const matched = [...document.querySelectorAll(selector)]
    expect(matched).toHaveLength(1)
    expect(matched[0]?.className).toBe('h3_actions')
    // A section that happens to name a class `actions` is not this row: it is
    // not the header's direct child, and hiding it would take a real control
    // off a page this rule has no business reaching.
    expect(document.querySelector('.h5_actions')?.matches(selector)).toBe(false)
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
