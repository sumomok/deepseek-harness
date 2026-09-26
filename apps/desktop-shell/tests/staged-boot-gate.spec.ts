/**
 * What the packaging pipeline accepts from a staged server's boot and from its
 * composed profile.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { loadFailureLines, verifyDesktopLayer } from '../scripts/staged-boot-gate.ts'

describe('loadFailureLines', () => {
  it('accepts a boot whose stderr carries no load report', () => {
    expect(loadFailureLines('')).toEqual([])
    expect(loadFailureLines('dsh web: http://127.0.0.1:50852/?token=abc\nsome plugin log line\n')).toEqual([])
  })

  it('reports a bundle the Loader skipped', () => {
    const line = 'dsh: skipping profile bundle "@deepseek-ai/dsh-desktop-app": Error: Cannot find package'
    expect(loadFailureLines(`first\n${line}\ndsh web: http://127.0.0.1:1/\n`)).toEqual([line])
  })

  it('reports a plugin row the compatibility check disabled', () => {
    const line = 'dsh: disabling profile plugin row "vision-switch": peer @deepseek-ai/dsh 0.2.0 is outside >=0.1.7-rc.1 <0.2.0-0'
    expect(loadFailureLines(line)).toEqual([line])
  })

  it('reports entries that did not activate', () => {
    expect(loadFailureLines('dsh: warning: 2 entries did not activate\r\ntypert-loader: …')).toEqual([
      'dsh: warning: 2 entries did not activate',
    ])
  })
})

/** A dump in the dialect `--dump-config` prints, with the desktop layer's row composed. */
const COMPOSED = `# == @deepseek-ai/dsh-base
- id: plugin-manager
  name: '@deepseek-ai/dsh-plugin-manager'
  disabled: !!js '!ctx.get(''profileContext'')'
# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-desktop-app
- id: session-query-sqlite
  name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: !!js dshHomePath('session-search/desktop.db')
    openAt: first-search
`

describe('verifyDesktopLayer', () => {
  it('accepts the search row the desktop layer opens at the first search', () => {
    expect(() => { verifyDesktopLayer(COMPOSED) }).not.toThrow()
  })

  it('finds the row inside a group', () => {
    const grouped = `- id: outer
  group: true
  config:
    - id: session-query-sqlite
      config:
        openAt: first-search
`
    expect(() => { verifyDesktopLayer(grouped) }).not.toThrow()
  })

  it('refuses the row the layers below the desktop one leave off', () => {
    expect(() => { verifyDesktopLayer(COMPOSED.replace('openAt: first-search', 'openAt: never')) })
      .toThrow(/openAt "never".*dsh-desktop-app did not reach the profile/)
  })

  it('refuses a disabled row', () => {
    expect(() => { verifyDesktopLayer(`${COMPOSED}  disabled: true\n`) }).toThrow(/disabled true/)
  })

  it('refuses a composition without the row', () => {
    expect(() => { verifyDesktopLayer('- id: timer\n') }).toThrow('has no session-query-sqlite row')
  })

  it('refuses output that is not an entry list', () => {
    expect(() => { verifyDesktopLayer('') }).toThrow('printed no entry list')
  })
})
