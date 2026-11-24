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

  it('keeps the window background on the palette the page paints, not the launch palette', () => {
    const sync = source.indexOf('  attachThemeSync(window)\n', create)
    expect(sync).toBeGreaterThan(create)
    expect(sync).toBeLessThan(source.indexOf('\n}\n', create))
  })

  it('intercepts BOOT_RELOAD_URL only from data: documents before server-origin checks', () => {
    const end = source.indexOf('\n}\n', create)
    const reloadCheck = source.indexOf("if (target === BOOT_RELOAD_URL && window.webContents.getURL().startsWith('data:'))", create)
    const serverCheck = source.indexOf('!isServerNavigation(target, server.url)', create)
    expect(reloadCheck).toBeGreaterThan(create)
    expect(reloadCheck).toBeLessThan(serverCheck)
    expect(serverCheck).toBeLessThan(end)
  })

  it('passes shutdown awareness to superviseAppLoad and renders reloadable failures in the current appearance', () => {
    const end = source.indexOf('\n}\n', create)
    const slice = source.slice(create, end)
    expect(slice).toContain('isQuitting: () => quitting || sessionEnding')
    expect(slice).toContain('const failure = { phase: 2, message, reloadable: server !== undefined }')
    expect(slice).toContain('bootPage(app.getVersion(), resolveAppearance(), undefined, failure)')
    expect(slice).toContain('showFailure(message)')
  })

  it('marks sessionEnding on OS shutdown, prunes crash dumps before starting Crashpad, and wires reloadWindow', () => {
    const pruneAt = source.indexOf('pruneCrashDumps(crashDumpsDir, KEPT_CRASH_DUMPS)')
    const crashStartAt = source.indexOf('crashReporter.start({ uploadToServer: false, compress: false })')
    const whenReadyAt = source.indexOf('void app.whenReady().then(async () => {')
    expect(pruneAt).toBeGreaterThan(-1)
    expect(crashStartAt).toBeGreaterThan(pruneAt)
    expect(whenReadyAt).toBeGreaterThan(crashStartAt)

    expect(source).toContain('sessionEnding = true')
    expect(source).toContain('sink(`[desktop] electron crash dumps: ${crashDumpsDir}\\n`)')
    expect(source).toContain('reloadWindow: (ignoreCache: boolean) => {')
    expect(source).toContain("if (appLoader !== undefined && focused.webContents.getURL().startsWith('data:'))")

    const updaterSource = readFileSync(new URL('../src/updater.ts', import.meta.url), 'utf8')
    expect(updaterSource).toContain("accelerator: 'CmdOrCtrl+R'")
    expect(updaterSource).toContain("accelerator: 'Shift+CmdOrCtrl+R'")
  })
})
