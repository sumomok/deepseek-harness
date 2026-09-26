/**
 * What the packaging pipeline accepts from a staged server's boot and from its
 * composed profile.
 * @module
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findWithheldDirectories, loadFailureLines, verifyDesktopLayer, WITHHELD_PACKAGES,
} from '../scripts/staged-boot-gate.ts'

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

  it('reports entries that did not activate, with the entries the warning names after it', () => {
    const stderr = [
      'dsh: warning: 2 entries did not activate',
      'account-controller (@deepseek-ai/dsh-api-account-controller): failed to import',
      'typert-loader (@deepseek-ai/dsh-typert-loader): activation failed',
      'unrelated (@x/y): a later line',
    ].join('\r\n')
    expect(loadFailureLines(stderr)).toEqual([
      'dsh: warning: 2 entries did not activate',
      'account-controller (@deepseek-ai/dsh-api-account-controller): failed to import',
      'typert-loader (@deepseek-ai/dsh-typert-loader): activation failed',
    ])
  })

  it('stops at the first line after the warning that names no entry', () => {
    expect(loadFailureLines('dsh: warning: 1 entry did not activate\ntypert-loader: …')).toEqual([
      'dsh: warning: 1 entry did not activate',
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

describe('findWithheldDirectories', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  /**
   * A staged tree holding the given directories and files.
   * @param dirs - directories to create, relative to the root.
   * @param files - files to create, relative to the root.
   * @returns the tree's root.
   */
  function tree(dirs: readonly string[], files: readonly string[] = []): string {
    const root = mkdtempSync(join(tmpdir(), 'staged-boot-gate-'))
    roots.push(root)
    for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true })
    for (const file of files) writeFileSync(join(root, file), '')
    return root
  }

  it('withholds the upstream auto-review bundle', () => {
    expect(WITHHELD_PACKAGES).toContain('@deepseek-ai/dsh-experimental-auto-review')
  })

  it('finds nothing in a tree without the package', async () => {
    const root = tree(['node_modules/@deepseek-ai/dsh-base'])
    expect(await findWithheldDirectories(root, WITHHELD_PACKAGES)).toEqual([])
  })

  it('finds the package where the hoisted deploy puts it', async () => {
    const root = tree(['node_modules/@deepseek-ai/dsh-experimental-auto-review/lib'])
    expect(await findWithheldDirectories(root, WITHHELD_PACKAGES))
      .toEqual(['node_modules/@deepseek-ai/dsh-experimental-auto-review'])
  })

  it('finds a copy nested under another package', async () => {
    const root = tree([
      'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review',
      'node_modules/@deepseek-ai/dsh-base',
    ])
    expect(await findWithheldDirectories(root, WITHHELD_PACKAGES))
      .toEqual(['node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review'])
  })

  it('ignores a file of that name', async () => {
    const root = tree(['node_modules/@deepseek-ai'], ['node_modules/@deepseek-ai/dsh-experimental-auto-review'])
    expect(await findWithheldDirectories(root, WITHHELD_PACKAGES)).toEqual([])
  })
})
