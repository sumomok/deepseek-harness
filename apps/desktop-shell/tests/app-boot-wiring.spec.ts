/**
 * What `createBootWindow` in main.ts, which creates every app window, gives
 * each window: the loading-page restatement and `acceptFirstMouse`. The
 * restatement itself is covered by `app-boot-text.client.spec.ts`, which needs
 * a DOM this file does not.
 * @module
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('the app window in main.ts', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  const create = source.indexOf('function createBootWindow(')

  it('restates the loading page in the settings language, else the system one, on every window it creates', () => {
    const restate = source.indexOf('restateAppBootPage(window.webContents, () => appBootCss(storedLanguagePreference(resolveHarnessHome()) ?? shellLanguage()))')
    expect(create).toBeGreaterThan(-1)
    expect(restate).toBeGreaterThan(create)
    expect(restate).toBeLessThan(source.indexOf('\n}\n', create))
  })

  it('lets the click that activates the window on macOS reach the page', () => {
    expect(create).toBeGreaterThan(-1)
    const open = source.indexOf('new BrowserWindow({\n', create)
    const close = source.indexOf('\n  })\n', open)
    expect(open).toBeGreaterThan(create)
    expect(close).toBeGreaterThan(open)
    expect(close).toBeLessThan(source.indexOf('\n}\n', create))
    expect(source.slice(open, close)).toMatch(/^ {4}acceptFirstMouse: true,$/mu)
  })
})
