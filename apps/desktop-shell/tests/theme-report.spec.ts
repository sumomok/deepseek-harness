/**
 * The palette report the app window's page sends to the shell: which payloads
 * are accepted, and how an accepted one moves the window's own background and
 * native chrome. The window stands in for a live one; no Electron process runs.
 * @module
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ themeSource: 'system', writes: [] as string[] }))

vi.mock('electron', () => ({
  nativeTheme: {
    get themeSource(): string { return fixture.themeSource },
    set themeSource(value: string) {
      fixture.themeSource = value
      fixture.writes.push(value)
    },
    shouldUseDarkColors: false,
  },
}))

const { PALETTES, applyThemeReport, isThemeReport } = await import('../src/theme.ts')

/** A window stand-in that records native color updates. */
function fakeWindow(): {
  colors: string[]
  overlays: object[]
  setBackgroundColor: (color: string) => void
  setTitleBarOverlay: (overlay: object) => void
} {
  const colors: string[] = []
  const overlays: object[] = []
  return {
    colors,
    overlays,
    setBackgroundColor: (color: string): void => { colors.push(color) },
    setTitleBarOverlay: (overlay: object): void => { overlays.push(overlay) },
  }
}

beforeEach(() => {
  fixture.themeSource = 'system'
  fixture.writes = []
})

describe('a theme report from the window page', () => {
  it('accepts either palette under either preference source', () => {
    expect(isThemeReport({ source: 'system', scheme: 'light' })).toBe(true)
    expect(isThemeReport({ source: 'system', scheme: 'dark' })).toBe(true)
    expect(isThemeReport({ source: 'light', scheme: 'light' })).toBe(true)
    expect(isThemeReport({ source: 'dark', scheme: 'dark' })).toBe(true)
  })

  it('refuses a payload the shell cannot apply', () => {
    const refused: unknown[] = [
      null, undefined, 'light', 42, [],
      {}, { source: 'system' }, { scheme: 'dark' },
      { source: 'auto', scheme: 'dark' }, { source: 'system', scheme: 'sepia' },
    ]
    for (const value of refused) expect(isThemeReport(value)).toBe(false)
  })

  it('keeps macOS vibrant and moves other native chrome to the page palette', () => {
    const window = fakeWindow()
    const dark = process.platform === 'darwin' ? '#00000000' : PALETTES.dark.background
    const light = process.platform === 'darwin' ? '#00000000' : PALETTES.light.background
    applyThemeReport(window, { source: 'dark', scheme: 'dark' })
    expect(window.colors).toEqual([dark])
    applyThemeReport(window, { source: 'system', scheme: 'light' })
    expect(window.colors).toEqual([dark, light])
    expect(window.overlays).toEqual(process.platform === 'win32' ? [
      { color: PALETTES.dark.background, symbolColor: PALETTES.dark.text, height: 40 },
      { color: PALETTES.light.background, symbolColor: PALETTES.light.text, height: 40 },
    ] : [])
  })

  it('moves the native source with the preference the page follows', () => {
    const window = fakeWindow()
    applyThemeReport(window, { source: 'dark', scheme: 'dark' })
    expect(fixture.themeSource).toBe('dark')
    applyThemeReport(window, { source: 'system', scheme: 'light' })
    expect(fixture.themeSource).toBe('system')
  })

  it('does not reassign a native source that is already in force', () => {
    const window = fakeWindow()
    applyThemeReport(window, { source: 'system', scheme: 'dark' })
    expect(fixture.writes).toEqual([])
  })
})
