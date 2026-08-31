// @vitest-environment jsdom
/**
 * `installHiddenCommandRowStyle`'s stylesheet lifecycle: one `<style>`
 * element injected, replaced rather than duplicated on a second install (HMR
 * re-apply), and removed by its own disposer.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { installHiddenCommandRowStyle } from '../src/client/hide-empty-command-row.ts'

const STYLE_ID = 'dsh-content-column-hide-empty-command-row'

afterEach(() => {
  document.getElementById(STYLE_ID)?.remove()
})

describe('installHiddenCommandRowStyle', () => {
  it('injects a style element collapsing the empty command row', () => {
    installHiddenCommandRowStyle()
    const style = document.getElementById(STYLE_ID)
    expect(style).not.toBeNull()
    expect(style?.textContent).toContain('[data-chat-flow-kind="command"]:has([data-slot="conversation.chat.commandview"]:empty)')
  })

  it('replaces rather than duplicates an existing stylesheet', () => {
    installHiddenCommandRowStyle()
    installHiddenCommandRowStyle()
    expect(document.querySelectorAll(`#${STYLE_ID}`)).toHaveLength(1)
  })

  it('removes the stylesheet through the returned disposer', () => {
    const dispose = installHiddenCommandRowStyle()
    dispose()
    expect(document.getElementById(STYLE_ID)).toBeNull()
  })
})
