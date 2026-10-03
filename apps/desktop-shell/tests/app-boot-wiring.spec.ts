/**
 * Where main.ts installs the loading-page restatement: in `createBootWindow`,
 * which creates every app window. The restatement itself is covered by
 * `app-boot-text.client.spec.ts`, which needs a DOM this file does not.
 * @module
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('the app window in main.ts', () => {
  it('restates the loading page in the settings language, else the system one, on every window it creates', () => {
    const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    const create = source.indexOf('function createBootWindow(')
    const restate = source.indexOf('restateAppBootPage(window.webContents, () => appBootCss(storedLanguagePreference(resolveHarnessHome()) ?? shellLanguage()))')
    expect(create).toBeGreaterThan(-1)
    expect(restate).toBeGreaterThan(create)
    expect(restate).toBeLessThan(source.indexOf('\n}\n', create))
  })
})
