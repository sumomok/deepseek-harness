/**
 * The boot page as a browser runs it: the document `bootPage` returns is
 * decoded and loaded into jsdom with its script, and the cases read what it
 * shows.
 * @module
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { bootPage } from '../src/boot-page.ts'
import { PRODUCT_NAME } from '../src/brand.ts'

vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: false } }))

/**
 * Load one boot page into jsdom, running its script.
 * @param url - the `data:` URL `bootPage` returned.
 * @returns the loaded document.
 */
function render(url: string): Document {
  const prefix = 'data:text/html;charset=utf-8,'
  expect(url.startsWith(prefix)).toBe(true)
  return new JSDOM(decodeURIComponent(url.slice(prefix.length)), { runScripts: 'dangerously' }).window.document
}

/** The phase row a document shows, by its index, or -1. */
function showingPhase(document: Document): number {
  const rows = [...document.querySelectorAll('.phase')]
  return rows.findIndex(row => row.classList.contains('showing'))
}

describe('the boot page', () => {
  it('opens on the first phase with no failure', () => {
    const document = render(bootPage('0.1.0-rc.35', 'light', undefined))
    expect(showingPhase(document)).toBe(0)
    expect(document.body.classList.contains('failed')).toBe(false)
  })

  it('opens on a baked failure: the named phase marked failed and the summary under it', () => {
    const summary = '界面没有加载出来:ERR_CONNECTION_REFUSED (-102)'
    const document = render(bootPage('0.1.0-rc.35', 'dark', undefined, { phase: 2, message: summary }))

    expect(showingPhase(document)).toBe(2)
    const row = document.querySelectorAll('.phase')[2]
    expect(row?.classList.contains('failed')).toBe(true)
    expect(row?.querySelector('.mark')?.textContent).toBe('✕')
    expect(document.body.classList.contains('failed')).toBe(true)
    expect(document.getElementById('summary')?.textContent).toBe(summary)
  })

  it('titles the window with the Chinese product name while booting and on a baked failure', () => {
    expect(render(bootPage('0.1.0-rc.36', 'light', undefined)).title).toBe(PRODUCT_NAME.zh)
    expect(render(bootPage('0.1.0-rc.36', 'dark', undefined, { phase: 2, message: 'x' })).title).toBe(PRODUCT_NAME.zh)
  })

  it('shows a summary that contains markup as text, without it closing the script', () => {
    const summary = 'x</script><b id="injected">y</b>'
    const document = render(bootPage('0.1.0-rc.35', 'light', undefined, { phase: 2, message: summary }))

    expect(document.getElementById('summary')?.textContent).toBe(summary)
    expect(document.getElementById('injected')).toBeNull()
  })
})
