// @vitest-environment jsdom
/**
 * `installTerminologyGuard`'s stylesheet lifecycle: one `<style>` element
 * injected, replaced rather than duplicated on a second install (HMR
 * re-apply), and removed by its own disposer.
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
